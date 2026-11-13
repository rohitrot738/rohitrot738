package com.railtrack.app;

import android.content.ClipData;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;

import androidx.annotation.RequiresApi;
import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * Files the page hands over. Android's WebView has no downloads, so a link to a file (the journey log as CSV) does
 * nothing in the app; the page gives the text to this plugin instead.
 */
@CapacitorPlugin(name = "SafarFiles")
public class SafarFilesPlugin extends Plugin {
    /**
     * Saves {name, text, mimeType} in the phone's Download folder, which needs no permission from Android 10 on, and
     * answers {saved: true, name} with the name Android gave it (it adds a number when the name is taken). Older
     * Android gets the share menu with the file instead, to send it on or keep it: {shared: true, name}.
     */
    @PluginMethod
    public void saveText(PluginCall call) {
        String name = call.getString("name", "export.txt");
        String type = call.getString("mimeType", "text/plain");
        byte[] bytes = call.getString("text", "").getBytes(StandardCharsets.UTF_8);
        try {
            JSObject result = new JSObject();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                result.put("saved", true);
                result.put("name", saveInDownloads(name, type, bytes));
            } else {
                share(name, type, bytes);
                result.put("shared", true);
                result.put("name", name);
            }
            call.resolve(result);
        } catch (IOException | RuntimeException e) {
            call.reject(e.getMessage() != null ? e.getMessage() : e.toString(), e);
        }
    }

    @RequiresApi(Build.VERSION_CODES.Q)
    private String saveInDownloads(String name, String type, byte[] bytes) throws IOException {
        ContentResolver resolver = getContext().getContentResolver();
        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
        values.put(MediaStore.MediaColumns.MIME_TYPE, type);
        values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
        values.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (uri == null) throw new IOException("Android gave no place in the Download folder");
        try (OutputStream out = resolver.openOutputStream(uri)) {
            if (out == null) throw new IOException("Android did not open the file in the Download folder");
            out.write(bytes);
        } catch (IOException | RuntimeException e) {
            resolver.delete(uri, null, null);
            throw e;
        }
        ContentValues done = new ContentValues();
        done.put(MediaStore.MediaColumns.IS_PENDING, 0);
        resolver.update(uri, done, null, null);
        try (Cursor row = resolver.query(uri, new String[] {MediaStore.MediaColumns.DISPLAY_NAME}, null, null, null)) {
            if (row != null && row.moveToFirst() && row.getString(0) != null) return row.getString(0);
        }
        return name;
    }

    private void share(String name, String type, byte[] bytes) throws IOException {
        File folder = new File(getContext().getCacheDir(), "exports");
        if (!folder.isDirectory() && !folder.mkdirs()) throw new IOException("Could not make " + folder);
        File file = new File(folder, name);
        try (FileOutputStream out = new FileOutputStream(file)) {
            out.write(bytes);
        }
        Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file);
        Intent send = new Intent(Intent.ACTION_SEND)
            .setType(type)
            .putExtra(Intent.EXTRA_STREAM, uri)
            .putExtra(Intent.EXTRA_SUBJECT, name)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        send.setClipData(ClipData.newRawUri(name, uri));
        Intent chooser = Intent.createChooser(send, name).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        getActivity().runOnUiThread(() -> getActivity().startActivity(chooser));
    }
}
