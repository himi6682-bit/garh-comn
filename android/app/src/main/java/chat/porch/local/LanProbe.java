package chat.porch.local;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Build;

import chat.porch.server.Lan;

import java.net.Inet4Address;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Labels every IPv4 address, including a USB-C Ethernet adapter. */
public final class LanProbe {
    private LanProbe() {}

    public static List<Lan.Addr> list(Context context) {
        Map<String, String> kindByName = new LinkedHashMap<String, String>();
        Map<String, Lan.Addr> byAddress = new LinkedHashMap<String, Lan.Addr>();
        ConnectivityManager manager = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (manager != null) {
            for (Network network : manager.getAllNetworks()) {
                NetworkCapabilities caps = manager.getNetworkCapabilities(network);
                LinkProperties props = manager.getLinkProperties(network);
                if (caps == null || props == null) continue;
                String kind = "other";
                if (caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
                        || (Build.VERSION.SDK_INT >= 31 && caps.hasTransport(NetworkCapabilities.TRANSPORT_USB))) {
                    kind = "ethernet";
                } else if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
                    kind = "wifi";
                }
                if (props.getInterfaceName() != null) kindByName.put(props.getInterfaceName(), kind);
                for (LinkAddress link : props.getLinkAddresses()) {
                    if (!(link.getAddress() instanceof Inet4Address)) continue;
                    String address = link.getAddress().getHostAddress();
                    if (address == null || address.startsWith("127.") || address.startsWith("169.254.")) continue;
                    String name = props.getInterfaceName() == null ? kind : props.getInterfaceName();
                    byAddress.put(address, new Lan.Addr(name, address, kind));
                }
            }
        }
        for (Lan.Addr addr : Lan.list(null)) {
            String kind = kindByName.containsKey(addr.name) ? kindByName.get(addr.name) : addr.kind;
            if (!byAddress.containsKey(addr.address)) byAddress.put(addr.address, new Lan.Addr(addr.name, addr.address, kind));
        }
        return new ArrayList<Lan.Addr>(byAddress.values());
    }

    public static String summary(List<Lan.Addr> rows, int port) {
        if (rows.isEmpty()) return "Waiting for Wi-Fi or USB Ethernet…";
        StringBuilder builder = new StringBuilder();
        for (Lan.Addr row : rows) {
            if (builder.length() > 0) builder.append("\n");
            builder.append(row.label()).append("  ").append(row.url(false, port));
        }
        return builder.toString();
    }
}
