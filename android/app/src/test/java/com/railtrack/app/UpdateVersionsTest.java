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
}
