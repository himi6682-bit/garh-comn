package chat.porch.server;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

public final class PorchLogic {
    private static final String[] COLORS = {
            "#ef6a32", "#e2a15a", "#c9b458", "#8fce6b", "#5fbfa8",
            "#6cb6e0", "#7f8fdb", "#c58bdb", "#e07aa0", "#d97b63"
    };

    private final Sql db;

    public PorchLogic(Sql db) {
        this.db = db;
    }

    public static String colorFor(String username) {
        long hash = 0;
        for (int i = 0; i < username.length(); i++) {
            hash = (hash * 33 + username.charAt(i)) & 0xffffffffL;
        }
        return COLORS[(int) (hash % COLORS.length)];
    }

    public void ensureEveryone() {
        Row everyone = db.queryOne("SELECT id FROM conversations WHERE is_everyone = 1");
        if (everyone == null) {
            db.insert("INSERT INTO conversations (type, name, created_by, is_everyone, created_at) VALUES ('group', 'Everyone', NULL, 1, ?)",
                    System.currentTimeMillis());
        }
        for (Row user : db.query("SELECT id FROM users")) addUserToEveryone(user.lng("id"));
    }

    public void addUserToEveryone(long userId) {
        Row everyone = db.queryOne("SELECT id FROM conversations WHERE is_everyone = 1");
        if (everyone == null) return;
        Row existing = db.queryOne("SELECT 1 AS ok FROM conversation_members WHERE conversation_id = ? AND user_id = ?",
                everyone.lng("id"), userId);
        if (existing != null) return;
        Row max = db.queryOne("SELECT COALESCE(MAX(id), 0) AS id FROM messages WHERE conversation_id = ?", everyone.lng("id"));
        db.insert("INSERT INTO conversation_members (conversation_id, user_id, joined_at, last_read_message_id) VALUES (?, ?, ?, ?)",
                everyone.lng("id"), userId, System.currentTimeMillis(), max == null ? 0 : max.lng("id"));
    }

    public JSONObject createUser(String username, String displayName, String passwordHash, String role) {
        try {
            long id = db.insert(
                    "INSERT INTO users (username, display_name, password_hash, role, disabled, color, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)",
                    username, displayName, passwordHash, role, colorFor(username), System.currentTimeMillis());
            addUserToEveryone(id);
            return userJson(db.queryOne("SELECT * FROM users WHERE id = ?", id));
        } catch (RuntimeException error) {
            if (String.valueOf(error.getMessage()).contains("UNIQUE")) throw new HttpError(409, "That username is taken.");
            throw error;
        }
    }

    public Row userByUsername(String username) {
        return db.queryOne("SELECT * FROM users WHERE username = ?", username);
    }

    public Row userById(long id) {
        return db.queryOne("SELECT * FROM users WHERE id = ?", id);
    }

    public boolean anyUser() {
        return db.queryOne("SELECT id FROM users LIMIT 1") != null;
    }

    public JSONObject userJson(Row row) {
        if (row == null) return null;
        JSONObject object = new JSONObject();
        J.put(object, "id", row.lng("id"));
        J.put(object, "username", row.str("username"));
        J.put(object, "displayName", row.str("display_name"));
        J.put(object, "role", row.str("role"));
        J.put(object, "disabled", row.bool("disabled"));
        J.put(object, "color", row.str("color"));
        return object;
    }

    public JSONArray listUsers(boolean includeDisabled) {
        List<Row> rows = includeDisabled
                ? db.query("SELECT * FROM users ORDER BY role DESC, display_name COLLATE NOCASE")
                : db.query("SELECT * FROM users WHERE disabled = 0 ORDER BY display_name COLLATE NOCASE");
        JSONArray array = new JSONArray();
        for (Row row : rows) J.put(array, userJson(row));
        return array;
    }

    public void setPassword(long userId, String hash) {
        db.exec("UPDATE users SET password_hash = ? WHERE id = ?", hash, userId);
    }

    public JSONObject setDisabled(long userId, boolean disabled) {
        Row user = userById(userId);
        if (user == null) throw new HttpError(404, "No account with that id.");
        if ("admin".equals(user.str("role"))) throw new HttpError(400, "The admin account stays active.");
        db.exec("UPDATE users SET disabled = ? WHERE id = ?", disabled ? 1 : 0, userId);
        return userJson(userById(userId));
    }

