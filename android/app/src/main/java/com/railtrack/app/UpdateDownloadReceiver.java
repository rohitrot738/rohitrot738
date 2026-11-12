package com.railtrack.app;

import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * The download manager finished a download. The update's APK is checked and moved for the installer; the open app
 * then offers to install it, and with the app out of sight a notification does.
 */
public class UpdateDownloadReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (!DownloadManager.ACTION_DOWNLOAD_COMPLETE.equals(intent.getAction())) return;
        Context app = context.getApplicationContext();
        if (AppUpdate.pendingCode(app, intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1)) <= 0) return;
        PendingResult result = goAsync();
        new Thread(() -> {
            try {
                // A failed download stays remembered; the app clears it and offers the update again when opened.
                if (AppUpdate.downloadState(app) != AppUpdate.DONE || AppUpdate.finish(app) == null) return;
                if (!MainActivity.refreshVisible()) {
                    AppUpdate.notifyUser(app, "Suffer Sathi update ready", "Tap to install.");
                }
            } finally {
                result.finish();
            }
        }, "SathiUpdate").start();
    }
}
