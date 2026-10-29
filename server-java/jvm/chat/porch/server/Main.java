package chat.porch.server;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.WebSocket;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

public final class Main {
    public static void main(String[] args) throws Exception {
        if (args.length > 0 && "--self-test".equals(args[0])) {
            selfTest();
            return;
        }
        File dataDir = new File("data");
        int port = 8787;
        String username = "admin";
        String password = "";
        String display = "Admin";
        for (int i = 0; i < args.length; i++) {
            if ("--data".equals(args[i])) dataDir = new File(args[++i]);
            else if ("--port".equals(args[i])) port = Integer.parseInt(args[++i]);
            else if ("--username".equals(args[i])) username = args[++i];
            else if ("--password".equals(args[i])) password = args[++i];
            else if ("--name".equals(args[i])) display = args[++i];
        }
        dataDir.mkdirs();
        JdbcSql sql = new JdbcSql(new File(dataDir, "porch.db").getAbsolutePath());
        PorchHost host = new PorchHost(sql, dataDir, new File("public"), port, 10, 8, 30, true);
        host.ensureAdmin(username, display, password);
        host.start();
        System.out.println("PORT=" + host.getListeningPort());
        Thread.currentThread().join();
    }

    private static void selfTest() throws Exception {
        File data = Files.createTempDirectory("porch-java").toFile();
        File pub = new File(data, "public");
        pub.mkdirs();
        Files.writeString(new File(pub, "index.html").toPath(), "<!doctype html><title>Garh-Comn</title>");
        JdbcSql sql = new JdbcSql(new File(data, "porch.db").getAbsolutePath());
        PorchHost host = new PorchHost(sql, data, pub, 0, 6, 8, 30, false);
        host.ensureAdmin("admin", "Ada Admin", "admin-pass-123");
        host.start();
        int port = host.getListeningPort();
        HttpClient http = HttpClient.newHttpClient();
        try {
            check(host.getHostname().equals("0.0.0.0"), "host must bind 0.0.0.0, got " + host.getHostname());
            HttpResponse<String> health = send(http, port, "GET", "/api/health", null, null);
            check(health.statusCode() == 200, health.body());
            HttpResponse<String> bad = send(http, port, "POST", "/api/login", "{\"username\":\"admin\",\"password\":\"nope-pass\"}", null);
            check(bad.statusCode() == 401, bad.body());
            HttpResponse<String> admin = send(http, port, "POST", "/api/login", "{\"username\":\"admin\",\"password\":\"admin-pass-123\"}", null);
            check(admin.statusCode() == 200, admin.body());
            String adminToken = new JSONObject(admin.body()).getString("token");
            SocketWait idle = socket(port, adminToken);
            idle.await("ready");
            Thread.sleep(7000);
            idle.webSocket.sendText("{\"type\":\"ping\"}", true).join();
            JSONObject pong = idle.await("pong");
            check("pong".equals(pong.optString("type")), "websocket died while idle");
            HttpResponse<String> maya = send(http, port, "POST", "/api/admin/users",
                    "{\"username\":\"maya\",\"displayName\":\"Maya Chen\",\"password\":\"maya-pass-123\"}", adminToken);
            check(maya.statusCode() == 201, maya.body());
            long mayaId = new JSONObject(maya.body()).getJSONObject("user").getLong("id");
            HttpResponse<String> sam = send(http, port, "POST", "/api/admin/users",
                    "{\"username\":\"sam\",\"displayName\":\"Sam Okonkwo\",\"password\":\"sam-pass-1234\"}", adminToken);
            check(sam.statusCode() == 201, sam.body());
            long samId = new JSONObject(sam.body()).getJSONObject("user").getLong("id");
            HttpResponse<String> samLogin = send(http, port, "POST", "/api/login", "{\"username\":\"sam\",\"password\":\"sam-pass-1234\"}", null);
            String samToken = new JSONObject(samLogin.body()).getString("token");
            HttpResponse<String> mayaLogin = send(http, port, "POST", "/api/login", "{\"username\":\"maya\",\"password\":\"maya-pass-123\"}", null);
            String mayaToken = new JSONObject(mayaLogin.body()).getString("token");
            SocketWait samSocket = socket(port, samToken);
            samSocket.await("ready");
            HttpResponse<String> direct = send(http, port, "POST", "/api/conversations", "{\"userId\":" + samId + "}", mayaToken);
            check(direct.statusCode() == 201, direct.body());
            long conversationId = new JSONObject(direct.body()).getJSONObject("conversation").getLong("id");
            HttpResponse<String> sent = send(http, port, "POST", "/api/conversations/" + conversationId + "/messages",
                    "{\"body\":\"The switch table is up.\"}", mayaToken);
            check(sent.statusCode() == 201, sent.body());
            JSONObject incoming = samSocket.await("message");
            check("The switch table is up.".equals(incoming.getJSONObject("message").getString("body")), incoming.toString());
            check(!incoming.getJSONObject("message").getJSONArray("receipts").getJSONObject(0).isNull("deliveredAt"), "expected delivered");
            long messageId = incoming.getJSONObject("message").getLong("id");
            SocketWait mayaSocket = socket(port, mayaToken);
            mayaSocket.await("ready");
            HttpResponse<String> read = send(http, port, "POST", "/api/conversations/" + conversationId + "/read",
                    "{\"messageId\":" + messageId + "}", samToken);
            check(read.statusCode() == 200, read.body());
            JSONObject readEvent = mayaSocket.await("read");
            check(readEvent.getJSONArray("messageIds").getLong(0) == messageId, readEvent.toString());
            HttpResponse<String> lists = send(http, port, "GET", "/api/conversations", null, mayaToken);
            JSONArray conversations = new JSONObject(lists.body()).getJSONArray("conversations");
            boolean everyone = false;
            long everyoneId = 0;
            for (int i = 0; i < conversations.length(); i++) {
                if (conversations.getJSONObject(i).optBoolean("isEveryone")) {
                    everyone = true;
                    everyoneId = conversations.getJSONObject(i).getLong("id");
                }
            }
            check(everyone, "missing everyone group");
            HttpResponse<String> group = send(http, port, "POST", "/api/conversations/" + everyoneId + "/messages",
                    "{\"body\":\"Everyone can hear this.\"}", mayaToken);
            check(group.statusCode() == 201, group.body());
            JSONObject groupEvent = samSocket.await("message");
            check("Everyone can hear this.".equals(groupEvent.getJSONObject("message").getString("body")), groupEvent.toString());
            HttpResponse<String> blocked = send(http, port, "DELETE", "/api/conversations/" + everyoneId, null, adminToken);
            check(blocked.statusCode() == 400 && blocked.body().contains("Everyone"), blocked.body());
            HttpResponse<String> made = send(http, port, "POST", "/api/conversations",
                    "{\"type\":\"group\",\"name\":\"Switch crew\",\"memberIds\":[" + mayaId + "," + samId + "]}", adminToken);
            check(made.statusCode() == 201, made.body());
            long madeId = new JSONObject(made.body()).getJSONObject("conversation").getLong("id");
            HttpResponse<String> renamed = send(http, port, "PATCH", "/api/conversations/" + madeId,
                    "{\"name\":\"Night shift\"}", adminToken);
            check(renamed.statusCode() == 200 && renamed.body().contains("Night shift"), renamed.body());
            HttpResponse<String> trimmed = send(http, port, "PATCH", "/api/conversations/" + madeId,
                    "{\"memberIds\":[" + mayaId + "]}", adminToken);
            boolean stillSam = false;
            if (trimmed.statusCode() == 200) {
                JSONArray members = new JSONObject(trimmed.body()).getJSONObject("conversation").getJSONArray("members");
                for (int i = 0; i < members.length(); i++) {
                    if (members.getJSONObject(i).getLong("id") == samId) stillSam = true;
                }
            }
            check(trimmed.statusCode() == 200 && !stillSam, trimmed.body());
            JSONObject dropped = samSocket.await("conversation-removed");
            check(dropped.getLong("conversationId") == madeId, dropped.toString());
            HttpResponse<String> deleted = send(http, port, "DELETE", "/api/conversations/" + madeId, null, adminToken);
            check(deleted.statusCode() == 200, deleted.body());
            Files.writeString(new File(data, "advertise-ips.json").toPath(),
                    "{\"addresses\":[{\"name\":\"eth0\",\"address\":\"192.168.4.20\",\"kind\":\"ethernet\"},{\"name\":\"wlan0\",\"address\":\"192.168.1.15\",\"kind\":\"wifi\"}]}");
            HttpResponse<String> info = send(http, port, "GET", "/api/host-info", null, null);
            JSONArray addresses = new JSONObject(info.body()).getJSONArray("addresses");
            boolean ethernet = false;
            for (int i = 0; i < addresses.length(); i++) {
                JSONObject row = addresses.getJSONObject(i);
                if ("192.168.4.20".equals(row.getString("address"))) {
                    ethernet = "ethernet".equals(row.getString("kind")) && row.getString("url").contains("192.168.4.20");
                }
            }
            check(ethernet, info.body());
            HttpResponse<String> stranger = send(http, port, "GET", "/api/conversations/" + conversationId + "/messages", null, adminToken);
            check(stranger.statusCode() == 403, stranger.body());
            host.stop();
            JdbcSql again = new JdbcSql(new File(data, "porch.db").getAbsolutePath());
            PorchHost restarted = new PorchHost(again, data, pub, 0, 6, 8, 30, false);
            restarted.start();
            try {
                HttpResponse<String> relog = send(http, restarted.getListeningPort(), "POST", "/api/login",
                        "{\"username\":\"sam\",\"password\":\"sam-pass-1234\"}", null);
                String token = new JSONObject(relog.body()).getString("token");
                HttpResponse<String> history = send(http, restarted.getListeningPort(), "GET", "/api/conversations", null, token);
                boolean found = history.body().contains("The switch table is up.");
                check(found, history.body());
            } finally {
                restarted.stop();
            }
            System.out.println("JAVA_SELF_TEST_OK maya=" + mayaId);
        } finally {
            try { host.stop(); } catch (Exception ignored) { }
        }
    }

