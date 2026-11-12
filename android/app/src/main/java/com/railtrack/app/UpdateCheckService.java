package com.railtrack.app;

import android.app.job.JobParameters;
import android.app.job.JobService;
import android.util.Log;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

/** Looks for a newer release every few hours and says so once per version; the app itself installs it. */
public class UpdateCheckService extends JobService {
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private Future<?> pending;

    @Override
    public boolean onStartJob(JobParameters params) {
        pending = executor.submit(() -> {
            boolean retry = false;
            try {
                checkForUpdate();
            } catch (Exception e) {
                Log.e(AppUpdate.TAG, "Update check failed", e);
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
        AppUpdate.Release release = AppUpdate.fetch();
        if (release == null) {
            Log.i(AppUpdate.TAG, "No update release published yet");
            return;
        }
        long notified = AppUpdate.prefs(this).getLong("notified", 0);
        if (!UpdateVersions.shouldNotify(release.code, AppUpdate.installedCode(this), notified)) return;
        if (AppUpdate.notifyUser(this, "A new version of Suffer Sathi is out", "Tap to update.")) {
            AppUpdate.prefs(this).edit().putLong("notified", release.code).apply();
        }
    }
}
