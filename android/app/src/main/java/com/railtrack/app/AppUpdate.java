package com.railtrack.app;

import android.Manifest;
import android.app.DownloadManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.FileProvider;
import androidx.core.content.pm.PackageInfoCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * In-app updates: finds a newer signed APK in the fixed GitHub update release, downloads it with Android's download
 * manager (which carries on with the app closed), checks that the file is this app at that version, and hands it to
 * the system installer. Android still asks the user to confirm each installation.
 */
final class AppUpdate {
    static final String TAG = "SathiUpdate";
    static final String EXTRA_UPDATE = "com.railtrack.app.UPDATE";
    static final int RUNNING = 1, DONE = 2, FAILED = 3;
    private static final String APK_MIME = "application/vnd.android.package-archive";
    private static final String PREFS = "app-updates";
    private static final String DOWNLOAD_ID = "download_id", DOWNLOAD_CODE = "download_code";
    private static final String CHANNEL = "app_updates";
    private static final int NOTIFICATION = 73418;

    /** The published update; [apkUrl] is null when the release names a version but does not carry its APK. */
    static final class Release {
        final long code;
        final String apkUrl;

        Release(long code, String apkUrl) {
            this.code = code;
            this.apkUrl = apkUrl;
        }
    }

    private AppUpdate() {}

    /** The published update, or null when no update release exists yet. */
    static Release fetch() throws Exception {
        // The first name that answers: before the rename only the old one does, after it both do.
        for (String repository : UpdateVersions.REPOSITORIES) {
            Release release = fetch("https://api.github.com/repos/" + repository + "/releases/tags/suffer-sathi-updates");
            if (release != null) return release;
        }
        return null;
    }

