package com.railtrack.app;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
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
    private static final int NOTIFICATION_REQUEST = 7342;
    private static boolean active, gpsStarted, askedBackground, askedBattery, askedLocationOn, askedNotifications;
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
        askedLocationOn = false;
        askedNotifications = false;
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

    /** Back on screen: location or its permission may have been switched on meanwhile. */
    static synchronized void retryGps(Context context) {
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
     * Asks, one at a time, for what tracking needs: location switched on, notifications (the tracking notification
     * is what keeps Android from stopping the app), no battery restriction, and "Allow all the time". Each is asked
     * once when the app is opened and once more when a journey starts, if it is still missing. Called whenever the
     * app comes to the screen, when a journey starts, and after a permission answer, so one question follows the
     * other even when Android answers a request without showing anything. "Allow all the time" can only be asked
     * once ordinary location access has been given, which the first journey asks for.
     */
    static synchronized void prompt(Activity activity) {
        if (activity.isFinishing() || activity.isDestroyed()) return;
        if (!askedLocationOn && !locationOn(activity)) {
            askedLocationOn = true;
            new AlertDialog.Builder(activity)
                .setTitle("Location (GPS) band hai")
                .setMessage("Safar ka log banane ke liye phone ki Location chalu honi chahiye. Abhi chalu karein?")
                .setPositiveButton("Chalu karein", (dialog, which) -> {
                    try {
                        activity.startActivity(new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS));
                    } catch (RuntimeException e) {
                        Log.w(TAG, "Location settings could not be opened", e);
                    }
                })
                .setNegativeButton("Baad mein", (dialog, which) -> prompt(activity))
                .setCancelable(false)
                .show();
            return;
        }
        if (!askedNotifications && !NotificationManagerCompat.from(activity).areNotificationsEnabled()) {
            askedNotifications = true;
            if (Build.VERSION.SDK_INT >= 33 && !granted(activity, Manifest.permission.POST_NOTIFICATIONS)
                && ActivityCompat.shouldShowRequestPermissionRationale(activity, Manifest.permission.POST_NOTIFICATIONS)) {
                // Turned down once: Android will still show its own question.
                ActivityCompat.requestPermissions(activity, new String[] {Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_REQUEST);
                return;
            }
            // Never asked, or turned down for good: Android's question may not appear, so the app's notification
            // settings are opened instead.
            try {
                Intent intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, activity.getPackageName());
                activity.startActivity(intent);
                return;
            } catch (RuntimeException e) {
                Log.w(TAG, "Notification settings could not be opened", e);
            }
        }
        if (!askedBattery && !batteryUnrestricted(activity)) {
            askedBattery = true;
            try {
                activity.startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:" + activity.getPackageName())));
                return;
            } catch (RuntimeException e) {
                Log.w(TAG, "Battery question could not be shown", e);
            }
        }
        if (Build.VERSION.SDK_INT >= 29 && !askedBackground
            && granted(activity, Manifest.permission.ACCESS_FINE_LOCATION)
            && !granted(activity, Manifest.permission.ACCESS_BACKGROUND_LOCATION)) {
            askedBackground = true;
            // Android 11 and later answer this with the screen that offers "Allow all the time", or with nothing at
            // all when the user has turned it down before; the page's settings button covers that case.
            ActivityCompat.requestPermissions(activity, new String[] {Manifest.permission.ACCESS_BACKGROUND_LOCATION}, BACKGROUND_REQUEST);
        }
    }

    private static boolean locationOn(Context context) {
        LocationManager manager = (LocationManager) context.getSystemService(Context.LOCATION_SERVICE);
        if (manager == null) return true;
        if (Build.VERSION.SDK_INT >= 28) return manager.isLocationEnabled();
        try {
            return manager.isProviderEnabled(LocationManager.GPS_PROVIDER);
        } catch (RuntimeException e) {
            return true;
        }
    }

    /** Opens this app's page in the phone's settings, where location and battery are set by hand. */
    static void openSettings(Activity activity) {
        try {
            activity.startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.fromParts("package", activity.getPackageName(), null)));
        } catch (RuntimeException e) {
            Log.w(TAG, "App settings could not be opened", e);
        }
    }

    /** What the page shows the user about background tracking. */
    static synchronized JSObject status(Context context) {
        JSObject result = new JSObject();
        result.put("backgroundLocation", Build.VERSION.SDK_INT < 29 || granted(context, Manifest.permission.ACCESS_BACKGROUND_LOCATION));
        result.put("batteryUnrestricted", batteryUnrestricted(context));
        result.put("notifications", NotificationManagerCompat.from(context).areNotificationsEnabled());
        result.put("gps", gpsStarted);
        result.put("locationOn", locationOn(context));
        try {
            result.put("version", AppUpdate.installedCode(context));
        } catch (PackageManager.NameNotFoundException e) {
            result.put("version", 0);
        }
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
