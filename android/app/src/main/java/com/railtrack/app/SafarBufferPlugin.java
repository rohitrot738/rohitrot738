package com.railtrack.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** The page's way to the native side of a journey: the fixes it missed (FixBuffer) and background tracking. */
@CapacitorPlugin(name = "SafarBuffer")
public class SafarBufferPlugin extends Plugin {
    /** The fixes later than "after" (a time in milliseconds), oldest first. */
    @PluginMethod
    public void drain(PluginCall call) {
        Double after = call.getDouble("after", 0.0);
        JSObject result = new JSObject();
        result.put("fixes", FixBuffer.after(after == null ? 0.0 : after));
        call.resolve(result);
    }

    /** A journey starts: old fixes are dropped and the native side keeps tracking alive (see TrackingSession). */
    @PluginMethod
    public void begin(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            TrackingSession.begin(getActivity());
            call.resolve();
        });
    }

    /** The journey is over. */
    @PluginMethod
    public void end(PluginCall call) {
        TrackingSession.end(getContext());
        call.resolve();
    }

    /** Opens the app's page in the phone's settings. */
    @PluginMethod
    public void openSettings(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            TrackingSession.openSettings(getActivity());
            call.resolve();
        });
    }

    /** Whether Android will let tracking go on with the screen off, for the page to show. */
    @PluginMethod
    public void status(PluginCall call) {
        call.resolve(TrackingSession.status(getContext()));
    }
}
