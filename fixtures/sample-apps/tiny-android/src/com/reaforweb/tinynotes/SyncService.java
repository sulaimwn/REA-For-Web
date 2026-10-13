package com.reaforweb.tinynotes;

import android.app.Service;
import android.content.Intent;
import android.os.IBinder;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/** Pushes notes to the sync endpoint. */
public class SyncService extends Service {
    static final String ENDPOINT = "https://api.example.com/notes";

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        new Thread(() -> push("{}")).start();
        return START_NOT_STICKY;
    }

    static void push(String json) {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(ENDPOINT).openConnection();
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            try (OutputStream out = c.getOutputStream()) {
                out.write(json.getBytes("UTF-8"));
            }
            c.getResponseCode();
        } catch (Exception ignored) {
            // Sample app: sync failures are ignored.
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