    public void deleteUser(long userId) {
        Row user = userById(userId);
        if (user == null) throw new HttpError(404, "No account with that id.");
        if ("admin".equals(user.str("role"))) throw new HttpError(400, "The admin account cannot be deleted.");
        db.transaction(() -> {
            db.exec("DELETE FROM receipts WHERE user_id = ?", userId);
            db.exec("DELETE FROM sessions WHERE user_id = ?", userId);
            db.exec("DELETE FROM users WHERE id = ?", userId);
        });
    }

    public void createSession(long userId, String tokenHash, long expiresAt) {
        db.insert("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
                tokenHash, userId, System.currentTimeMillis(), expiresAt);
    }

    public Row sessionUser(String tokenHash) {
        if (tokenHash == null) return null;
        return db.queryOne("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled = 0",
                tokenHash, System.currentTimeMillis());
    }

    public void deleteSession(String tokenHash) {
        if (tokenHash != null) db.exec("DELETE FROM sessions WHERE token_hash = ?", tokenHash);
    }

    public void deleteUserSessions(long userId, String exceptHash) {
        if (exceptHash == null) db.exec("DELETE FROM sessions WHERE user_id = ?", userId);
        else db.exec("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?", userId, exceptHash);
    }

    public List<Long> memberIds(long conversationId) {
        List<Long> ids = new ArrayList<Long>();
        for (Row row : db.query("SELECT user_id FROM conversation_members WHERE conversation_id = ?", conversationId)) {
            ids.add(row.lng("user_id"));
        }
        return ids;
    }

    public JSONObject buildConversation(long conversationId, long userId) {
        Row conv = db.queryOne("SELECT * FROM conversations WHERE id = ?", conversationId);
        if (conv == null) return null;
        Row member = db.queryOne("SELECT last_read_message_id FROM conversation_members WHERE conversation_id = ? AND user_id = ?",
                conversationId, userId);
        if (member == null) return null;
        JSONArray members = new JSONArray();
        for (Row row : db.query("SELECT u.* FROM users u JOIN conversation_members cm ON cm.user_id = u.id WHERE cm.conversation_id = ? ORDER BY u.display_name COLLATE NOCASE", conversationId)) {
            J.put(members, userJson(row));
        }
        Row last = db.queryOne("SELECT m.*, u.display_name AS sender_name FROM messages m LEFT JOIN users u ON u.id = m.sender_id WHERE m.conversation_id = ? ORDER BY m.id DESC LIMIT 1", conversationId);
        Row unread = db.queryOne("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND id > ? AND IFNULL(sender_id, -1) != ?",
                conversationId, member.lng("last_read_message_id"), userId);
        JSONObject object = new JSONObject();
        J.put(object, "id", conv.lng("id"));
        J.put(object, "type", conv.str("type"));
        J.put(object, "name", conv.isNull("name") ? JSONObject.NULL : conv.str("name"));
        J.put(object, "isEveryone", conv.bool("is_everyone"));
        J.put(object, "createdAt", conv.lng("created_at"));
        J.put(object, "members", members);
        J.put(object, "lastMessage", last == null ? JSONObject.NULL : preview(last));
        J.put(object, "unreadCount", unread == null ? 0 : unread.lng("n"));
        J.put(object, "lastReadMessageId", member.lng("last_read_message_id"));
        J.put(object, "updatedAt", last == null ? conv.lng("created_at") : last.lng("created_at"));
        return object;
    }

    public JSONArray listConversations(long userId) {
        List<JSONObject> rows = new ArrayList<JSONObject>();
        for (Row row : db.query("SELECT conversation_id FROM conversation_members WHERE user_id = ?", userId)) {
            JSONObject conversation = buildConversation(row.lng("conversation_id"), userId);
            if (conversation != null) rows.add(conversation);
        }
        Collections.sort(rows, new Comparator<JSONObject>() {
            @Override
            public int compare(JSONObject a, JSONObject b) {
                if (a.optBoolean("isEveryone") != b.optBoolean("isEveryone")) return a.optBoolean("isEveryone") ? -1 : 1;
                return Long.compare(b.optLong("updatedAt"), a.optLong("updatedAt"));
            }
        });
        JSONArray array = new JSONArray();
        for (JSONObject row : rows) J.put(array, row);
        return array;
    }

