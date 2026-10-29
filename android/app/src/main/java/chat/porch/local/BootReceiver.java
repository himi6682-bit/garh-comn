package chat.porch.local;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

import androidx.core.content.ContextCompat;

/**
 * remoteMessaging is one of the foreground-service types Android 15 and 16
 * still allow a boot receiver to start.
 */
public final class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent == null ? "" : intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action) && !"android.intent.action.QUICKBOOT_POWERON".equals(action)) return;
        SharedPreferences prefs = context.getSharedPreferences("porch", Context.MODE_PRIVATE);
        if (!prefs.getBoolean("start_on_boot", true) || !prefs.getBoolean("hosted_once", false)) return;
        Intent service = new Intent(context, HostService.class);
        service.setAction(HostService.ACTION_START);
        ContextCompat.startForegroundService(context, service);
    }
}
