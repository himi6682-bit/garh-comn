package chat.porch.server;

import fi.iki.elonen.NanoHTTPD;
import fi.iki.elonen.NanoWSD;
import org.json.JSONArray;
import org.json.JSONObject;
import org.mindrot.jbcrypt.BCrypt;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Local chat host. The socket listens on 0.0.0.0 so USB Ethernet and Wi-Fi both work.
 */
public final class PorchHost extends NanoWSD {
    private static final Pattern CONV = Pattern.compile("^/api/conversations/(\\d+)$");
    private static final Pattern CONV_MESSAGES = Pattern.compile("^/api/conversations/(\\d+)/messages$");
    private static final Pattern CONV_READ = Pattern.compile("^/api/conversations/(\\d+)/read$");
    private static final Pattern ADMIN_USER = Pattern.compile("^/api/admin/users/(\\d+)$");
    private static final Pattern ADMIN_PASSWORD = Pattern.compile("^/api/admin/users/(\\d+)/password$");
    private static final Pattern FILE = Pattern.compile("^/api/files/([a-f0-9]{32})$");

    private final Sql sql;
    private final PorchLogic logic;
    private final File dataDir;
    private final File publicDir;
    private final File uploadDir;
    private final int bcryptRounds;
    private final int maxUploadMb;
    private final int sessionDays;
    private final boolean discovery;
    private final String dummyHash;
    private final Map<String, Attempt> byUser = new HashMap<String, Attempt>();
    private final Map<String, Attempt> byIp = new HashMap<String, Attempt>();
    private final Map<Long, Set<NanoWSD.WebSocket>> sockets = new ConcurrentHashMap<Long, Set<NanoWSD.WebSocket>>();
    private DatagramSocket beacon;
    private Thread beaconThread;

    public PorchHost(Sql sql, File dataDir, File publicDir, int port, int bcryptRounds, int maxUploadMb, int sessionDays, boolean discovery) {
        super("0.0.0.0", port);
        this.sql = sql;
        this.logic = new PorchLogic(sql);
        this.dataDir = dataDir;
        this.publicDir = publicDir;
        this.uploadDir = new File(dataDir, "uploads");
        this.bcryptRounds = bcryptRounds;
        this.maxUploadMb = maxUploadMb;
        this.sessionDays = sessionDays;
        this.discovery = discovery;
        this.dummyHash = BCrypt.hashpw("porch-dummy-password", BCrypt.gensalt(bcryptRounds));
        Schema.migrate(sql);
        logic.ensureEveryone();
        if (!uploadDir.isDirectory() && !uploadDir.mkdirs()) {
            throw new IllegalStateException("Could not create " + uploadDir);
        }
    }

    public PorchLogic logic() {
        return logic;
    }

    public void ensureAdmin(String username, String displayName, String password) {
        if (logic.anyUser()) return;
        if (password == null || password.length() < 8) throw new HttpError(400, "Passwords need 8 to 72 characters.");
        logic.createUser(normalize(username), clean(displayName, 40, "display name"), hash(password), "admin");
    }

    @Override
    public void start() throws IOException {
        // A positive timeout becomes SO_TIMEOUT on every accepted socket, including
        // the WebSocket. Five quiet seconds then dropped the admin's connection,
        // and the page treated that reconnect as "open the last chat".
        super.start(0, false);
        if (discovery) startBeacon();
    }

    @Override
    public void stop() {
        if (beaconThread != null) beaconThread.interrupt();
        if (beacon != null) beacon.close();
        try {
            super.stop();
        } catch (RuntimeException ignored) {
            // Stopping before listen() is harmless.
        }
        sql.close();
    }

    @Override
    protected NanoWSD.WebSocket openWebSocket(IHTTPSession handshake) {
        return new Client(handshake);
    }

    @Override
    protected Response serveHttp(IHTTPSession session) {
        try {
            String uri = session.getUri();
            Method method = session.getMethod();
            if (uri.startsWith("/api/")) return dispatch(session, method, uri);
            if (method == Method.GET || method == Method.HEAD) return staticFile(uri);
            return json(Response.Status.NOT_FOUND, error("Not found."));
        } catch (HttpError error) {
            return json(status(error.status), error(error.getMessage()));
        } catch (NanoHTTPD.ResponseException error) {
            return json(error.getStatus(), error(error.getMessage()));
        } catch (Exception error) {
            error.printStackTrace();
            return json(Response.Status.INTERNAL_ERROR, error("The host hit an unexpected error."));
        }
    }