    public long findOrCreateDirect(long userId, long otherId) {
        if (userId == otherId) throw new HttpError(400, "Choose someone else.");
        Row other = userById(otherId);
        if (other == null || other.bool("disabled")) throw new HttpError(400, "That person is not available.");
        Row existing = db.queryOne("SELECT c.id FROM conversations c JOIN conversation_members a ON a.conversation_id = c.id AND a.user_id = ? JOIN conversation_members b ON b.conversation_id = c.id AND b.user_id = ? WHERE c.type = 'direct' ORDER BY c.id LIMIT 1",
                userId, otherId);
        if (existing != null) return existing.lng("id");
        long now = System.currentTimeMillis();
        long[] created = new long[1];
        db.transaction(() -> {
            created[0] = db.insert("INSERT INTO conversations (type, name, created_by, is_everyone, created_at) VALUES ('direct', NULL, ?, 0, ?)", userId, now);
            db.insert("INSERT INTO conversation_members (conversation_id, user_id, joined_at, last_read_message_id) VALUES (?, ?, ?, 0)", created[0], userId, now);
            db.insert("INSERT INTO conversation_members (conversation_id, user_id, joined_at, last_read_message_id) VALUES (?, ?, ?, 0)", created[0], otherId, now);
        });
        return created[0];
    }

    public long createGroup(String name, long creatorId, List<Long> memberIds) {
        Set<Long> ids = new HashSet<Long>();
        ids.add(creatorId);
        ids.addAll(memberIds);
        if (ids.size() < 2) throw new HttpError(400, "Add at least one other person to the group.");
        for (Long id : ids) {
            Row user = userById(id);
            if (user == null || user.bool("disabled")) throw new HttpError(400, "Every person in the group needs an active account.");
        }
        long now = System.currentTimeMillis();
        long[] created = new long[1];
        db.transaction(() -> {
            created[0] = db.insert("INSERT INTO conversations (type, name, created_by, is_everyone, created_at) VALUES ('group', ?, ?, 0, ?)", name, creatorId, now);
            for (Long id : ids) {
                db.insert("INSERT INTO conversation_members (conversation_id, user_id, joined_at, last_read_message_id) VALUES (?, ?, ?, 0)", created[0], id, now);
            }
        });
        return created[0];
    }

    public JSONObject updateGroup(long conversationId, long actorId, String name, List<Long> memberIds) {
        Row conv = requireGroup(conversationId);
        if (conv.bool("is_everyone")) throw new HttpError(400, "Everyone cannot be changed.");
        List<Long> previous = memberIds(conversationId);
        List<Long> next = previous;
        if (memberIds != null) {
            Set<Long> unique = new HashSet<Long>();
            unique.add(actorId);
            for (Long id : memberIds) if (id != null && id > 0) unique.add(id);
            next = new ArrayList<Long>(unique);
            if (next.size() < 2) throw new HttpError(400, "Keep at least one other person in the group.");
            for (Long id : next) {
                Row user = userById(id);
                boolean already = previous.contains(id);
                if (user == null || (!already && user.bool("disabled"))) {
                    throw new HttpError(400, "Every person in the group needs an active account.");
                }
            }
        }
        List<Long> removed = new ArrayList<Long>();
        List<Long> added = new ArrayList<Long>();
        for (Long id : previous) if (!next.contains(id)) removed.add(id);
        for (Long id : next) if (!previous.contains(id)) added.add(id);
        final String finalName = name;
        db.transaction(() -> {
            if (finalName != null) db.exec("UPDATE conversations SET name = ? WHERE id = ?", finalName, conversationId);
            long now = System.currentTimeMillis();
            for (Long id : removed) db.exec("DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?", conversationId, id);
            for (Long id : added) {
                db.insert("INSERT INTO conversation_members (conversation_id, user_id, joined_at, last_read_message_id) VALUES (?, ?, ?, 0)", conversationId, id, now);
            }
        });
        JSONObject change = new JSONObject();
        J.put(change, "removed", longs(removed));
        J.put(change, "added", longs(added));
        return change;
    }

    public JSONObject deleteGroup(long conversationId) {
        Row conv = requireGroup(conversationId);
        if (conv.bool("is_everyone")) throw new HttpError(400, "Everyone cannot be deleted.");
        List<Long> ids = memberIds(conversationId);
        db.transaction(() -> {
            db.exec("DELETE FROM receipts WHERE message_id IN (SELECT id FROM messages WHERE conversation_id = ?)", conversationId);
            db.exec("DELETE FROM messages WHERE conversation_id = ?", conversationId);
            db.exec("DELETE FROM conversation_members WHERE conversation_id = ?", conversationId);
            db.exec("DELETE FROM conversations WHERE id = ?", conversationId);
        });
        JSONObject result = new JSONObject();
        J.put(result, "name", conv.str("name"));
        J.put(result, "memberIds", longs(ids));
        return result;
    }

