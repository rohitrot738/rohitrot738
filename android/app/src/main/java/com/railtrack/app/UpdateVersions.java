package com.railtrack.app;

import java.io.IOException;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

final class UpdateVersions {
    private static final Pattern VERSION = Pattern.compile("(?m)^versionCode: ([0-9]+)$");
    private static final Pattern APK_NAME = Pattern.compile("^Suffer-Sathi-([0-9]{1,10})\\.apk$");
    /**
     * The repository's names, newest first: it is being renamed from rohitrot738 to safar-sathi, and an installed app
     * must keep updating across the rename. Update APKs are only ever taken from its fixed update release.
     */
    static final String[] REPOSITORIES = {"rohitrot738/safar-sathi", "rohitrot738/rohitrot738"};

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

    /** The release asset that carries version [code], as the build workflow names it. */
    static String apkName(long code) {
        return "Suffer-Sathi-" + code + ".apk";
    }

    /** The version code in an APK file name of ours, or 0 for any other name. */
    static long codeFromApkName(String name) {
        Matcher match = APK_NAME.matcher(name == null ? "" : name);
        if (!match.matches()) return 0;
        long value = Long.parseLong(match.group(1));
        return value > Integer.MAX_VALUE ? 0 : value;
    }

    /** True only for version [code]'s APK in this repository's update release. */
    static boolean trustedUrl(String url, long code) {
        for (String repository : REPOSITORIES) {
            String expected = "https://github.com/" + repository + "/releases/download/suffer-sathi-updates/" + apkName(code);
            if (expected.equals(url)) return true;
        }
        return false;
    }
}
