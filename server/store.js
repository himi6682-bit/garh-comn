import { HttpError } from "./errors.js";
import { colorFor } from "./auth.js";

export function toUser(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    disabled: !!Number(row.disabled),
    color: row.color,
  };
}

function attachmentOf(row) {
  if (!row.attachment_id) return null;
  return {
    id: row.attachment_id,
    name: row.attachment_name,
    mime: row.attachment_mime,
    size: Number(row.attachment_size || 0),
  };
}

export function toMessage(row, receipts = []) {
  return {
    id: Number(row.id),
    conversationId: Number(row.conversation_id),
    senderId: row.sender_id == null ? null : Number(row.sender_id),
    senderName: row.sender_name || "Deleted user",
    senderColor: row.sender_color || "#7c7468",
    body: row.body || "",
    createdAt: Number(row.created_at),
    attachment: attachmentOf(row),
    receipts: receipts.map((receipt) => ({
      userId: Number(receipt.user_id ?? receipt.userId),
      deliveredAt: (receipt.delivered_at ?? receipt.deliveredAt) == null ? null : Number(receipt.delivered_at ?? receipt.deliveredAt),
      readAt: (receipt.read_at ?? receipt.readAt) == null ? null : Number(receipt.read_at ?? receipt.readAt),
    })),
  };
}

function previewMessage(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    conversationId: Number(row.conversation_id),
    senderId: row.sender_id == null ? null : Number(row.sender_id),
    senderName: row.sender_name || "Deleted user",
    body: row.body || "",
    createdAt: Number(row.created_at),
    attachmentName: row.attachment_name || null,
    attachmentMime: row.attachment_mime || null,
  };
}

export function ensureEveryone(db) {
  let everyone = db.get("SELECT id FROM conversations WHERE is_everyone = 1");
  const now = Date.now();
  if (!everyone) {
    const created = db.run(
      "INSERT INTO conversations (type, name, created_by, is_everyone, created_at) VALUES ('group', 'Everyone', NULL, 1, ?)",
      [now],
    );
    everyone = { id: created.id };
  }
  const users = db.all("SELECT id FROM users");
  for (const user of users) addUserToEveryone(db, Number(user.id));
  return Number(everyone.id);
}

export function addUserToEveryone(db, userId) {
  const everyone = db.get("SELECT id FROM conversations WHERE is_everyone = 1");
  if (!everyone) return;
  const existing = db.get(
    "SELECT 1 AS ok FROM conversation_members WHERE conversation_id = ? AND user_id = ?",
    [everyone.id, userId],
  );
  if (existing) return;
  const max = db.get("SELECT COALESCE(MAX(id), 0) AS id FROM messages WHERE conversation_id = ?", [everyone.id]);
  db.run(
    "INSERT INTO conversation_members (conversation_id, user_id, joined_at, last_read_message_id) VALUES (?, ?, ?, ?)",
    [everyone.id, userId, Date.now(), Number(max?.id || 0)],
  );
}

export function createUser(db, { username, displayName, passwordHash, role }) {
  const now = Date.now();
  try {
    const created = db.run(
      "INSERT INTO users (username, display_name, password_hash, role, disabled, color, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)",
      [username, displayName, passwordHash, role, colorFor(username), now],
    );
    addUserToEveryone(db, created.id);
    return getUser(db, created.id);
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) throw new HttpError(409, "That username is taken.");
    throw error;
  }
}

export function getUser(db, id) {
  return db.get("SELECT * FROM users WHERE id = ?", [id]);
}

export function getUserByUsername(db, username) {
  return db.get("SELECT * FROM users WHERE username = ?", [username]);
}

export function listUsers(db, { includeDisabled = false } = {}) {
  const sql = includeDisabled
    ? "SELECT * FROM users ORDER BY role DESC, display_name COLLATE NOCASE"
    : "SELECT * FROM users WHERE disabled = 0 ORDER BY display_name COLLATE NOCASE";
  return db.all(sql).map(toUser);
}

export function setPasswordHash(db, userId, passwordHash) {
  db.run("UPDATE users SET password_hash = ? WHERE id = ?", [passwordHash, userId]);
}

export function setDisabled(db, userId, disabled) {
  const user = getUser(db, userId);
  if (!user) throw new HttpError(404, "No account with that id.");
  if (user.role === "admin") throw new HttpError(400, "The admin account stays active.");
  db.run("UPDATE users SET disabled = ? WHERE id = ?", [disabled ? 1 : 0, userId]);
  return getUser(db, userId);
}

