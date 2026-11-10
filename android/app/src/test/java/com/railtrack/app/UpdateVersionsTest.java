package com.railtrack.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;
import java.io.IOException;

public class UpdateVersionsTest {
    @Test
    public void parsesPublishedVersion() throws IOException {
        assertEquals(100042, UpdateVersions.parse("versionCode: 100042\n\nDownload the APK."));
    }

    @Test(expected = IOException.class)
    public void rejectsMissingVersion() throws IOException {
        UpdateVersions.parse("No version code here");
    }

    @Test(expected = IOException.class)
    public void rejectsOversizedVersion() throws IOException {
        UpdateVersions.parse("versionCode: 99999999999999999999999");
    }

    @Test
    public void onlyNotifiesForNewUnseenVersions() {
        assertTrue(UpdateVersions.shouldNotify(103, 101, 102));
        assertFalse(UpdateVersions.shouldNotify(101, 101, 0));
        assertFalse(UpdateVersions.shouldNotify(102, 101, 102));
    }

    @Test
    public void namesTheApkOfAVersion() {
        assertEquals("Suffer-Sathi-100042.apk", UpdateVersions.apkName(100042));
        assertEquals(100042, UpdateVersions.codeFromApkName("Suffer-Sathi-100042.apk"));
        assertEquals(0, UpdateVersions.codeFromApkName("Suffer-Sathi-100042.apk.tmp"));
        assertEquals(0, UpdateVersions.codeFromApkName("../Suffer-Sathi-1.apk"));
        assertEquals(0, UpdateVersions.codeFromApkName("Suffer-Sathi-99999999999.apk"));
        assertEquals(0, UpdateVersions.codeFromApkName(null));
    }

    @Test
    public void onlyTrustsThisRepositorysUpdateRelease() {
        String good = "https://github.com/rohitrot738/rohitrot738/releases/download/suffer-sathi-updates/Suffer-Sathi-7.apk";
        assertTrue(UpdateVersions.trustedUrl(good, 7));
        assertFalse(UpdateVersions.trustedUrl(good, 8));
        assertTrue(UpdateVersions.trustedUrl(good.replace("rohitrot738/rohitrot738", "rohitrot738/safar-sathi"), 7));
        assertFalse(UpdateVersions.trustedUrl(good.replace("rohitrot738/rohitrot738", "someone/safar-sathi"), 7));
        assertFalse(UpdateVersions.trustedUrl(good.replace("rohitrot738/rohitrot738", "someone/else"), 7));
        assertFalse(UpdateVersions.trustedUrl("https://example.com/Suffer-Sathi-7.apk", 7));
        assertFalse(UpdateVersions.trustedUrl(null, 7));
    }
}
