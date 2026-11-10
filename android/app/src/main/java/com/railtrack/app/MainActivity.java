package com.railtrack.app;

import android.Manifest;
import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.util.Log;
import android.widget.Toast;

import androidx.appcompat.app.AlertDialog;

import com.getcapacitor.BridgeActivity;

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

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        JobScheduler scheduler = (JobScheduler) getSystemService(JOB_SCHEDULER_SERVICE);
        JobInfo job = new JobInfo.Builder(73418, new ComponentName(this, UpdateCheckService.class))
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            .setPeriodic(6 * 60 * 60 * 1000L)
            .setPersisted(true)
            .build();
        try {
            if (scheduler.schedule(job) != JobScheduler.RESULT_SUCCESS) {
                showUpdateError("Update check schedule nahi ho saka.", null);
            }
        } catch (SecurityException | IllegalArgumentException | IllegalStateException e) {
            showUpdateError("Update check schedule nahi ho saka.", e);
        }
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 734);
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
            .setTitle("Naya version aaya hai")
            .setMessage("Suffer Sathi ka naya version (" + release.code + ") taiyar hai. Abhi download karein?")
            .setPositiveButton("Update karein", (dialog, which) -> {
                if (AppUpdate.startDownload(this, release)) {
                    Toast.makeText(this, "Download shuru ho gaya. Poora hone par install ka sawaal aayega.",
                        Toast.LENGTH_LONG).show();
                } else {
                    Toast.makeText(this, "Download shuru nahi ho saka. Baad mein dobara koshish karein.",
                        Toast.LENGTH_LONG).show();
                }
            })
            .setNegativeButton("Baad mein", (dialog, which) -> putOff = release.code)
            .show();
    }

    private void offerInstall(File apk, long code) {
        if (!canShowDialog()) return;
        AppUpdate.cancelNotification(this);
        updateDialog = new AlertDialog.Builder(this)
            .setTitle("Update taiyar hai")
            .setMessage("Naya version (" + code + ") download ho gaya. Install karein? Android ek baar pushti maangega.")
            .setPositiveButton("Install karein", (dialog, which) -> {
                putOff = code; // back from the installer without installing: do not ask again at once
                try {
                    AppUpdate.install(this, apk);
                } catch (RuntimeException e) {
                    Log.e(AppUpdate.TAG, "Installer could not open", e);
                    Toast.makeText(this, "Installer nahi khul saka.", Toast.LENGTH_LONG).show();
                }
            })
            .setNegativeButton("Baad mein", (dialog, which) -> putOff = code)
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