export function deleteUser(db, userId) {
  const user = getUser(db, userId);
  if (!user) throw new HttpError(404, "No account with that id.");
  if (user.role === "admin") throw new HttpError(400, "The admin account cannot be deleted.");
  db.transaction(() => {
    db.run("DELETE FROM receipts WHERE user_id = ?", [userId]);
    db.run("DELETE FROM sessions WHERE user_id = ?", [userId]);
    db.run("DELETE FROM users WHERE id = ?", [userId]);
  });
}

export function createSession(db, userId, tokenHash, expiresAt) {
  const now = Date.now();
  db.run("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)", [
    tokenHash,
    userId,
    now,
    expiresAt,
  ]);
}

export function getSessionUser(db, tokenHash) {
  if (!tokenHash) return null;
  const row = db.get(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled = 0`,
    [tokenHash, Date.now()],
  );
  return row;
}

export function deleteSession(db, tokenHash) {
  if (!tokenHash) return;
  db.run("DELETE FROM sessions WHERE token_hash = ?", [tokenHash]);
}

export function deleteUserSessions(db, userId, exceptHash = null) {
  if (exceptHash) {
    db.run("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?", [userId, exceptHash]);
  } else {
    db.run("DELETE FROM sessions WHERE user_id = ?", [userId]);
  }
}

export function buildConversation(db, conversationId, userId) {
  const conv = db.get("SELECT * FROM conversations WHERE id = ?", [conversationId]);
  if (!conv) return null;
  const member = db.get(
    "SELECT last_read_message_id FROM conversation_members WHERE conversation_id = ? AND user_id = ?",
    [conversationId, userId],
  );
  if (!member) return null;
  const members = db.all(
    `SELECT u.* FROM users u
     JOIN conversation_members cm ON cm.user_id = u.id
     WHERE cm.conversation_id = ?
     ORDER BY u.display_name COLLATE NOCASE`,
    [conversationId],
  );
  const last = db.get(
    `SELECT m.*, u.display_name AS sender_name FROM messages m
     LEFT JOIN users u ON u.id = m.sender_id
     WHERE m.conversation_id = ? ORDER BY m.id DESC LIMIT 1`,
    [conversationId],
  );
  const unread = db.get(
    "SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND id > ? AND IFNULL(sender_id, -1) != ?",
    [conversationId, Number(member.last_read_message_id) || 0, userId],
  );
  return {
    id: Number(conv.id),
    type: conv.type,
    name: conv.name,
    isEveryone: !!Number(conv.is_everyone),
    createdAt: Number(conv.created_at),
    members: members.map(toUser),
    lastMessage: previewMessage(last),
    unreadCount: Number(unread?.n || 0),
    lastReadMessageId: Number(member.last_read_message_id) || 0,
    updatedAt: last ? Number(last.created_at) : Number(conv.created_at),
  };
}

export function listConversations(db, userId) {
  const rows = db.all(
    "SELECT conversation_id FROM conversation_members WHERE user_id = ? ORDER BY conversation_id",
    [userId],
  );
  return rows
    .map((row) => buildConversation(db, Number(row.conversation_id), userId))
    .filter(Boolean)
    .sort((a, b) => {
      if (a.isEveryone !== b.isEveryone) return a.isEveryone ? -1 : 1;
      return b.updatedAt - a.updatedAt;
    });
}

export function memberIds(db, conversationId) {
  return db.all("SELECT user_id FROM conversation_members WHERE conversation_id = ?", [conversationId]).map((row) => Number(row.user_id));
}

export function findOrCreateDirect(db, userId, otherId) {
  if (Number(userId) === Number(otherId)) throw new HttpError(400, "Choose someone else.");
  const other = getUser(db, otherId);
  if (!other || Number(other.disabled)) throw new HttpError(400, "That person is not available.");
  const existing = db.get(
    `SELECT c.id FROM conversations c
     JOIN conversation_members a ON a.conversation_id = c.id AND a.user_id = ?
     JOIN conversation_members b ON b.conversation_id = c.id AND b.user_id = ?
     WHERE c.type = 'direct'
     ORDER BY c.id LIMIT 1`,
    [userId, otherId],
  );
  if (existing) return Number(existing.id);
  const now = Date.now();
  return db.transaction(() => {
    const created = db.run(
      "INSERT INTO conversations (type, name, created_by, is_everyone, created_at) VALUES ('direct', NULL, ?, 0, ?)",
      [userId, now],
    );
    db.run(
      "INSERT INTO conversation_members (conversation_id, user_id, joined_at, last_read_message_id) VALUES (?, ?, ?, 0)",
      [created.id, userId, now],
    );
    db.run(
      "INSERT INTO conversation_members (conversation_id, user_id, joined_at, last_read_message_id) VALUES (?, ?, ?, 0)",
      [created.id, otherId, now],
    );
    return created.id;
  });
}

function requireGroup(db, conversationId, verb) {
  const conv = db.get("SELECT * FROM conversations WHERE id = ?", [conversationId]);
  if (!conv) throw new HttpError(404, "That conversation is gone.");
  if (conv.type !== "group") throw new HttpError(400, `Only a group can be ${verb}.`);
  return conv;
}

export function updateGroup(db, conversationId, { name, memberIds: rawIds, actorId }) {
  const conv = requireGroup(db, conversationId, "changed");
  if (Number(conv.is_everyone)) throw new HttpError(400, "Everyone cannot be changed.");
  const previous = memberIds(db, conversationId);
  let nextIds = previous;
  if (rawIds) {
    nextIds = [...new Set([Number(actorId), ...rawIds.map(Number).filter((id) => id > 0)])];
    if (nextIds.length < 2) throw new HttpError(400, "Keep at least one other person in the group.");
    for (const id of nextIds) {
      const user = getUser(db, id);
      const already = previous.includes(id);
      if (!user || (!already && Number(user.disabled))) {
        throw new HttpError(400, "Every person in the group needs an active account.");
      }
    }
  }
  const removed = previous.filter((id) => !nextIds.includes(id));
  const added = nextIds.filter((id) => !previous.includes(id));
  db.transaction(() => {
    if (name != null) db.run("UPDATE conversations SET name = ? WHERE id = ?", [name, conversationId]);
    const now = Date.now();
    for (const id of removed) {
      db.run("DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?", [conversationId, id]);
    }
    for (const id of added) {
      db.run(
        "INSERT INTO conversation_members (conversation_id, user_id, joined_at, last_read_message_id) VALUES (?, ?, ?, 0)",
        [conversationId, id, now],
      );
    }
  });
  return { removed, added };
}

export function deleteGroup(db, conversationId) {
  const conv = requireGroup(db, conversationId, "deleted");
  if (Number(conv.is_everyone)) throw new HttpError(400, "Everyone cannot be deleted.");
  const ids = memberIds(db, conversationId);
  const files = db.all(
    "SELECT attachment_id FROM messages WHERE conversation_id = ? AND attachment_id IS NOT NULL",
    [conversationId],
  ).map((row) => row.attachment_id);
  db.transaction(() => {
    db.run(
      "DELETE FROM receipts WHERE message_id IN (SELECT id FROM messages WHERE conversation_id = ?)",
      [conversationId],
    );
    db.run("DELETE FROM messages WHERE conversation_id = ?", [conversationId]);
    db.run("DELETE FROM conversation_members WHERE conversation_id = ?", [conversationId]);
    db.run("DELETE FROM conversations WHERE id = ?", [conversationId]);
  });
  return { name: conv.name, memberIds: ids, attachmentIds: files };
}

export function createGroup(db, { name, creatorId, memberIds: rawIds }) {
  const ids = [...new Set([Number(creatorId), ...rawIds.map(Number)])];
  if (ids.length < 2) throw new HttpError(400, "Add at least one other person to the group.");
  for (const id of ids) {
    const user = getUser(db, id);
    if (!user || Number(user.disabled)) throw new HttpError(400, "Every person in the group needs an active account.");
  }
  const now = Date.now();
  return db.transaction(() => {
    const created = db.run(
      "INSERT INTO conversations (type, name, created_by, is_everyone, created_at) VALUES ('group', ?, ?, 0, ?)",
      [name, creatorId, now],
    );
    for (const id of ids) {
      db.run(
        "INSERT INTO conversation_members (conversation_id, user_id, joined_at, last_read_message_id) VALUES (?, ?, ?, 0)",
        [created.id, id, now],
      );
    }
    return created.id;
  });
}

function loadReceipts(db, messageIds) {
  const grouped = new Map();
  if (!messageIds.length) return grouped;
  const marks = messageIds.map(() => "?").join(",");
  const rows = db.all(`SELECT * FROM receipts WHERE message_id IN (${marks})`, messageIds);
  for (const row of rows) {
    const key = Number(row.message_id);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  return grouped;
}

export function getMessage(db, messageId) {
  const row = db.get(
    `SELECT m.*, u.display_name AS sender_name, u.color AS sender_color
     FROM messages m LEFT JOIN users u ON u.id = m.sender_id WHERE m.id = ?`,
    [messageId],
  );
  if (!row) return null;
  const receipts = loadReceipts(db, [Number(row.id)]);
  return toMessage(row, receipts.get(Number(row.id)) || []);
}

export function listMessages(db, conversationId, userId, { before = 0, limit = 50 } = {}) {
  const member = db.get(
    "SELECT 1 AS ok FROM conversation_members WHERE conversation_id = ? AND user_id = ?",
    [conversationId, userId],
  );
  if (!member) throw new HttpError(403, "You are not in that conversation.");
  const cap = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const params = [conversationId];
  let where = "m.conversation_id = ?";
  if (before) {
    where += " AND m.id < ?";
    params.push(Number(before));
  }
  params.push(cap + 1);
  const rows = db.all(
    `SELECT m.*, u.display_name AS sender_name, u.color AS sender_color
     FROM messages m LEFT JOIN users u ON u.id = m.sender_id
     WHERE ${where} ORDER BY m.id DESC LIMIT ?`,
    params,
  );
  const hasMore = rows.length > cap;
  const slice = rows.slice(0, cap).reverse();
  const receipts = loadReceipts(db, slice.map((row) => Number(row.id)));
  return {
    messages: slice.map((row) => toMessage(row, receipts.get(Number(row.id)) || [])),
    hasMore,
  };
}

export function createMessage(db, { conversationId, senderId, body, attachment, onlineUserIds }) {
  const members = memberIds(db, conversationId);
  if (!members.includes(Number(senderId))) throw new HttpError(403, "You are not in that conversation.");
  const now = Date.now();
  const messageId = db.transaction(() => {
    const created = db.run(
      `INSERT INTO messages (conversation_id, sender_id, body, attachment_id, attachment_name, attachment_mime, attachment_size, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        conversationId,
        senderId,
        body || "",
        attachment?.id || null,
        attachment?.name || null,
        attachment?.mime || null,
        attachment?.size ?? null,
        now,
      ],
    );
    for (const id of members) {
      if (id === Number(senderId)) continue;
      const delivered = onlineUserIds.has(id) ? now : null;
      db.run("INSERT INTO receipts (message_id, user_id, delivered_at, read_at) VALUES (?, ?, ?, NULL)", [
        created.id,
        id,
        delivered,
      ]);
    }
    return created.id;
  });
  return getMessage(db, messageId);
}