    private Response dispatch(IHTTPSession session, Method method, String uri) throws Exception {
        if ("/api/health".equals(uri) && method == Method.GET) {
            JSONObject body = new JSONObject();
            J.put(body, "ok", true);
            J.put(body, "name", "garh-comn");
            J.put(body, "maxUploadMb", maxUploadMb);
            return json(Response.Status.OK, body);
        }
        if ("/api/host-info".equals(uri) && method == Method.GET) return json(Response.Status.OK, hostInfo());
        if ("/api/login".equals(uri) && method == Method.POST) return login(session);
        if ("/api/logout".equals(uri) && method == Method.POST) return logout(session);
        Row user = requireUser(session);
        if ("/api/me".equals(uri) && method == Method.GET) {
            JSONObject body = new JSONObject();
            J.put(body, "user", logic.userJson(user));
            J.put(body, "maxUploadMb", maxUploadMb);
            return json(Response.Status.OK, body);
        }
        if ("/api/users".equals(uri) && method == Method.GET) {
            JSONObject body = new JSONObject();
            J.put(body, "users", logic.listUsers(false));
            return json(Response.Status.OK, body);
        }
        if ("/api/conversations".equals(uri) && method == Method.GET) {
            JSONObject body = new JSONObject();
            J.put(body, "conversations", logic.listConversations(user.lng("id")));
            return json(Response.Status.OK, body);
        }
        if ("/api/conversations".equals(uri) && method == Method.POST) return createConversation(session, user);
        Matcher conversation = CONV.matcher(uri);
        if (conversation.matches() && method == Method.PATCH) return updateConversation(session, user, Long.parseLong(conversation.group(1)));
        if (conversation.matches() && method == Method.DELETE) return deleteConversation(user, Long.parseLong(conversation.group(1)));
        Matcher messages = CONV_MESSAGES.matcher(uri);
        if (messages.matches() && method == Method.GET) {
            long id = Long.parseLong(messages.group(1));
            long before = longParam(session, "before");
            int limit = (int) longParam(session, "limit");
            if (limit == 0) limit = 50;
            return json(Response.Status.OK, logic.listMessages(id, user.lng("id"), before, limit));
        }
        if (messages.matches() && method == Method.POST) return postMessage(session, user, Long.parseLong(messages.group(1)));
        Matcher read = CONV_READ.matcher(uri);
        if (read.matches() && method == Method.POST) return markRead(session, user, Long.parseLong(read.group(1)));
        Matcher file = FILE.matcher(uri);
        if (file.matches() && method == Method.GET) return download(user, file.group(1));
        if (!"admin".equals(user.str("role")) && uri.startsWith("/api/admin/")) {
            throw new HttpError(403, "Only the admin can do that.");
        }
        if ("/api/admin/users".equals(uri) && method == Method.GET) {
            JSONObject body = new JSONObject();
            J.put(body, "users", logic.listUsers(true));
            return json(Response.Status.OK, body);
        }
        if ("/api/admin/users".equals(uri) && method == Method.POST) return createAccount(session);
        Matcher admin = ADMIN_USER.matcher(uri);
        if (admin.matches() && method == Method.PATCH) return disableUser(session, user, Long.parseLong(admin.group(1)));
        if (admin.matches() && method == Method.DELETE) return removeUser(user, Long.parseLong(admin.group(1)));
        Matcher password = ADMIN_PASSWORD.matcher(uri);
        if (password.matches() && method == Method.POST) return resetPassword(session, user, Long.parseLong(password.group(1)));
        return json(Response.Status.NOT_FOUND, error("Not found."));
    }

