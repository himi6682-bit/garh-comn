package chat.porch.local;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import androidx.core.app.NotificationCompat;

import org.json.JSONObject;

import chat.porch.server.Lan;
import chat.porch.server.PorchHost;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.List;

public final class HostService extends Service {
    public static final String ACTION_START = "chat.porch.local.START";
    public static final String ACTION_STOP = "chat.porch.local.STOP";
    public static final int PORT = 8787;
    private static final int NOTIFICATION_ID = 41;
    private static final java.util.Set<String> WEB_ROOT = new java.util.HashSet<String>(java.util.Arrays.asList(
            "css", "js", "icons", "index.html", "sw.js", "manifest.webmanifest", "favicon.svg"));
    private static final String CHANNEL = "porch_host";

    private PorchHost host;
    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    private Thread refresher;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        createChannel();
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopHosting();
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
            return START_NOT_STICKY;
        }
        startInForeground("Starting Garh-Comn…");
        if (host == null) {
            try {
                File dataDir = new File(getFilesDir(), "porch-data");
                File webDir = new File(getFilesDir(), "web");
                dataDir.mkdirs();
                copyWeb(webDir);
                File database = new File(dataDir, "porch.db");
                AndroidSql sql = new AndroidSql(database);
                host = new PorchHost(sql, dataDir, webDir, PORT, 10, 8, 30, true);
                if (!host.logic().anyUser()) {
                    JSONObject config = readConfig(dataDir);
                    String password = config.optString("adminPassword", "");
                    if (password.length() < 8) {
                        host.stop();
                        host = null;
                        notify("Open Garh-Comn and choose a password before hosting.", true);
                        stopSelf();
                        return START_NOT_STICKY;
                    }
                    host.ensureAdmin(
                            config.optString("adminUsername", "admin"),
                            config.optString("adminDisplayName", "Admin"),
                            password);
                }
                host.start();
                writeText(new File(dataDir, "port.txt"), String.valueOf(host.getListeningPort()));
                getSharedPreferences("porch", MODE_PRIVATE).edit().putBoolean("hosted_once", true).apply();
                holdLocks();
                startRefresher();
            } catch (Exception error) {
                notify("Garh-Comn could not start: " + error.getMessage(), true);
                stopHosting();
                stopSelf();
                return START_NOT_STICKY;
            }
        }
        notify(LanProbe.summary(LanProbe.list(this), listeningPort()), false);
        return START_STICKY;
    }

    private int listeningPort() {
        return host == null ? PORT : host.getListeningPort();
    }

    private void startRefresher() {
        refresher = new Thread(() -> {
            while (!Thread.currentThread().isInterrupted() && host != null) {
                List<Lan.Addr> rows = LanProbe.list(HostService.this);
                notify(LanProbe.summary(rows, listeningPort()), false);
                try {
                    Thread.sleep(4000);
                } catch (InterruptedException error) {
                    Thread.currentThread().interrupt();
                }
            }
        }, "porch-addresses");
        refresher.start();
    }

    private void holdLocks() {
        PowerManager power = (PowerManager) getSystemService(POWER_SERVICE);
        wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "porch:host");
        wakeLock.setReferenceCounted(false);
        wakeLock.acquire();
        WifiManager wifi = (WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE);
        if (wifi != null) {
            int mode = Build.VERSION.SDK_INT >= 29
                    ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                    : WifiManager.WIFI_MODE_FULL_HIGH_PERF;
            wifiLock = wifi.createWifiLock(mode, "porch:wifi");
            wifiLock.setReferenceCounted(false);
            wifiLock.acquire();
        }
    }

    private void startInForeground(String text) {
        Notification notification = buildNotification(text, false);
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    private void notify(String text, boolean error) {
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        manager.notify(NOTIFICATION_ID, buildNotification(text, error));
    }

    private Notification buildNotification(String text, boolean error) {
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent content = PendingIntent.getActivity(this, 1, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Intent stop = new Intent(this, HostService.class);
        stop.setAction(ACTION_STOP);
        PendingIntent stopIntent = PendingIntent.getService(this, 2, stop, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_porch)
                .setContentTitle(error ? "Garh-Comn needs attention" : "Garh-Comn is hosting")
                .setContentText(text)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
                .setContentIntent(content)
                .addAction(0, "Stop", stopIntent)
                .setOngoing(!error)
                .setOnlyAlertOnce(true)
                .build();
    }

    private void createChannel() {
        NotificationChannel channel = new NotificationChannel(CHANNEL, getString(R.string.host_channel), NotificationManager.IMPORTANCE_LOW);
        channel.setDescription(getString(R.string.host_channel_desc));
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        manager.createNotificationChannel(channel);
    }

    private JSONObject readConfig(File dataDir) {
        try {
            File file = new File(dataDir, "config.json");
            if (!file.isFile()) return new JSONObject();
            return new JSONObject(readText(file));
        } catch (Exception error) {
            return new JSONObject();
        }
    }

    private void copyWeb(File dest) throws Exception {
        File stamp = new File(dest, ".stamp");
        String version = "7";
        if (stamp.isFile() && version.equals(readText(stamp).trim())) return;
        deleteRecursively(dest);
        dest.mkdirs();
        copyAsset("", dest);
        writeText(stamp, version);
    }

    private void copyAsset(String path, File dest) throws Exception {
        String[] children = getAssets().list(path);
        if (children == null || children.length == 0) {
            if (path.isEmpty()) return;
            File parent = dest.getParentFile();
            if (parent != null) parent.mkdirs();
            try (java.io.InputStream input = getAssets().open(path)) {
                Files.copy(input, dest.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            }
            return;
        }
        dest.mkdirs();
        for (String child : children) {
            if (path.isEmpty() && !WEB_ROOT.contains(child)) continue;
            String next = path.isEmpty() ? child : path + "/" + child;
            copyAsset(next, new File(dest, child));
        }
    }

    private static String readText(File file) throws Exception {
        return new String(java.nio.file.Files.readAllBytes(file.toPath()), java.nio.charset.StandardCharsets.UTF_8);
    }

    private static void writeText(File file, String text) throws Exception {
        java.nio.file.Files.write(file.toPath(), text.getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }

    private static void deleteRecursively(File file) {
        if (file == null || !file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteRecursively(child);
        file.delete();
    }

    private void stopHosting() {
        if (refresher != null) refresher.interrupt();
        if (host != null) {
            try { host.stop(); } catch (Exception ignored) { }
            host = null;
        }
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
    }

    @Override
    public void onDestroy() {
        stopHosting();
        super.onDestroy();
    }
}
