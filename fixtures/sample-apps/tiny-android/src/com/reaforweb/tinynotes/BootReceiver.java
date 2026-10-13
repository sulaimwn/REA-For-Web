package com.reaforweb.tinynotes;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Starts a sync after the device boots. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) {
            context.startService(new Intent(context, SyncService.class));
        }
    }
}
