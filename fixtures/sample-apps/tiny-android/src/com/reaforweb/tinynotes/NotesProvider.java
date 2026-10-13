package com.reaforweb.tinynotes;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.net.Uri;

/** Stores notes in a local SQLite database. */
public class NotesProvider extends ContentProvider {
    static final Uri CONTENT_URI = Uri.parse("content://com.reaforweb.tinynotes.notes/notes");
    private SQLiteDatabase db;

    static ContentValues values(String title, String body) {
        ContentValues v = new ContentValues();
        v.put("title", title);
        v.put("body", body);
        return v;
    }

    @Override
    public boolean onCreate() {
        db = getContext().openOrCreateDatabase("notes.db", 0, null);
        db.execSQL("CREATE TABLE IF NOT EXISTS notes (title TEXT, body TEXT)");
        return true;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        db.insert("notes", null, values);
        return uri;
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] args, String sort) {
        return db.query("notes", projection, selection, args, null, null, sort);
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] args) {
        return db.update("notes", values, selection, args);
    }

    @Override
    public int delete(Uri uri, String selection, String[] args) {
        return db.delete("notes", selection, args);
    }

    @Override
    public String getType(Uri uri) {
        return "vnd.android.cursor.dir/vnd.reaforweb.note";
    }
}
