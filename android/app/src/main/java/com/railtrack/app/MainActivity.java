package com.railtrack.app;

import android.Manifest;
import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.os.Build;
import android.location.Location;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.view.ViewGroup;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;
import android.widget.Toast;

import androidx.appcompat.app.AlertDialog;
import androidx.localbroadcastmanager.content.LocalBroadcastManager;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

import java.io.File;
import java.lang.ref.WeakReference;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;

public class MainActivity extends BridgeActivity {
    private static final long CHECK_EVERY_MS = 10 * 60 * 1000L;
    private static WeakReference<MainActivity> visible = new WeakReference<>(null);

    private final ExecutorService updates = Executors.newSingleThreadExecutor();
    private AlertDialog updateDialog;
    private volatile long lastCheck;
    /** The version the user put off; it is not offered again until the app is restarted or a notification is tapped. */
    private volatile long putOff;

    /** The location plugin's own broadcast of each fix; the same action its bridge to the page listens for. */
    private static final String FIX_BROADCAST = "com.equimaps.capacitor_background_geolocation.broadcast";
    /** Keeps every fix of the running journey for the page to read later: with the screen off its script may not run. */
    private final BroadcastReceiver fixReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            Location location = intent.getParcelableExtra("location");
            if (location == null) return;
            FixBuffer.add(location);
            TrackingSession.onFix(context);
        }
    };

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SafarBufferPlugin.class);
        registerPlugin(SafarFilesPlugin.class);
        super.onCreate(savedInstanceState);
        LocalBroadcastManager.getInstance(this).registerReceiver(fixReceiver, new IntentFilter(FIX_BROADCAST));
        keepPageAlive();
        JobScheduler scheduler = (JobScheduler) getSystemService(JOB_SCHEDULER_SERVICE);
        JobInfo job = new JobInfo.Builder(73418, new ComponentName(this, UpdateCheckService.class))
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            .setPeriodic(6 * 60 * 60 * 1000L)
            .setPersisted(true)
            .build();
        try {
            if (scheduler.schedule(job) != JobScheduler.RESULT_SUCCESS) {
                showUpdateError("Could not schedule the update check.", null);
            }
        } catch (SecurityException | IllegalArgumentException | IllegalStateException e) {
            showUpdateError("Could not schedule the update check.", e);
        }
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 734);
        }

    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        // One answer in: ask the next thing background tracking needs, if any.
        TrackingSession.prompt(this);
    }

    /**
     * The page runs in a process of its own (the WebView's renderer). With the screen off Android would be free to end
     * it, as it ends background apps; it is kept as important as the app itself, whose location service is in the
     * foreground. Should it end all the same, Android ends the whole app as well, journey tracking included, unless
     * that is handled: the screen is made again instead, and its new page takes the journey up again, reading the
     * fixes of the time between from the native list.
     */
    private void keepPageAlive() {
        if (getBridge() == null || getBridge().getWebView() == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getBridge().getWebView().setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        }
        getBridge().addWebViewListener(new WebViewListener() {
            @Override
            public void onPageLoaded(WebView webView) {
                releaseWebViewFonts();
            }

            @Override
            public boolean onRenderProcessGone(WebView webView, RenderProcessGoneDetail detail) {
                Log.w(TrackingSession.TAG, "The page's process ended (" + (detail.didCrash() ? "crashed" : "ended by Android")
                    + "); making the screen again");
                // A WebView whose page process ended must not be used again: it is taken off the screen and destroyed
                // at once, so that nothing (a location reaching the page, say) touches it before the screen is made
                // again. Calls to a destroyed WebView are ignored.
                ViewGroup parent = (ViewGroup) webView.getParent();
                if (parent != null) parent.removeView(webView);
                webView.destroy();
                recreate();
                return true;
            }
        });
    }

    /**
     * When its page starts, the WebView fetches a few fonts from Play services' font provider (Google Sans and an emoji
     * font, whatever the page shows) and keeps a stable connection to the provider until what it left over is
     * collected, at times for minutes (seen on the emulator). While that lasts, the app's life is tied to Play services'
     * process: when that process dies (an update, a crash), Android ends this app too, journey tracking included. So a
     * collection is asked for, off the main thread, a few times in the first minute after a page loads; the leftovers'
     * finalizers let go of the provider.
     */
    private void releaseWebViewFonts() {
        Handler main = new Handler(Looper.getMainLooper());
        for (long delay : new long[] {3000L, 8000L, 15000L, 30000L, 60000L}) {
            main.postDelayed(() -> new Thread(() -> {
                Runtime.getRuntime().gc();
                System.runFinalization();
            }, "release-webview-fonts").start(), delay);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
    }

    @Override
    public void onResume() {
        super.onResume();
        visible = new WeakReference<>(this);
        TrackingSession.retryGps(this);
        TrackingSession.prompt(this);
        boolean asked = getIntent() != null && getIntent().getBooleanExtra(AppUpdate.EXTRA_UPDATE, false);
        if (asked) getIntent().removeExtra(AppUpdate.EXTRA_UPDATE);
        refreshUpdate(asked);
    }

    @Override
    public void onPause() {
        if (visible.get() == this) visible = new WeakReference<>(null);
        super.onPause();
    }

    @Override
    public void onDestroy() {
        LocalBroadcastManager.getInstance(this).unregisterReceiver(fixReceiver);
        // Recreated for a configuration change, the screen comes straight back and its page takes the journey up
        // again, keeping the fixes; the GPS listener goes on keeping them meanwhile.
        if (!isChangingConfigurations()) TrackingSession.end(this);
        updates.shutdownNow();
        if (updateDialog != null) updateDialog.dismiss();
        super.onDestroy();
    }

    /** The download receiver's way to the open screen; false when the app is out of sight. */
    static boolean refreshVisible() {
        MainActivity activity = visible.get();
        if (activity == null) return false;
        activity.refreshUpdate(true);
        return true;
    }

    /**
     * Offers the update: a downloaded APK to install, otherwise a newer release to download. [asked] is true when the
     * user or a finished download brought us here, which skips the wait between checks and a version put off earlier.
     */
    private void refreshUpdate(boolean asked) {
        if (AppUpdate.debuggable(this)) return;
        try {
            updates.execute(() -> {
                try {
                    long installed = AppUpdate.installedCode(this);
                    if (AppUpdate.pendingCode(this) > 0) {
                        int state = AppUpdate.downloadState(this);
                        if (state == AppUpdate.RUNNING) return;
                        if (state == AppUpdate.DONE) AppUpdate.finish(this);
                        else AppUpdate.forget(this);
                    }
                    File apk = AppUpdate.readyApk(this, installed);
                    if (apk != null) {
                        long code = UpdateVersions.codeFromApkName(apk.getName());
                        if (asked || code != putOff) runOnUiThread(() -> offerInstall(apk, code));
                        return;
                    }
                    long now = SystemClock.elapsedRealtime();
                    if (!asked && lastCheck != 0 && now - lastCheck < CHECK_EVERY_MS) return;
                    AppUpdate.Release release = AppUpdate.fetch();
                    lastCheck = now;
                    if (release == null || release.apkUrl == null || release.code <= installed) return;
                    if (!asked && release.code == putOff) return;
                    runOnUiThread(() -> offerDownload(release));
                } catch (Exception e) {
                    Log.w(AppUpdate.TAG, "Update check failed", e);
                }
            });
        } catch (RejectedExecutionException e) {
            Log.w(AppUpdate.TAG, "Update check skipped", e);
        }
    }

    private void offerDownload(AppUpdate.Release release) {
        if (!canShowDialog()) return;
        updateDialog = new AlertDialog.Builder(this)
            .setTitle("A new version is out")
            .setMessage("A new version of Suffer Sathi (" + release.code + ") is ready. Download it now?")
            .setPositiveButton("Update", (dialog, which) -> {
                if (AppUpdate.startDownload(this, release)) {
                    Toast.makeText(this, "Download started. You will be asked to install it when it is done.",
                        Toast.LENGTH_LONG).show();
                } else {
                    Toast.makeText(this, "The download could not start. Please try again later.",
                        Toast.LENGTH_LONG).show();
                }
            })
            .setNegativeButton("Later", (dialog, which) -> putOff = release.code)
            .show();
    }

    private void offerInstall(File apk, long code) {
        if (!canShowDialog()) return;
        AppUpdate.cancelNotification(this);
        updateDialog = new AlertDialog.Builder(this)
            .setTitle("Update ready")
            .setMessage("The new version (" + code + ") has downloaded. Install it? Android will ask you to confirm once.")
            .setPositiveButton("Install", (dialog, which) -> {
                putOff = code; // back from the installer without installing: do not ask again at once
                try {
                    AppUpdate.install(this, apk);
                } catch (RuntimeException e) {
                    Log.e(AppUpdate.TAG, "Installer could not open", e);
                    Toast.makeText(this, "The installer could not open.", Toast.LENGTH_LONG).show();
                }
            })
            .setNegativeButton("Later", (dialog, which) -> putOff = code)
            .show();
    }

    private boolean canShowDialog() {
        return !isFinishing() && !isDestroyed() && (updateDialog == null || !updateDialog.isShowing());
    }

    private void showUpdateError(String message, Exception error) {
        Log.e("SathiUpdate", message, error);
        Toast.makeText(this, message, Toast.LENGTH_LONG).show();
    }
}
