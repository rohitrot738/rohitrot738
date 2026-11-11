package com.railtrack.app;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.util.Log;

import androidx.core.app.ActivityCompat;
import androidx.core.app.NotificationManagerCompat;

import com.getcapacitor.JSObject;

/**
 * What the app does natively for the length of one journey, so tracking goes on with the screen off:
 * the processor is kept awake, the GPS receiver itself is listened to (the location plugin's combined provider goes
 * quiet when the phone thinks it is still), and the user is asked for the two things Android needs for background
 * location: "Allow all the time", and no battery restriction.
 */
final class TrackingSession {
    private static final String TAG = "SathiTracking";
    private static final int BACKGROUND_REQUEST = 7341;
    private static boolean active, gpsStarted, askedBackground, askedBattery;
    private static PowerManager.WakeLock wakeLock;
    private static final LocationListener gps = new LocationListener() {
        @Override
        public void onLocationChanged(Location location) {
            FixBuffer.add(location);
        }

        @Override
        public void onStatusChanged(String provider, int status, Bundle extras) {}

        @Override
        public void onProviderEnabled(String provider) {}

        @Override
        public void onProviderDisabled(String provider) {}
    };

    private TrackingSession() {}

    static synchronized void begin(Activity activity) {
        Context app = activity.getApplicationContext();
        active = true;
        askedBackground = false;
        askedBattery = false;
        FixBuffer.clear();
        if (wakeLock == null) {
            PowerManager power = (PowerManager) app.getSystemService(Context.POWER_SERVICE);
            if (power != null) {
                wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "SufferSathi:tracking");
                wakeLock.setReferenceCounted(false);
            }
        }
        // Held for the journey; the limit only guards against a journey that is never stopped.
        if (wakeLock != null) wakeLock.acquire(18 * 60 * 60 * 1000L);
        startGps(app);
        prompt(activity);
    }

    static synchronized void end(Context context) {
        active = false;
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (gpsStarted) {
            LocationManager manager = (LocationManager) context.getApplicationContext().getSystemService(Context.LOCATION_SERVICE);
            if (manager != null) manager.removeUpdates(gps);
            gpsStarted = false;
        }
    }

    /** A fix arrived from the location plugin: location permission is there now, so the GPS listener can start. */
    static synchronized void onFix(Context context) {
        if (active && !gpsStarted) startGps(context.getApplicationContext());
    }

    private static void startGps(Context app) {
        if (gpsStarted || !granted(app, Manifest.permission.ACCESS_FINE_LOCATION)) return;
        LocationManager manager = (LocationManager) app.getSystemService(Context.LOCATION_SERVICE);
        if (manager == null) return;
        try {
            if (!manager.isProviderEnabled(LocationManager.GPS_PROVIDER)) return;
            manager.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1000L, 0f, gps, Looper.getMainLooper());
            gpsStarted = true;
        } catch (SecurityException | IllegalArgumentException e) {
            Log.w(TAG, "GPS listener could not start", e);
        }
    }

    /**
     * Asks, once each per journey and one at a time, for what background tracking needs. Called when the journey
     * starts and whenever the app comes back to the screen, so the second question follows the first.
     */
    static synchronized void prompt(Activity activity) {
        if (!active || activity.isFinishing()) return;
        if (Build.VERSION.SDK_INT >= 29 && !askedBackground
            && granted(activity, Manifest.permission.ACCESS_FINE_LOCATION)
            && !granted(activity, Manifest.permission.ACCESS_BACKGROUND_LOCATION)) {
            askedBackground = true;
            // Android 11 and later answer this with the screen that offers "Allow all the time".
            ActivityCompat.requestPermissions(activity, new String[] {Manifest.permission.ACCESS_BACKGROUND_LOCATION}, BACKGROUND_REQUEST);
            return;
        }
        if (!askedBattery && !batteryUnrestricted(activity)) {
            askedBattery = true;
            try {
                activity.startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:" + activity.getPackageName())));
            } catch (RuntimeException e) {
                Log.w(TAG, "Battery question could not be shown", e);
            }
        }
    }

    /** What the page shows the user about background tracking. */
    static synchronized JSObject status(Context context) {
        JSObject result = new JSObject();
        result.put("backgroundLocation", Build.VERSION.SDK_INT < 29 || granted(context, Manifest.permission.ACCESS_BACKGROUND_LOCATION));
        result.put("batteryUnrestricted", batteryUnrestricted(context));
        result.put("notifications", NotificationManagerCompat.from(context).areNotificationsEnabled());
        result.put("gps", gpsStarted);
        result.put("fixes", FixBuffer.size());
        result.put("lastFixTime", FixBuffer.lastTime());
        return result;
    }

    private static boolean batteryUnrestricted(Context context) {
        PowerManager power = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        return power == null || power.isIgnoringBatteryOptimizations(context.getPackageName());
    }

    private static boolean granted(Context context, String permission) {
        return context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
    }
}