    private static HttpResponse<String> send(HttpClient http, int port, String method, String path, String body, String token) throws Exception {
        HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path));
        if (token != null) builder.header("Authorization", "Bearer " + token);
        if (body != null) builder.header("Content-Type", "application/json").method(method, HttpRequest.BodyPublishers.ofString(body));
        else builder.method(method, HttpRequest.BodyPublishers.noBody());
        return http.send(builder.build(), HttpResponse.BodyHandlers.ofString());
    }

    private static SocketWait socket(int port, String token) throws Exception {
        SocketWait wait = new SocketWait();
        HttpClient.newHttpClient().newWebSocketBuilder().buildAsync(
                URI.create("ws://127.0.0.1:" + port + "/ws?token=" + token), wait).join();
        return wait;
    }

    private static void check(boolean ok, String detail) {
        if (!ok) throw new AssertionError(detail);
    }

    private static final class SocketWait implements WebSocket.Listener {
        private final LinkedBlockingQueue<JSONObject> messages = new LinkedBlockingQueue<JSONObject>();
        private final StringBuilder buffer = new StringBuilder();
        private WebSocket webSocket;

        @Override
        public void onOpen(WebSocket webSocket) {
            this.webSocket = webSocket;
            webSocket.request(1);
        }

        JSONObject await(String type) throws Exception {
            long deadline = System.currentTimeMillis() + 5000;
            while (System.currentTimeMillis() < deadline) {
                JSONObject message = messages.poll(200, TimeUnit.MILLISECONDS);
                if (message != null && type.equals(message.optString("type"))) return message;
                if (message != null) messages.offer(message);
            }
            throw new AssertionError("timed out waiting for " + type);
        }

        @Override
        public CompletionStage<?> onText(WebSocket webSocket, CharSequence data, boolean last) {
            buffer.append(data);
            if (last) {
                try {
                    messages.offer(new JSONObject(buffer.toString()));
                } catch (Exception ignored) {
                    // Ignore non-JSON.
                }
                buffer.setLength(0);
            }
            webSocket.request(1);
            return null;
        }
    }
}