    private Row requireGroup(long conversationId) {
        Row conv = db.queryOne("SELECT * FROM conversations WHERE id = ?", conversationId);
        if (conv == null) throw new HttpError(404, "That conversation is gone.");
        if (!"group".equals(conv.str("type"))) throw new HttpError(400, "Only a group can be changed.");
        return conv;
    }

    private static JSONArray longs(List<Long> ids) {
        JSONArray array = new JSONArray();
        for (Long id : ids) J.put(array, id);
        return array;
    }

    public JSONObject messageJson(long messageId) {
        Row row = db.queryOne("SELECT m.*, u.display_name AS sender_name, u.color AS sender_color FROM messages m LEFT JOIN users u ON u.id = m.sender_id WHERE m.id = ?", messageId);
        if (row == null) return null;
        return messageJson(row, db.query("SELECT * FROM receipts WHERE message_id = ?", messageId));
    }

    public JSONObject listMessages(long conversationId, long userId, long before, int limit) {
        Row member = db.queryOne("SELECT 1 AS ok FROM conversation_members WHERE conversation_id = ? AND user_id = ?", conversationId, userId);
        if (member == null) throw new HttpError(403, "You are not in that conversation.");
        int cap = Math.min(Math.max(limit, 1), 100);
        List<Row> rows = before > 0
                ? db.query("SELECT m.*, u.display_name AS sender_name, u.color AS sender_color FROM messages m LEFT JOIN users u ON u.id = m.sender_id WHERE m.conversation_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT ?", conversationId, before, cap + 1)
                : db.query("SELECT m.*, u.display_name AS sender_name, u.color AS sender_color FROM messages m LEFT JOIN users u ON u.id = m.sender_id WHERE m.conversation_id = ? ORDER BY m.id DESC LIMIT ?", conversationId, cap + 1);
        boolean hasMore = rows.size() > cap;
        if (hasMore) rows = rows.subList(0, cap);
        Collections.reverse(rows);
        JSONArray messages = new JSONArray();
        for (Row row : rows) {
            J.put(messages, messageJson(row, db.query("SELECT * FROM receipts WHERE message_id = ?", row.lng("id"))));
        }
        JSONObject object = new JSONObject();
        J.put(object, "messages", messages);
        J.put(object, "hasMore", hasMore);
        return object;
    }