export function markDelivered(db, userId) {
  const now = Date.now();
  const pending = db.all(
    `SELECT r.message_id, m.conversation_id, m.sender_id
     FROM receipts r JOIN messages m ON m.id = r.message_id
     WHERE r.user_id = ? AND r.delivered_at IS NULL`,
    [userId],
  );
  if (!pending.length) return [];
  db.transaction(() => {
    db.run("UPDATE receipts SET delivered_at = ? WHERE user_id = ? AND delivered_at IS NULL", [now, userId]);
  });
  return pending.map((row) => ({
    messageId: Number(row.message_id),
    conversationId: Number(row.conversation_id),
    senderId: row.sender_id == null ? null : Number(row.sender_id),
    userId: Number(userId),
    deliveredAt: now,
  }));
}

export function markRead(db, userId, conversationId, messageId) {
  const member = db.get(
    "SELECT last_read_message_id FROM conversation_members WHERE conversation_id = ? AND user_id = ?",
    [conversationId, userId],
  );
  if (!member) throw new HttpError(403, "You are not in that conversation.");
  const message = db.get("SELECT id FROM messages WHERE id = ? AND conversation_id = ?", [messageId, conversationId]);
  if (!message) throw new HttpError(400, "That message is not in this conversation.");
  const now = Date.now();
  const target = Math.max(Number(member.last_read_message_id) || 0, Number(messageId));
  db.transaction(() => {
    db.run(
      "UPDATE conversation_members SET last_read_message_id = ? WHERE conversation_id = ? AND user_id = ?",
      [target, conversationId, userId],
    );
    db.run(
      `UPDATE receipts SET read_at = ?, delivered_at = COALESCE(delivered_at, ?)
       WHERE user_id = ? AND read_at IS NULL AND message_id IN (
         SELECT id FROM messages WHERE conversation_id = ? AND id <= ? AND IFNULL(sender_id, -1) != ?
       )`,
      [now, now, userId, conversationId, Number(messageId), userId],
    );
  });
  const updated = db.all("SELECT message_id FROM receipts WHERE user_id = ? AND read_at = ?", [userId, now]);
  return {
    conversationId: Number(conversationId),
    userId: Number(userId),
    messageIds: updated.map((row) => Number(row.message_id)),
    readAt: now,
  };
}

export function userCanAccessFile(db, userId, attachmentId) {
  return db.get(
    `SELECT m.* FROM messages m
     JOIN conversation_members cm ON cm.conversation_id = m.conversation_id
     WHERE m.attachment_id = ? AND cm.user_id = ?`,
    [attachmentId, userId],
  );
}

export function countAdmins(db) {
  const row = db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'");
  return Number(row?.n || 0);
}