    private Response login(IHTTPSession session) throws Exception {
        JSONObject body = jsonBody(session);
        String username = normalize(body.optString("username", ""));
        String password = body.optString("password", "");
        String ip = session.getRemoteIpAddress() == null ? "" : session.getRemoteIpAddress().replace("::ffff:", "");
        Attempt limited = limited(ip, username.isEmpty() ? "-" : username);
        if (limited != null) {
            Response response = json(Response.Status.TOO_MANY_REQUESTS, error("Too many sign-in attempts. Wait a few minutes and try again."));
            response.addHeader("Retry-After", String.valueOf(limited.retryAfter()));
            return response;
        }
        Row row = username.isEmpty() ? null : logic.userByUsername(username);
        String hash = row == null ? dummyHash : row.str("password_hash");
        boolean matches;
        try {
            matches = BCrypt.checkpw(password, hash);
        } catch (IllegalArgumentException error) {
            matches = false;
        }
        if (row == null || !matches) {
            recordFailure(ip, username.isEmpty() ? "-" : username);
            return json(Response.Status.UNAUTHORIZED, error("That username and password do not match."));
        }
        if (row.bool("disabled")) {
            recordFailure(ip, username);
            return json(Response.Status.FORBIDDEN, error("This account is disabled. Ask the admin to turn it back on."));
        }
        clearFailure(ip, username);
        String token = newToken();
        long maxAge = sessionDays * 86400L;
        logic.createSession(row.lng("id"), sha256(token), System.currentTimeMillis() + maxAge * 1000L);
        JSONObject payload = new JSONObject();
        J.put(payload, "token", token);
        J.put(payload, "user", logic.userJson(row));
        J.put(payload, "maxUploadMb", maxUploadMb);
        Response response = json(Response.Status.OK, payload);
        response.addHeader("Set-Cookie", "porch_session=" + token + "; HttpOnly; SameSite=Lax; Path=/; Max-Age=" + maxAge);
        return response;
    }

