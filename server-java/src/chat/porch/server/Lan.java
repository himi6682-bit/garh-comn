package chat.porch.server;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.net.Inet4Address;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Every usable IPv4 address, including USB Ethernet (eth0, rndis0) and Wi-Fi. */
public final class Lan {
    public static final class Addr {
        public final String name;
        public final String address;
        public final String kind;

        public Addr(String name, String address, String kind) {
            this.name = name;
            this.address = address;
            this.kind = kind;
        }

        public String label() {
            if ("ethernet".equals(kind)) return "Ethernet";
            if ("wifi".equals(kind)) return "Wi-Fi";
            return "Other";
        }

        public String url(boolean https, int port) {
            return (https ? "https" : "http") + "://" + address + ":" + port;
        }

        public JSONObject json(boolean https, int port) {
            JSONObject object = new JSONObject();
            J.put(object, "name", name);
            J.put(object, "address", address);
            J.put(object, "kind", kind);
            J.put(object, "label", label());
            J.put(object, "url", url(https, port));
            return object;
        }
    }

    private Lan() {}

    public static String kindForName(String name) {
        String n = name == null ? "" : name.toLowerCase();
        if (n.contains("wi-fi") || n.contains("wifi") || n.contains("wlan") || n.startsWith("wl")) return "wifi";
        if (n.contains("ethernet") || n.contains("usb") || n.contains("rndis") || n.contains("ncm")
                || n.startsWith("eth") || n.startsWith("enx") || n.startsWith("enp") || n.startsWith("eno")) {
            return "ethernet";
        }
        return "other";
    }

    public static List<Addr> list(File dataDir) {
        Map<String, Addr> byIp = new LinkedHashMap<String, Addr>();
        try {
            for (NetworkInterface iface : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!iface.isUp() || iface.isLoopback()) continue;
                String name = iface.getName();
                if (skip(name) && !byIp.isEmpty()) continue;
                for (InterfaceAddress binding : iface.getInterfaceAddresses()) {
                    if (!(binding.getAddress() instanceof Inet4Address)) continue;
                    String address = binding.getAddress().getHostAddress();
                    if (address == null || address.startsWith("127.") || address.startsWith("169.254.")) continue;
                    byIp.put(address, new Addr(name, address, kindForName(name)));
                }
            }
        } catch (Exception ignored) {
            // Listing interfaces can fail in a restricted sandbox. Advertised addresses still apply.
        }
        for (Addr extra : readAdvertised(dataDir)) byIp.put(extra.address, extra);
        List<Addr> rows = new ArrayList<Addr>(byIp.values());
        Collections.sort(rows, (a, b) -> {
            int rank = rank(a.kind) - rank(b.kind);
            return rank != 0 ? rank : a.address.compareTo(b.address);
        });
        return rows;
    }

    private static boolean skip(String name) {
        String n = name == null ? "" : name.toLowerCase();
        return n.equals("lo") || n.startsWith("docker") || n.startsWith("br-") || n.startsWith("veth")
                || n.startsWith("virbr") || n.startsWith("tun") || n.startsWith("tap") || n.startsWith("wg");
    }

    private static int rank(String kind) {
        if ("ethernet".equals(kind)) return 0;
        if ("wifi".equals(kind)) return 1;
        return 2;
    }

    private static List<Addr> readAdvertised(File dataDir) {
        List<Addr> rows = new ArrayList<Addr>();
        if (dataDir == null) return rows;
        File file = new File(dataDir, "advertise-ips.json");
        if (!file.isFile()) return rows;
        try {
            String raw = new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8);
            JSONArray addresses = new JSONObject(raw).optJSONArray("addresses");
            if (addresses == null) return rows;
            for (int i = 0; i < addresses.length(); i++) {
                JSONObject item = addresses.getJSONObject(i);
                String address = item.optString("address", "");
                if (!address.matches("\\d{1,3}(\\.\\d{1,3}){3}") || address.startsWith("127.")) continue;
                String name = item.optString("name", "advertised");
                String kind = item.optString("kind", "");
                if (!"wifi".equals(kind) && !"ethernet".equals(kind)) kind = kindForName(name);
                rows.add(new Addr(name, address, kind));
            }
        } catch (Exception ignored) {
            return rows;
        }
        return rows;
    }
}
