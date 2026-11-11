package com.railtrack.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Lets the page read the fixes it missed while its script was not running (see FixBuffer). */
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

    /** A new journey starts: the fixes of the last one are dropped. */
    @PluginMethod
    public void clear(PluginCall call) {
        FixBuffer.clear();
        call.resolve();
    }
}