    private Response logout(IHTTPSession session) {
        String token = tokenOf(session);
        if (token != null) logic.deleteSession(sha256(token));
        Response response = json(Response.Status.OK, J.put(new JSONObject(), "ok", true));
        response.addHeader("Set-Cookie", "porch_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
        return response;
    }

    private Response createConversation(IHTTPSession session, Row user) throws Exception {
        JSONObject body = jsonBody(session);
        long conversationId;
        if (body.has("userId")) {
            conversationId = logic.findOrCreateDirect(user.lng("id"), body.optLong("userId"));
        } else if ("group".equals(body.optString("type"))) {
            if (!"admin".equals(user.str("role"))) throw new HttpError(403, "Only the admin can create a group.");
            List<Long> ids = new ArrayList<Long>();
            JSONArray raw = body.optJSONArray("memberIds");
            if (raw != null) for (int i = 0; i < raw.length(); i++) ids.add(raw.optLong(i));
            conversationId = logic.createGroup(clean(body.optString("name", ""), 40, "group name"), user.lng("id"), ids);
        } else {
            throw new HttpError(400, "Choose a person or a group name.");
        }
        publishConversation(conversationId);
        JSONObject payload = new JSONObject();
        J.put(payload, "conversation", logic.buildConversation(conversationId, user.lng("id")));
        return json(Response.Status.CREATED, payload);
    }

    private Response updateConversation(IHTTPSession session, Row user, long conversationId) throws Exception {
        if (!"admin".equals(user.str("role"))) throw new HttpError(403, "Only the admin can change a group.");
        JSONObject body = jsonBody(session);
        boolean hasName = body.has("name");
        boolean hasMembers = body.has("memberIds");
        if (!hasName && !hasMembers) throw new HttpError(400, "Nothing to change.");
        String name = hasName ? clean(body.optString("name", ""), 40, "group name") : null;
        List<Long> ids = null;
        if (hasMembers) {
            ids = new ArrayList<Long>();
            JSONArray raw = body.optJSONArray("memberIds");
            if (raw != null) for (int i = 0; i < raw.length(); i++) ids.add(raw.optLong(i));
        }
        JSONObject change = logic.updateGroup(conversationId, user.lng("id"), name, ids);
        publishConversation(conversationId);
        JSONArray removed = change.optJSONArray("removed");
        if (removed != null) {
            for (int i = 0; i < removed.length(); i++) publishRemoved(removed.optLong(i), conversationId, "removed");
        }
        JSONObject payload = new JSONObject();
        J.put(payload, "conversation", logic.buildConversation(conversationId, user.lng("id")));
        return json(Response.Status.OK, payload);
    }

    private Response deleteConversation(Row user, long conversationId) {
        if (!"admin".equals(user.str("role"))) throw new HttpError(403, "Only the admin can delete a group.");
        JSONObject removed = logic.deleteGroup(conversationId);
        JSONArray members = removed.optJSONArray("memberIds");
        if (members != null) {
            for (int i = 0; i < members.length(); i++) publishRemoved(members.optLong(i), conversationId, "deleted");
        }
        return json(Response.Status.OK, J.put(new JSONObject(), "ok", true));
    }

    private Response postMessage(IHTTPSession session, Row user, long conversationId) throws Exception {
        Map<String, String> files = new HashMap<String, String>();
        session.parseBody(files);
        String text = cleanBody(session.getParms().get("body"));
        String contentType = header(session, "content-type");
        if (contentType != null && contentType.contains("application/json")) {
            String raw = files.get("postData");
            if (raw != null && !raw.isEmpty()) text = cleanBody(new JSONObject(raw).optString("body", ""));
        }
        String attachmentId = null;
        String attachmentName = null;
        String attachmentMime = null;
        Long attachmentSize = null;
        if (files.containsKey("file")) {
            File temp = new File(files.get("file"));
            if (temp.length() > maxUploadMb * 1024L * 1024L) {
                temp.delete();
                throw new HttpError(413, "That file is larger than the " + maxUploadMb + " MB limit.");
            }
            String original = session.getParms().get("file");
            if (original == null || original.isEmpty()) original = "file";
            original = new File(original).getName().replace("\"", "").replace("\n", "");
            if (original.length() > 120) original = original.substring(0, 120);
            String ext = original.contains(".") ? original.substring(original.lastIndexOf('.') + 1).toLowerCase(Locale.US) : "";
            attachmentMime = mimeFor(ext);
            if (attachmentMime == null) {
                temp.delete();
                throw new HttpError(400, "That file type is not allowed. Use a photo, PDF, text, audio, or zip.");
            }
            attachmentId = hexId();
            File dest = new File(uploadDir, attachmentId);
            if (!temp.renameTo(dest)) {
                java.nio.file.Files.copy(temp.toPath(), dest.toPath());
                temp.delete();
            }
            attachmentName = original;
            attachmentSize = dest.length();
        }
        if ((text == null || text.isEmpty()) && attachmentId == null) throw new HttpError(400, "Write a message or attach a file.");
        if (text != null && text.length() > 4000) throw new HttpError(400, "Messages must be under 4000 characters.");
        JSONObject message = logic.createMessage(conversationId, user.lng("id"), text, attachmentId, attachmentName, attachmentMime, attachmentSize, onlineIds());
        publishMessage(message);
        JSONObject payload = new JSONObject();
        J.put(payload, "message", message);
        return json(Response.Status.CREATED, payload);
    }

    private Response markRead(IHTTPSession session, Row user, long conversationId) throws Exception {
        JSONObject body = jsonBody(session);
        long messageId = body.optLong("messageId");
        if (messageId == 0) throw new HttpError(400, "Missing message.");
        JSONObject event = logic.markRead(user.lng("id"), conversationId, messageId);
        JSONObject payload = new JSONObject(event.toString());
        J.put(payload, "type", "read");
        for (Long id : logic.memberIds(conversationId)) emit(id, payload);
        return json(Response.Status.OK, event);
    }

    private Response download(Row user, String id) throws Exception {
        Row message = logic.fileForUser(user.lng("id"), id);
        if (message == null) throw new HttpError(404, "File not found.");
        File file = new File(uploadDir, id);
        if (!file.isFile()) throw new HttpError(404, "File not found.");
        String mime = message.str("attachment_mime") == null ? "application/octet-stream" : message.str("attachment_mime");
        Response response = newFixedLengthResponse(Response.Status.OK, mime, new FileInputStream(file), file.length());
        String kind = mime.startsWith("image/") || mime.startsWith("audio/") || "application/pdf".equals(mime) ? "inline" : "attachment";
        response.addHeader("Content-Disposition", kind + "; filename=\"" + message.str("attachment_name") + "\"");
        response.addHeader("X-Content-Type-Options", "nosniff");
        return response;
    }

    private Response createAccount(IHTTPSession session) throws Exception {
        JSONObject body = jsonBody(session);
        String username = normalize(body.optString("username", ""));
        assertUsername(username);
        String displayName = clean(body.optString("displayName", ""), 40, "display name");
        JSONObject user = logic.createUser(username, displayName, hash(body.optString("password", "")), "user");
        Row everyone = sql.queryOne("SELECT id FROM conversations WHERE is_everyone = 1");
        if (everyone != null) publishConversation(everyone.lng("id"));
        JSONObject payload = new JSONObject();
        J.put(payload, "user", user);
        return json(Response.Status.CREATED, payload);
    }

    private Response disableUser(IHTTPSession session, Row actor, long id) throws Exception {
        JSONObject body = jsonBody(session);
        if (!body.has("disabled")) throw new HttpError(400, "Say whether the account is disabled.");
        if (id == actor.lng("id") && body.optBoolean("disabled")) throw new HttpError(400, "You cannot disable your own account.");
        JSONObject user = logic.setDisabled(id, body.optBoolean("disabled"));
        if (body.optBoolean("disabled")) {
            logic.deleteUserSessions(id, null);
            disconnect(id, "This account is disabled.");
        }
        JSONObject payload = new JSONObject();
        J.put(payload, "user", user);
        return json(Response.Status.OK, payload);
    }

    private Response resetPassword(IHTTPSession session, Row actor, long id) throws Exception {
        JSONObject body = jsonBody(session);
        if (logic.userById(id) == null) throw new HttpError(404, "No account with that id.");
        logic.setPassword(id, hash(body.optString("password", "")));
        String except = id == actor.lng("id") ? sha256(tokenOf(session)) : null;
        logic.deleteUserSessions(id, except);
        if (id != actor.lng("id")) disconnect(id, "Your password was changed. Sign in again.");
        return json(Response.Status.OK, J.put(new JSONObject(), "ok", true));
    }

    private Response removeUser(Row actor, long id) {
        if (id == actor.lng("id")) throw new HttpError(400, "You cannot delete your own account.");
        logic.deleteUser(id);
        disconnect(id, "This account was deleted.");
        return json(Response.Status.OK, J.put(new JSONObject(), "ok", true));
    }

    private Response staticFile(String uri) throws IOException {
        String path = "/".equals(uri) ? "/index.html" : uri;
        if (path.contains("..")) return json(Response.Status.NOT_FOUND, error("Not found."));
        File root = publicDir.getCanonicalFile();
        File file = new File(root, path).getCanonicalFile();
        if (!file.getPath().startsWith(root.getPath()) || !file.isFile()) {
            return json(Response.Status.NOT_FOUND, error("Not found."));
        }
        String mime = mimeForFile(file.getName());
        Response response = newFixedLengthResponse(Response.Status.OK, mime, new FileInputStream(file), file.length());
        if (file.getName().endsWith(".html") || file.getName().equals("sw.js") || file.getName().endsWith(".webmanifest")) {
            response.addHeader("Cache-Control", "no-cache");
        }
        return response;
    }

    private JSONObject hostInfo() {
        JSONObject object = new JSONObject();
        J.put(object, "port", getListeningPort());
        J.put(object, "https", false);
        JSONArray addresses = new JSONArray();
        for (Lan.Addr addr : Lan.list(dataDir)) J.put(addresses, addr.json(false, getListeningPort()));
        J.put(object, "addresses", addresses);
        return object;
    }

    private void publishConversation(long conversationId) {
        for (Long id : logic.memberIds(conversationId)) {
            JSONObject event = new JSONObject();
            J.put(event, "type", "conversation");
            J.put(event, "conversation", logic.buildConversation(conversationId, id));
            emit(id, event);
        }
    }

    private void publishRemoved(long userId, long conversationId, String reason) {
        JSONObject event = new JSONObject();
        J.put(event, "type", "conversation-removed");
        J.put(event, "conversationId", conversationId);
        J.put(event, "reason", reason);
        emit(userId, event);
    }

    private void publishMessage(JSONObject message) {
        JSONObject event = new JSONObject();
        J.put(event, "type", "message");
        J.put(event, "message", message);
        Set<Long> ids = new HashSet<Long>();
        if (!message.isNull("senderId")) ids.add(message.optLong("senderId"));
        JSONArray receipts = message.optJSONArray("receipts");
        if (receipts != null) {
            for (int i = 0; i < receipts.length(); i++) {
                JSONObject receipt = receipts.optJSONObject(i);
                if (receipt != null) ids.add(receipt.optLong("userId"));
            }
        }
        for (Long id : ids) emit(id, event);
    }

    private Set<Long> onlineIds() {
        return new HashSet<Long>(sockets.keySet());
    }

    private void emit(long userId, JSONObject payload) {
        Set<NanoWSD.WebSocket> set = sockets.get(userId);
        if (set == null) return;
        String raw = payload.toString();
        for (NanoWSD.WebSocket socket : new ArrayList<NanoWSD.WebSocket>(set)) {
            try {
                if (socket.isOpen()) socket.send(raw);
            } catch (IOException ignored) {
                // The close handler drops it.
            }
        }
    }

    private void disconnect(long userId, String reason) {
        Set<NanoWSD.WebSocket> set = sockets.remove(userId);
        if (set == null) return;
        JSONObject payload = new JSONObject();
        J.put(payload, "type", "kicked");
        J.put(payload, "reason", reason);
        for (NanoWSD.WebSocket socket : set) {
            try {
                if (socket.isOpen()) {
                    socket.send(payload.toString());
                    socket.close(NanoWSD.WebSocketFrame.CloseCode.NormalClosure, "revoked", false);
                }
            } catch (IOException ignored) {
                // Already gone.
            }
        }
        broadcastPresence();
    }

    private void broadcastPresence() {
        JSONObject payload = new JSONObject();
        J.put(payload, "type", "presence");
        J.put(payload, "userIds", new JSONArray(sockets.keySet()));
        for (Long id : new ArrayList<Long>(sockets.keySet())) emit(id, payload);
    }

    private Row requireUser(IHTTPSession session) {
        String token = tokenOf(session);
        Row user = token == null ? null : logic.sessionUser(sha256(token));
        if (user == null) throw new HttpError(401, "You need to sign in.");
        return user;
    }

    private String tokenOf(IHTTPSession session) {
        String header = header(session, "authorization");
        if (header != null && header.startsWith("Bearer ")) return header.substring(7).trim();
        String cookie = header(session, "cookie");
        if (cookie == null) return null;
        for (String part : cookie.split(";")) {
            String[] bits = part.trim().split("=", 2);
            if (bits.length == 2 && "porch_session".equals(bits[0])) return bits[1];
        }
        return null;
    }

    private static String header(IHTTPSession session, String name) {
        return session.getHeaders().get(name);
    }

    private JSONObject jsonBody(IHTTPSession session) throws Exception {
        // NanoHTTPD reads a PATCH body and then throws it away. Read it ourselves.
        if (session.getMethod() == Method.PATCH) {
            String lengthHeader = header(session, "content-length");
            int length = 0;
            try {
                length = lengthHeader == null ? 0 : Integer.parseInt(lengthHeader.trim());
            } catch (NumberFormatException ignored) {
                length = 0;
            }
            if (length > 65536) throw new HttpError(413, "That upload is too large.");
            if (length == 0) return new JSONObject();
            byte[] buf = new byte[length];
            int read = 0;
            java.io.InputStream input = session.getInputStream();
            while (read < length) {
                int n = input.read(buf, read, length - read);
                if (n < 0) break;
                read += n;
            }
            String raw = new String(buf, 0, read, java.nio.charset.StandardCharsets.UTF_8).trim();
            if (raw.isEmpty()) return new JSONObject();
            return new JSONObject(raw);
        }
        Map<String, String> files = new HashMap<String, String>();
        session.parseBody(files);
        String raw = files.get("postData");
        if (raw == null || raw.trim().isEmpty()) return new JSONObject();
        if (raw.length() > 65536) throw new HttpError(413, "That upload is too large.");
        return new JSONObject(raw);
    }

    private static long longParam(IHTTPSession session, String name) {
        String value = session.getParms().get(name);
        if (value == null || value.isEmpty()) return 0L;
        try {
            return Long.parseLong(value);
        } catch (NumberFormatException error) {
            return 0L;
        }
    }

    private String hash(String password) {
        if (password == null || password.length() < 8 || password.length() > 72) {
            throw new HttpError(400, "Passwords need 8 to 72 characters.");
        }
        return BCrypt.hashpw(password, BCrypt.gensalt(bcryptRounds));
    }

    private static String normalize(String value) {
        return value == null ? "" : value.trim().toLowerCase(Locale.US);
    }

    private static void assertUsername(String username) {
        if (!username.matches("[a-z0-9][a-z0-9._-]{2,31}")) {
            throw new HttpError(400, "Usernames are 3–32 characters: letters, numbers, dots, dashes, or underscores, and must start with a letter or number.");
        }
    }

    private static String clean(String value, int max, String label) {
        String text = value == null ? "" : value.replaceAll("[\\u0000-\\u001F]", "").trim();
        if (text.isEmpty()) throw new HttpError(400, "Enter a " + label + ".");
        if (text.length() > max) throw new HttpError(400, label.substring(0, 1).toUpperCase(Locale.US) + label.substring(1) + " must be under " + max + " characters.");
        return text;
    }

    private static String cleanBody(String value) {
        if (value == null) return "";
        return value.replaceAll("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F]", "").trim();
    }

    private static String hexId() {
        byte[] bytes = new byte[16];
        new SecureRandom().nextBytes(bytes);
        StringBuilder builder = new StringBuilder();
        for (byte bite : bytes) builder.append(String.format("%02x", bite));
        return builder.toString();
    }

    private static String newToken() {
        byte[] bytes = new byte[32];
        new SecureRandom().nextBytes(bytes);
        return java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    private static String sha256(String token) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(token.getBytes(StandardCharsets.UTF_8));
            StringBuilder builder = new StringBuilder();
            for (byte bite : digest) builder.append(String.format("%02x", bite));
            return builder.toString();
        } catch (Exception error) {
            throw new IllegalStateException(error);
        }
    }

