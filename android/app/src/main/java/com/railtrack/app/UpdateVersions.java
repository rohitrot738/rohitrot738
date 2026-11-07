package com.railtrack.app;

import java.io.IOException;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

final class UpdateVersions {
    private static final Pattern VERSION = Pattern.compile("(?m)^versionCode: ([0-9]+)$");

    static long parse(String body) throws IOException {
        Matcher match = VERSION.matcher(body);
        if (!match.find()) throw new IOException("Release has no version code");
        try {
            long value = Long.parseLong(match.group(1));
            if (value > Integer.MAX_VALUE) throw new IOException("Version code is too large");
            return value;
        } catch (NumberFormatException e) {
            throw new IOException("Invalid version code", e);
        }
    }

    static boolean shouldNotify(long available, long installed, long notified) {
        return available > installed && available > notified;
    }
}
