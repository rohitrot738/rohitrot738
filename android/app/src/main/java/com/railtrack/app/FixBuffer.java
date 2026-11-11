package com.railtrack.app;

import android.location.Location;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;

import org.json.JSONObject;

import java.util.ArrayDeque;

/**
 * The location fixes of the running journey, kept on the native side. The page writes the journey log, but Android may
 * stop running the page's script while the screen is off or the app is minimised; the fixes it missed wait here, each
 * with its own time, and the page reads them when it runs again.
 */
final class FixBuffer {
    /** About eleven hours at one fix a second. */
    private static final int LIMIT = 40000;
    private static final ArrayDeque<double[]> fixes = new ArrayDeque<>();

    private FixBuffer() {}

    static synchronized void add(Location location) {
        if (location == null) return;
        if (fixes.size() >= LIMIT) fixes.removeFirst();
        fixes.addLast(new double[] {
            location.getTime(),
            location.getLatitude(),
            location.getLongitude(),
            location.hasAccuracy() ? location.getAccuracy() : Double.NaN,
            location.hasSpeed() ? location.getSpeed() : Double.NaN
        });
    }

    /** The fixes later than [time], oldest first. */
    static synchronized JSArray after(double time) {
        JSArray result = new JSArray();
        for (double[] fix : fixes) {
            if (fix[0] <= time) continue;
            JSObject item = new JSObject();
            item.put("time", (long) fix[0]);
            item.put("latitude", fix[1]);
            item.put("longitude", fix[2]);
            item.put("accuracy", Double.isNaN(fix[3]) ? JSONObject.NULL : (Object) fix[3]);
            item.put("speed", Double.isNaN(fix[4]) ? JSONObject.NULL : (Object) fix[4]);
            result.put(item);
        }
        return result;
    }

    static synchronized int size() {
        return fixes.size();
    }

    /** The time of the newest fix, or 0 when there is none. */
    static synchronized long lastTime() {
        return fixes.isEmpty() ? 0 : (long) fixes.peekLast()[0];
    }

    static synchronized void clear() {
        fixes.clear();
    }
}