    private Attempt limited(String ip, String username) {
        long now = System.currentTimeMillis();
        Attempt user = byUser.get(ip + ":" + username);
        Attempt net = byIp.get(ip);
        if (user != null && user.reset > now && user.count >= 8) return user;
        if (net != null && net.reset > now && net.count >= 40) return net;
        return null;
    }

    private void recordFailure(String ip, String username) {
        bump(byUser, ip + ":" + username);
        bump(byIp, ip);
    }

    private void clearFailure(String ip, String username) {
        byUser.remove(ip + ":" + username);
    }

    private void bump(Map<String, Attempt> map, String key) {
        long now = System.currentTimeMillis();
        Attempt attempt = map.get(key);
        if (attempt == null || attempt.reset <= now) {
            attempt = new Attempt();
            attempt.reset = now + 10 * 60 * 1000L;
            map.put(key, attempt);
        }
        attempt.count += 1;
    }

    private void startBeacon() {
        beaconThread = new Thread(() -> {
            try {
                beacon = new DatagramSocket();
                beacon.setBroadcast(true);
                while (!Thread.currentThread().isInterrupted()) {
                    JSONArray addresses = new JSONArray();
                    for (Lan.Addr addr : Lan.list(dataDir)) J.put(addresses, addr.json(false, getListeningPort()));
                    if (addresses.length() > 0) {
                        JSONObject payload = new JSONObject();
                        J.put(payload, "v", 1);
                        J.put(payload, "app", "porch");
                        J.put(payload, "port", getListeningPort());
                        J.put(payload, "https", false);
                        J.put(payload, "addresses", addresses);
                        byte[] bytes = payload.toString().getBytes(StandardCharsets.UTF_8);
                        DatagramPacket packet = new DatagramPacket(bytes, bytes.length, InetAddress.getByName("255.255.255.255"), 45878);
                        beacon.send(packet);
                    }
                    Thread.sleep(2500);
                }
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            } catch (Exception ignored) {
                // Discovery is optional. The address list in the app still works.
            }
        }, "porch-discovery");
        beaconThread.setDaemon(true);
        beaconThread.start();
    }

