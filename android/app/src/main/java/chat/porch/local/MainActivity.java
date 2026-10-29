package chat.porch.local;

import android.Manifest;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.view.View;
import android.webkit.SslErrorHandler;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.net.http.SslError;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.EdgeToEdge;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import androidx.appcompat.widget.SwitchCompat;
import androidx.core.content.ContextCompat;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import chat.porch.server.Lan;

import java.io.File;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetSocketAddress;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class MainActivity extends AppCompatActivity {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Map<String, JSONObject> discovered = new LinkedHashMap<String, JSONObject>();
    private WebView web;
    private boolean hosting;
    private int probes;
    private DatagramSocket discovery;
    private WifiManager.MulticastLock multicastLock;
    private final Runnable refresh = new Runnable() {
        @Override
        public void run() {
            paintAddresses();
            handler.postDelayed(this, 2000);
        }
    };

    private final ActivityResultLauncher<String[]> permissionLauncher =
            registerForActivityResult(new ActivityResultContracts.RequestMultiplePermissions(), result -> requestBatteryThenHost());

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        EdgeToEdge.enable(this);
        setContentView(R.layout.activity_main);
        View root = findViewById(R.id.root);
        ViewCompat.setOnApplyWindowInsetsListener(root, (view, insets) -> {
            var bars = insets.getInsets(WindowInsetsCompat.Type.systemBars());
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return insets;
        });
        web = findViewById(R.id.web);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                new AlertDialog.Builder(MainActivity.this)
                        .setTitle("Certificate warning")
                        .setMessage("This host is using a certificate this tablet does not trust yet. Continue only if you set Garh-Comn up yourself.")
                        .setPositiveButton("Continue", (dialog, which) -> handler.proceed())
                        .setNegativeButton("Cancel", (dialog, which) -> handler.cancel())
                        .show();
            }
        });
        SharedPreferences prefs = prefs();
        if (!prefs.contains("start_on_boot")) prefs.edit().putBoolean("start_on_boot", true).apply();
        SwitchCompat boot = findViewById(R.id.boot_switch);
        boot.setChecked(prefs.getBoolean("start_on_boot", true));
        boot.setOnCheckedChangeListener((button, checked) -> prefs().edit().putBoolean("start_on_boot", checked).apply());
        boolean needsPassword = !new File(getFilesDir(), "porch-data/porch.db").exists();
        findViewById(R.id.admin_name).setVisibility(needsPassword ? View.VISIBLE : View.GONE);
        findViewById(R.id.admin_user).setVisibility(needsPassword ? View.VISIBLE : View.GONE);
        findViewById(R.id.admin_password).setVisibility(needsPassword ? View.VISIBLE : View.GONE);
        findViewById(R.id.host_button).setOnClickListener(v -> beginHost());
        findViewById(R.id.join_button).setOnClickListener(v -> joinTyped());
        findViewById(R.id.battery_button).setOnClickListener(v -> requestBatteryExemption());
        findViewById(R.id.leave_button).setOnClickListener(v -> leaveBrowser());
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (web.getVisibility() == View.VISIBLE && web.canGoBack()) web.goBack();
                else if (hosting) moveTaskToBack(true);
                else leaveBrowser();
            }
        });
        paintAddresses();
        updateBatteryStatus();
    }

    @Override
    protected void onStart() {
        super.onStart();
        handler.post(refresh);
        listenForHosts();
        if (prefs().getBoolean("hosted_once", false) && web.getVisibility() != View.VISIBLE) {
            // The service may already be running after boot. Open the chat if health answers.
            // Do not probe again while the chat page is already showing, or the WebView reloads.
            probes = 0;
            probeLocalHost();
        }
    }

    @Override
    protected void onStop() {
        handler.removeCallbacks(refresh);
        stopDiscovery();
        super.onStop();
    }

    private void beginHost() {
        if (!new File(getFilesDir(), "porch-data/porch.db").exists()) {
            EditText password = findViewById(R.id.admin_password);
            String value = password.getText().toString();
            if (value.length() < 8) {
                status("Choose an admin password with at least 8 characters.");
                return;
            }
            try {
                File dataDir = new File(getFilesDir(), "porch-data");
                dataDir.mkdirs();
                JSONObject config = new JSONObject();
                config.put("adminUsername", ((EditText) findViewById(R.id.admin_user)).getText().toString().trim());
                config.put("adminDisplayName", ((EditText) findViewById(R.id.admin_name)).getText().toString().trim());
                config.put("adminPassword", value);
                java.nio.file.Files.write(new File(dataDir, "config.json").toPath(), config.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
            } catch (Exception error) {
                status(error.getMessage());
                return;
            }
        }
        List<String> needed = new ArrayList<String>();
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.POST_NOTIFICATIONS);
        }
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.NEARBY_WIFI_DEVICES) != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.NEARBY_WIFI_DEVICES);
        }
        if (!needed.isEmpty()) {
            permissionLauncher.launch(needed.toArray(new String[0]));
            return;
        }
        requestBatteryThenHost();
    }

    private void requestBatteryThenHost() {
        PowerManager power = (PowerManager) getSystemService(POWER_SERVICE);
        if (!power.isIgnoringBatteryOptimizations(getPackageName())) requestBatteryExemption();
        startHostService();
    }

    private void requestBatteryExemption() {
        try {
            Intent intent = new Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            intent.setData(Uri.parse("package:" + getPackageName()));
            startActivity(intent);
            return;
        } catch (Exception ignored) {
            // Some images have no direct exemption prompt.
        }
        try {
            startActivity(new Intent(android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
        } catch (Exception ignored) {
            // Hosting still starts. The setup screen explains how to allow it later.
        }
    }

    private void startHostService() {
        prefs().edit().putBoolean("start_on_boot", ((SwitchCompat) findViewById(R.id.boot_switch)).isChecked()).apply();
        Intent service = new Intent(this, HostService.class);
        service.setAction(HostService.ACTION_START);
        ContextCompat.startForegroundService(this, service);
        hosting = true;
        probes = 0;
        status("Starting the host…");
        handler.postDelayed(this::probeLocalHost, 600);
    }

    private void probeLocalHost() {
        if (probes++ > 40) {
            status("The host did not answer. Open the notification to see what happened.");
            return;
        }
        new Thread(() -> {
            try {
                java.net.HttpURLConnection connection = (java.net.HttpURLConnection) new java.net.URL("http://127.0.0.1:" + HostService.PORT + "/api/health").openConnection();
                connection.setConnectTimeout(800);
                connection.setReadTimeout(800);
                int code = connection.getResponseCode();
                connection.disconnect();
                if (code == 200) handler.post(() -> showWeb("http://127.0.0.1:" + HostService.PORT + "/", true));
            } catch (Exception ignored) {
                handler.postDelayed(this::probeLocalHost, 700);
            }
        }).start();
    }

    private void joinTyped() {
        String raw = ((EditText) findViewById(R.id.join_address)).getText().toString().trim();
        if (raw.isEmpty()) {
            status("Enter the Ethernet or Wi-Fi address shown on the host.");
            return;
        }
        showWeb(normalize(raw), false);
    }

    private void showWeb(String url, boolean hostMode) {
        hosting = hostMode;
        findViewById(R.id.setup).setVisibility(View.GONE);
        findViewById(R.id.browser_bar).setVisibility(View.VISIBLE);
        web.setVisibility(View.VISIBLE);
        ((TextView) findViewById(R.id.browser_title)).setText(hostMode ? "Hosting on this tablet" : url);
        findViewById(R.id.live_addresses).setVisibility(hostMode ? View.VISIBLE : View.GONE);
        if (!samePage(web.getUrl(), url)) web.loadUrl(url);
        paintAddresses();
    }

    private static boolean samePage(String current, String next) {
        if (current == null || next == null) return false;
        try {
            java.net.URI left = java.net.URI.create(current);
            java.net.URI right = java.net.URI.create(next);
            int leftPort = left.getPort();
            int rightPort = right.getPort();
            if (leftPort < 0) leftPort = "https".equalsIgnoreCase(left.getScheme()) ? 443 : 80;
            if (rightPort < 0) rightPort = "https".equalsIgnoreCase(right.getScheme()) ? 443 : 80;
            String leftPath = left.getPath() == null || left.getPath().isEmpty() ? "/" : left.getPath();
            String rightPath = right.getPath() == null || right.getPath().isEmpty() ? "/" : right.getPath();
            return left.getHost() != null
                    && left.getHost().equalsIgnoreCase(right.getHost())
                    && leftPort == rightPort
                    && leftPath.equals(rightPath);
        } catch (Exception ignored) {
            return current.equals(next);
        }
    }

    private void leaveBrowser() {
        web.setVisibility(View.GONE);
        findViewById(R.id.browser_bar).setVisibility(View.GONE);
        findViewById(R.id.setup).setVisibility(View.VISIBLE);
        web.loadUrl("about:blank");
    }

    private void paintAddresses() {
        List<Lan.Addr> rows = LanProbe.list(this);
        fill(findViewById(R.id.address_list), rows);
        if (findViewById(R.id.live_addresses).getVisibility() == View.VISIBLE) {
            fill(findViewById(R.id.live_addresses), rows);
        }
        updateBatteryStatus();
        paintDiscovered();
    }

    private void fill(LinearLayout list, List<Lan.Addr> rows) {
        list.removeAllViews();
        if (rows.isEmpty()) {
            TextView empty = new TextView(this);
            empty.setTextColor(0xFFB7AD9F);
            empty.setText("No address yet. Plug in the USB-C Ethernet adapter or join Wi-Fi.");
            list.addView(empty);
            return;
        }
        for (Lan.Addr row : rows) {
            LinearLayout line = new LinearLayout(this);
            line.setOrientation(LinearLayout.HORIZONTAL);
            TextView label = new TextView(this);
            label.setText(row.label() + "  " + row.url(false, HostService.PORT));
            label.setTextColor(0xFFF6F1E8);
            label.setPadding(0, 12, 12, 12);
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1);
            label.setLayoutParams(params);
            Button copy = new Button(this);
            copy.setText("Copy");
            copy.setOnClickListener(v -> {
                ClipboardManager clipboard = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                clipboard.setPrimaryClip(ClipData.newPlainText("Garh-Comn", row.url(false, HostService.PORT)));
                Toast.makeText(this, "Copied " + row.url(false, HostService.PORT), Toast.LENGTH_SHORT).show();
            });
            line.addView(label);
            line.addView(copy);
            list.addView(line);
        }
    }

    private void paintDiscovered() {
        LinearLayout list = findViewById(R.id.discovered);
        list.removeAllViews();
        for (JSONObject host : new ArrayList<JSONObject>(discovered.values())) {
            JSONArray addresses = host.optJSONArray("addresses");
            if (addresses == null) continue;
            for (int i = 0; i < addresses.length(); i++) {
                JSONObject row = addresses.optJSONObject(i);
                if (row == null) continue;
                String url = row.optString("url");
                Button button = new Button(this);
                button.setText("Found " + row.optString("label", "network") + "  " + url);
                button.setOnClickListener(v -> showWeb(url, false));
                list.addView(button);
            }
        }
    }

    private void listenForHosts() {
        stopDiscovery();
        WifiManager wifi = (WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE);
        if (wifi != null) {
            multicastLock = wifi.createMulticastLock("porch-discover");
            multicastLock.setReferenceCounted(false);
            multicastLock.acquire();
        }
        new Thread(() -> {
            try {
                discovery = new DatagramSocket(null);
                discovery.setReuseAddress(true);
                discovery.setBroadcast(true);
                discovery.bind(new InetSocketAddress(45878));
                byte[] buffer = new byte[8192];
                while (!Thread.currentThread().isInterrupted() && discovery != null && !discovery.isClosed()) {
                    DatagramPacket packet = new DatagramPacket(buffer, buffer.length);
                    discovery.receive(packet);
                    String text = new String(packet.getData(), 0, packet.getLength(), java.nio.charset.StandardCharsets.UTF_8);
                    JSONObject payload = new JSONObject(text);
                    if (!"porch".equals(payload.optString("app"))) continue;
                    discovered.put(packet.getAddress().getHostAddress() + ":" + payload.optInt("port"), payload);
                    handler.post(this::paintDiscovered);
                }
            } catch (Exception ignored) {
                // The socket closes when the screen goes away.
            }
        }, "porch-discover").start();
    }

    private void stopDiscovery() {
        if (discovery != null) discovery.close();
        discovery = null;
        if (multicastLock != null && multicastLock.isHeld()) multicastLock.release();
    }

    private void updateBatteryStatus() {
        PowerManager power = (PowerManager) getSystemService(POWER_SERVICE);
        TextView view = findViewById(R.id.battery_status);
        if (view == null) return;
        if (power.isIgnoringBatteryOptimizations(getPackageName())) {
            view.setText("Battery optimization: unrestricted. The host can keep running with the screen off.");
        } else {
            view.setText("Battery optimization is still on. Garh-Comn may stop when the screen turns off. Allow unrestricted battery use.");
        }
    }

    private void status(String text) {
        ((TextView) findViewById(R.id.status)).setText(text);
    }

    private SharedPreferences prefs() {
        return getSharedPreferences("porch", Context.MODE_PRIVATE);
    }

    private static String normalize(String raw) {
        String value = raw;
        if (!value.contains("://")) value = "http://" + value;
        try {
            Uri uri = Uri.parse(value);
            if (uri.getPort() == -1) value = value + ":8787";
        } catch (Exception ignored) {
            value = "http://" + raw + ":8787";
        }
        return value;
    }
}
