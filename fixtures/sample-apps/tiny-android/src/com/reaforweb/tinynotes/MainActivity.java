package com.reaforweb.tinynotes;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

/** Hybrid screen: a WebView page that talks to Java through a JavaScript bridge. */
public class MainActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WebView view = new WebView(this);
        view.getSettings().setJavaScriptEnabled(true);
        view.addJavascriptInterface(new NotesBridge(), "notesBridge");
        view.loadUrl("file:///android_asset/index.html");
        setContentView(view);
        startService(new Intent(this, SyncService.class));
    }

    /** Exposed to the page as window.notesBridge. */
    public final class NotesBridge {
        @JavascriptInterface
        public void save(String title, String body) {
            getContentResolver().insert(NotesProvider.CONTENT_URI, NotesProvider.values(title, body));
        }

        @JavascriptInterface
        public String version() {
            return "1.2.3";
        }
    }
}