    private static Response json(Response.IStatus status, JSONObject body) {
        Response response = newFixedLengthResponse(status, "application/json", body.toString());
        response.addHeader("X-Content-Type-Options", "nosniff");
        return response;
    }

    private static JSONObject error(String message) {
        JSONObject object = new JSONObject();
        J.put(object, "error", message);
        return object;
    }

    private static Response.IStatus status(int code) {
        if (code == 400) return Response.Status.BAD_REQUEST;
        if (code == 401) return Response.Status.UNAUTHORIZED;
        if (code == 403) return Response.Status.FORBIDDEN;
        if (code == 404) return Response.Status.NOT_FOUND;
        if (code == 409) return Response.Status.CONFLICT;
        if (code == 413) return Response.Status.PAYLOAD_TOO_LARGE;
        if (code == 429) return Response.Status.TOO_MANY_REQUESTS;
        return Response.Status.INTERNAL_ERROR;
    }

    private static String mimeFor(String ext) {
        if ("jpg".equals(ext) || "jpeg".equals(ext)) return "image/jpeg";
        if ("png".equals(ext)) return "image/png";
        if ("gif".equals(ext)) return "image/gif";
        if ("webp".equals(ext)) return "image/webp";
        if ("pdf".equals(ext)) return "application/pdf";
        if ("txt".equals(ext)) return "text/plain";
        if ("csv".equals(ext)) return "text/csv";
        if ("zip".equals(ext)) return "application/zip";
        if ("doc".equals(ext)) return "application/msword";
        if ("docx".equals(ext)) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        if ("mp3".equals(ext)) return "audio/mpeg";
        if ("m4a".equals(ext)) return "audio/mp4";
        if ("wav".equals(ext)) return "audio/wav";
        if ("aac".equals(ext)) return "audio/aac";
        return null;
    }

