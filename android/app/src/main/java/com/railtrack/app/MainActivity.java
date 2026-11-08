package com.railtrack.app;

import android.Manifest;
import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.widget.Toast;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
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

        private void showUpdateError(String message, Exception error) {
            Log.e("SathiUpdate", message, error);
            Toast.makeText(this, message + " App updates link se check karein.", Toast.LENGTH_LONG).show();
        }
    }
}