    private static Release fetch(String api) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(api).openConnection();
        connection.setRequestProperty("Accept", "application/vnd.github+json");
        connection.setRequestProperty("User-Agent", "Suffer-Sathi-Android");
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(15000);
        try {
            int status = connection.getResponseCode();
            if (status == 404) return null;
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
            long code = UpdateVersions.parse(release.getString("body"));
            String apkUrl = null;
            JSONArray assets = release.optJSONArray("assets");
            for (int i = 0; assets != null && i < assets.length(); i++) {
                JSONObject asset = assets.optJSONObject(i);
                if (asset == null || !UpdateVersions.apkName(code).equals(asset.optString("name"))) continue;
                String url = asset.optString("browser_download_url");
                if (UpdateVersions.trustedUrl(url, code)) apkUrl = url;
            }
            return new Release(code, apkUrl);
        } finally {
            connection.disconnect();
        }
    }

    static long installedCode(Context context) throws PackageManager.NameNotFoundException {
        return PackageInfoCompat.getLongVersionCode(
            context.getPackageManager().getPackageInfo(context.getPackageName(), 0));
    }

    /** Debug builds carry a different signing key, so a release APK can never install over them. */
    static boolean debuggable(Context context) {
        return (context.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    }

    /** Starts downloading [release] in place of any earlier download; false when Android cannot take it. */
    static boolean startDownload(Context context, Release release) {
        if (release.apkUrl == null) return false;
        forget(context);
        File folder = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        if (folder == null) return false;
        String name = UpdateVersions.apkName(release.code);
        new File(folder, name).delete();
        try {
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(release.apkUrl))
                .setTitle("Suffer Sathi update")
                .setDescription("Downloading the new version")
                .setMimeType(APK_MIME)
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE)
                .setAllowedOverMetered(true)
                .setDestinationInExternalFilesDir(context, Environment.DIRECTORY_DOWNLOADS, name)
                .addRequestHeader("User-Agent", "Suffer-Sathi-Android");
            long id = manager(context).enqueue(request);
            prefs(context).edit().putLong(DOWNLOAD_ID, id).putLong(DOWNLOAD_CODE, release.code).apply();
            return true;
        } catch (RuntimeException e) {
            Log.e(TAG, "Update download could not start", e);
            return false;
        }
    }

    /** The version code of the download under way or finished, or 0 when none is remembered. */
    static long pendingCode(Context context) {
        SharedPreferences prefs = prefs(context);
        return prefs.getLong(DOWNLOAD_ID, -1) < 0 ? 0 : prefs.getLong(DOWNLOAD_CODE, 0);
    }

    /** The version code of download [id] when it is the update's, otherwise 0. */
    static long pendingCode(Context context, long id) {
        return id >= 0 && prefs(context).getLong(DOWNLOAD_ID, -1) == id ? pendingCode(context) : 0;
    }

    /** How the remembered download stands: RUNNING, DONE or FAILED. */
    static int downloadState(Context context) {
        long id = prefs(context).getLong(DOWNLOAD_ID, -1);
        if (id < 0) return FAILED;
        try (Cursor cursor = manager(context).query(new DownloadManager.Query().setFilterById(id))) {
            // Gone from the download manager: the user removed it from the Downloads app.
            if (cursor == null || !cursor.moveToFirst()) return FAILED;
            int status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
            if (status == DownloadManager.STATUS_SUCCESSFUL) return DONE;
            return status == DownloadManager.STATUS_FAILED ? FAILED : RUNNING;
        } catch (RuntimeException e) {
            Log.e(TAG, "Update download state unknown", e);
            return FAILED;
        }
    }

    /**
     * Moves the finished download into the folder the installer is handed files from, when it checks out as this
     * app at the expected version; null (and the file dropped) when it does not. The download is forgotten either way.
     */
    static synchronized File finish(Context context) {
        long code = pendingCode(context);
        try {
            if (code <= 0) return null;
            File folder = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
            File downloaded = folder == null ? null : new File(folder, UpdateVersions.apkName(code));
            if (downloaded == null || !downloaded.isFile() || !isApkOf(context, downloaded, code)) {
                Log.e(TAG, "Downloaded update did not check out");
                return null;
            }
            File target = new File(readyFolder(context), UpdateVersions.apkName(code));
            target.getParentFile().mkdirs();
            try (InputStream input = new FileInputStream(downloaded); OutputStream output = new FileOutputStream(target)) {
                byte[] buffer = new byte[65536];
                int count;
                while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
            } catch (IOException e) {
                target.delete();
                Log.e(TAG, "Update could not be prepared", e);
                return null;
            }
            return target;
        } finally {
            forget(context);
        }
    }

    /** The newest checked APK waiting for the installer that is newer than [installed]; older ones are deleted. */
    static synchronized File readyApk(Context context, long installed) {
        File[] files = readyFolder(context).listFiles();
        File best = null;
        long bestCode = installed;
        for (File file : files == null ? new File[0] : files) {
            long code = UpdateVersions.codeFromApkName(file.getName());
            if (code > bestCode && isApkOf(context, file, code)) {
                if (best != null) best.delete();
                best = file;
                bestCode = code;
            } else {
                file.delete();
            }
        }
        return best;
    }

    /** Hands [apk] to the system installer, which asks the user to confirm. */
    static void install(Context context, File apk) {
        Uri uri = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", apk);
        context.startActivity(new Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, APK_MIME)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK));
    }

    /** Drops the remembered download and its file. */
    static void forget(Context context) {
        long id = prefs(context).getLong(DOWNLOAD_ID, -1);
        if (id >= 0) {
            try {
                manager(context).remove(id);
            } catch (RuntimeException e) {
                Log.w(TAG, "Update download could not be removed", e);
            }
        }
        prefs(context).edit().remove(DOWNLOAD_ID).remove(DOWNLOAD_CODE).apply();
    }

    /** A notification that opens the app on its update prompt; false when notifications are off. */
    static boolean notifyUser(Context context, String title, String text) {
        if (Build.VERSION.SDK_INT >= 33
            && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            Log.w(TAG, "Notification permission is not granted");
            return false;
        }
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) {
            Log.w(TAG, "Notifications are disabled");
            return false;
        }
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) {
            manager.createNotificationChannel(
                new NotificationChannel(CHANNEL, "App updates", NotificationManager.IMPORTANCE_DEFAULT));
        }
        Intent open = new Intent(context, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(EXTRA_UPDATE, true);
        PendingIntent action = PendingIntent.getActivity(context, 0, open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        manager.notify(NOTIFICATION, new NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(action)
            .setAutoCancel(true)
            .build());
        return true;
    }

    static void cancelNotification(Context context) {
        NotificationManagerCompat.from(context).cancel(NOTIFICATION);
    }

    static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static boolean isApkOf(Context context, File apk, long code) {
        PackageInfo info = context.getPackageManager().getPackageArchiveInfo(apk.getPath(), 0);
        return info != null && context.getPackageName().equals(info.packageName)
            && PackageInfoCompat.getLongVersionCode(info) == code;
    }

    private static File readyFolder(Context context) {
        return new File(context.getCacheDir(), "updates");
    }

    private static DownloadManager manager(Context context) {
        return (DownloadManager) context.getSystemService(Context.DOWNLOAD_SERVICE);
    }
}