    public JSONObject createMessage(long conversationId, long senderId, String body, String attachmentId, String attachmentName, String attachmentMime, Long attachmentSize, Set<Long> online) {
        List<Long> members = memberIds(conversationId);
        if (!members.contains(senderId)) throw new HttpError(403, "You are not in that conversation.");
        long now = System.currentTimeMillis();
        long[] id = new long[1];
        db.transaction(() -> {
            id[0] = db.insert("INSERT INTO messages (conversation_id, sender_id, body, attachment_id, attachment_name, attachment_mime, attachment_size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    conversationId, senderId, body == null ? "" : body, attachmentId, attachmentName, attachmentMime, attachmentSize, now);
            for (Long member : members) {
                if (member == senderId) continue;
                Long delivered = online.contains(member) ? now : null;
                db.insert("INSERT INTO receipts (message_id, user_id, delivered_at, read_at) VALUES (?, ?, ?, NULL)", id[0], member, delivered);
            }
        });
        return messageJson(id[0]);
    }

    public List<long[]> markDelivered(long userId) {
        long now = System.currentTimeMillis();
        List<Row> pending = db.query("SELECT r.message_id, m.conversation_id, m.sender_id FROM receipts r JOIN messages m ON m.id = r.message_id WHERE r.user_id = ? AND r.delivered_at IS NULL", userId);
        if (pending.isEmpty()) return new ArrayList<long[]>();
        db.exec("UPDATE receipts SET delivered_at = ? WHERE user_id = ? AND delivered_at IS NULL", now, userId);
        List<long[]> rows = new ArrayList<long[]>();
        for (Row row : pending) {
            rows.add(new long[] {row.lng("message_id"), row.lng("conversation_id"), row.lng("sender_id"), userId, now});
        }
        return rows;
    }

    public JSONObject markRead(long userId, long conversationId, long messageId) {
        Row member = db.queryOne("SELECT last_read_message_id FROM conversation_members WHERE conversation_id = ? AND user_id = ?", conversationId, userId);
        if (member == null) throw new HttpError(403, "You are not in that conversation.");
        Row message = db.queryOne("SELECT id FROM messages WHERE id = ? AND conversation_id = ?", messageId, conversationId);
        if (message == null) throw new HttpError(400, "That message is not in this conversation.");
        long now = System.currentTimeMillis();
        long target = Math.max(member.lng("last_read_message_id"), messageId);
        db.transaction(() -> {
            db.exec("UPDATE conversation_members SET last_read_message_id = ? WHERE conversation_id = ? AND user_id = ?", target, conversationId, userId);
            db.exec("UPDATE receipts SET read_at = ?, delivered_at = COALESCE(delivered_at, ?) WHERE user_id = ? AND read_at IS NULL AND message_id IN (SELECT id FROM messages WHERE conversation_id = ? AND id <= ? AND IFNULL(sender_id, -1) != ?)",
                    now, now, userId, conversationId, messageId, userId);
        });
        JSONArray ids = new JSONArray();
        for (Row row : db.query("SELECT message_id FROM receipts WHERE user_id = ? AND read_at = ?", userId, now)) J.put(ids, row.lng("message_id"));
        JSONObject object = new JSONObject();
        J.put(object, "ok", true);
        J.put(object, "conversationId", conversationId);
        J.put(object, "userId", userId);
        J.put(object, "messageIds", ids);
        J.put(object, "readAt", now);
        return object;
    }

    public Row fileForUser(long userId, String attachmentId) {
        return db.queryOne("SELECT m.* FROM messages m JOIN conversation_members cm ON cm.conversation_id = m.conversation_id WHERE m.attachment_id = ? AND cm.user_id = ?",
                attachmentId, userId);
    }

    private JSONObject preview(Row row) {
        JSONObject object = new JSONObject();
        J.put(object, "id", row.lng("id"));
        J.put(object, "conversationId", row.lng("conversation_id"));
        J.put(object, "senderId", row.isNull("sender_id") ? JSONObject.NULL : row.lng("sender_id"));
        J.put(object, "senderName", row.str("sender_name") == null ? "Deleted user" : row.str("sender_name"));
        J.put(object, "body", row.str("body") == null ? "" : row.str("body"));
        J.put(object, "createdAt", row.lng("created_at"));
        J.put(object, "attachmentName", row.isNull("attachment_name") ? JSONObject.NULL : row.str("attachment_name"));
        J.put(object, "attachmentMime", row.isNull("attachment_mime") ? JSONObject.NULL : row.str("attachment_mime"));
        return object;
    }

    private JSONObject messageJson(Row row, List<Row> receipts) {
        JSONObject object = new JSONObject();
        J.put(object, "id", row.lng("id"));
        J.put(object, "conversationId", row.lng("conversation_id"));
        J.put(object, "senderId", row.isNull("sender_id") ? JSONObject.NULL : row.lng("sender_id"));
        J.put(object, "senderName", row.str("sender_name") == null ? "Deleted user" : row.str("sender_name"));
        J.put(object, "senderColor", row.str("sender_color") == null ? "#7c7468" : row.str("sender_color"));
        J.put(object, "body", row.str("body") == null ? "" : row.str("body"));
        J.put(object, "createdAt", row.lng("created_at"));
        if (row.isNull("attachment_id")) J.put(object, "attachment", JSONObject.NULL);
        else {
            JSONObject attachment = new JSONObject();
            J.put(attachment, "id", row.str("attachment_id"));
            J.put(attachment, "name", row.str("attachment_name"));
            J.put(attachment, "mime", row.str("attachment_mime"));
            J.put(attachment, "size", row.lng("attachment_size"));
            J.put(object, "attachment", attachment);
        }
        JSONArray receiptArray = new JSONArray();
        for (Row receipt : receipts) {
            JSONObject item = new JSONObject();
            J.put(item, "userId", receipt.lng("user_id"));
            J.put(item, "deliveredAt", receipt.isNull("delivered_at") ? JSONObject.NULL : receipt.lng("delivered_at"));
            J.put(item, "readAt", receipt.isNull("read_at") ? JSONObject.NULL : receipt.lng("read_at"));
            J.put(receiptArray, item);
        }
        J.put(object, "receipts", receiptArray);
        return object;
    }
}
