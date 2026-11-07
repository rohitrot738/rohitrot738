package com.railtrack.app;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.job.JobParameters;
import android.app.job.JobService;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

public class UpdateCheckService extends JobService {
    private static final String TAG = "SathiUpdate";
    private static final String RELEASE_API =
        "https://api.github.com/repos/rohitrot738/rohitrot738/releases/tags/suffer-sathi-updates";
    private static final String RELEASE_PAGE =
        "https://github.com/rohitrot738/rohitrot738/releases/tag/suffer-sathi-updates";
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private Future<?> pending;

    @Override
    public boolean onStartJob(JobParameters params) {
        pending = executor.submit(() -> {
            boolean retry = false;
            try {
                checkForUpdate();
            } catch (Exception e) {
                Log.e(TAG, "Update check failed", e);
                retry = true;
            } finally {
                jobFinished(params, retry);
            }
        });
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        if (pending != null) pending.cancel(true);
        return true;
    }

    @Override
    public void onDestroy() {
        executor.shutdownNow();
        super.onDestroy();
    }

    private void checkForUpdate() throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(RELEASE_API).openConnection();
        connection.setRequestProperty("Accept", "application/vnd.github+json");
        connection.setRequestProperty("User-Agent", "Suffer-Sathi-Android");
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(15000);
        try {
            int status = connection.getResponseCode();
            if (status == 404) {
                Log.i(TAG, "No update release published yet");
                return;
            }
            if (status != 200) throw new IOException("Update check HTTP " + status);
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            try (InputStream input = connection.getInputStream()) {
                byte[] buffer = new byte[4096];
                int count;
                while ((count = input.read(buffer)) != -1) {
                    if (output.size() + count > 1024 * 1024) throw new IOException("Release response too large");
                    output.write(buffer, 0, count);
                }
            }
            JSONObject release = new JSONObject(new String(output.toByteArray(), StandardCharsets.UTF_8));
            long available = UpdateVersions.parse(release.getString("body"));
            long installed = Build.VERSION.SDK_INT >= 28
                ? getPackageManager().getPackageInfo(getPackageName(), 0).getLongVersionCode()
                : getPackageManager().getPackageInfo(getPackageName(), 0).versionCode;
            if (!UpdateVersions.shouldNotify(available, installed, getPreferences().getLong("notified", 0))) return;
            if (Build.VERSION.SDK_INT >= 33 &&
                checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                Log.w(TAG, "Notification permission is not granted");
                return;
            }
            if (!NotificationManagerCompat.from(this).areNotificationsEnabled()) {
                Log.w(TAG, "Notifications are disabled");
                return;
            }
            NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (Build.VERSION.SDK_INT >= 26) {
                manager.createNotificationChannel(new NotificationChannel(
                    "app_updates", "App updates", NotificationManager.IMPORTANCE_DEFAULT));
            }
            Intent open = new Intent(Intent.ACTION_VIEW, Uri.parse(RELEASE_PAGE));
            PendingIntent action = PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            manager.notify(73418, new NotificationCompat.Builder(this, "app_updates")
                .setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setContentTitle("Suffer Sathi update available")
                .setContentText("Tap to download and install the new version.")
                .setContentIntent(action)
                .setAutoCancel(true)
                .build());
            getPreferences().edit().putLong("notified", available).apply();
        } finally {
            connection.disconnect();
        }
    }

    private android.content.SharedPreferences getPreferences() {
        return getSharedPreferences("app-updates", MODE_PRIVATE);
    }
}