    private static String mimeForFile(String name) {
        String ext = name.contains(".") ? name.substring(name.lastIndexOf('.') + 1).toLowerCase(Locale.US) : "";
        if ("html".equals(ext)) return "text/html; charset=utf-8";
        if ("css".equals(ext)) return "text/css; charset=utf-8";
        if ("js".equals(ext)) return "text/javascript; charset=utf-8";
        if ("svg".equals(ext)) return "image/svg+xml";
        if ("png".equals(ext)) return "image/png";
        if ("webmanifest".equals(ext)) return "application/manifest+json";
        if ("json".equals(ext)) return "application/json";
        String known = mimeFor(ext);
        return known == null ? "application/octet-stream" : known;
    }

    private final class Client extends NanoWSD.WebSocket {
        private long userId;

        Client(IHTTPSession handshake) {
            super(handshake);
        }

        @Override
        protected void onOpen() {
            String token = tokenOf(getHandshakeRequest());
            if (token == null) token = getHandshakeRequest().getParms().get("token");
            Row user = token == null ? null : logic.sessionUser(sha256(token));
            if (user == null) {
                try {
                    send("{\"type\":\"kicked\",\"reason\":\"Your session is no longer valid.\"}");
                    close(NanoWSD.WebSocketFrame.CloseCode.NormalClosure, "unauthorized", false);
                } catch (IOException ignored) {
                    // Ignore.
                }
                return;
            }
            userId = user.lng("id");
            Set<NanoWSD.WebSocket> mine = sockets.get(userId);
            if (mine == null) {
                mine = ConcurrentHashMap.newKeySet();
                sockets.put(userId, mine);
            }
            mine.add(this);
            List<long[]> delivered = logic.markDelivered(userId);
            Map<Long, JSONObject> groups = new HashMap<Long, JSONObject>();
            for (long[] row : delivered) {
                JSONObject group = groups.get(row[1]);
                if (group == null) {
                    group = new JSONObject();
                    J.put(group, "type", "delivered");
                    J.put(group, "conversationId", row[1]);
                    J.put(group, "userId", userId);
                    J.put(group, "deliveredAt", row[4]);
                    J.put(group, "messageIds", new JSONArray());
                    J.put(group, "senderId", row[2]);
                    groups.put(row[1], group);
                }
                JSONArray messageIds = group.optJSONArray("messageIds");
                if (messageIds != null) J.put(messageIds, row[0]);
            }
            for (JSONObject group : groups.values()) emit(group.optLong("senderId"), group);
            JSONObject ready = new JSONObject();
            J.put(ready, "type", "ready");
            J.put(ready, "userId", userId);
            J.put(ready, "presence", new JSONArray(sockets.keySet()));
            try {
                send(ready.toString());
            } catch (IOException ignored) {
                // Closed already.
            }
            broadcastPresence();
        }

        @Override
        protected void onClose(NanoWSD.WebSocketFrame.CloseCode code, String reason, boolean initiatedByRemote) {
            Set<NanoWSD.WebSocket> set = sockets.get(userId);
            if (set != null) {
                set.remove(this);
                if (set.isEmpty()) sockets.remove(userId);
            }
            broadcastPresence();
        }

        @Override
        protected void onMessage(NanoWSD.WebSocketFrame message) {
            try {
                JSONObject payload = new JSONObject(message.getTextPayload());
                String type = payload.optString("type");
                if ("ping".equals(type)) {
                    send("{\"type\":\"pong\"}");
                    return;
                }
                if ("typing".equals(type)) {
                    long conversationId = payload.optLong("conversationId");
                    if (!logic.memberIds(conversationId).contains(userId)) return;
                    JSONObject event = new JSONObject();
                    J.put(event, "type", "typing");
                    J.put(event, "conversationId", conversationId);
                    J.put(event, "userId", userId);
                    Row user = logic.userById(userId);
                    J.put(event, "displayName", user == null ? "Someone" : user.str("display_name"));
                    J.put(event, "isTyping", payload.optBoolean("isTyping"));
                    for (Long id : logic.memberIds(conversationId)) if (id != userId) emit(id.longValue(), event);
                }
            } catch (Exception ignored) {
                // Ignore malformed frames.
            }
        }

        @Override
        protected void onPong(NanoWSD.WebSocketFrame pong) {}

        @Override
        protected void onException(IOException exception) {}
    }

    private static final class Attempt {
        int count;
        long reset;

        int retryAfter() {
            return (int) Math.max(1, (reset - System.currentTimeMillis() + 999) / 1000);
        }
    }
}
