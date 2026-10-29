import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import multer from "multer";
import { HttpError } from "./errors.js";
import {
  assertPassword,
  assertUsername,
  bearerToken,
  cleanText,
  clearSessionCookie,
  clientIp,
  hashPassword,
  hashToken,
  newToken,
  normalizeUsername,
  sessionCookie,
  verifyPassword,
} from "./auth.js";
import { describeAddresses, lanAddresses } from "./net.js";
import {
  buildConversation,
  createGroup,
  deleteGroup,
  updateGroup,
  createMessage,
  createSession,
  createUser,
  deleteSession,
  deleteUser,
  deleteUserSessions,
  findOrCreateDirect,
  getSessionUser,
  getUser,
  getUserByUsername,
  listConversations,
  listMessages,
  listUsers,
  markRead,
  memberIds,
  setDisabled,
  setPasswordHash,
  toUser,
  userCanAccessFile,
} from "./store.js";
import { publishConversation, publishConversationRemoved, publishMessage, publishRead } from "./realtime.js";

const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/zip",
  "application/x-zip-compressed",
  "audio/mpeg",
  "audio/mp4",
  "audio/aac",
  "audio/wav",
  "audio/webm",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

const EXT_MIME = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  zip: "application/zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  aac: "audio/aac",
};

function safeName(name) {
  const base = path.basename(String(name || "file")).replace(/[\r\n"]/g, "");
  return base.slice(0, 120) || "file";
}

function contentDisposition(kind, name) {
  const fallback = safeName(name).replace(/[^\w.\- ]+/g, "_");
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(safeName(name))}`;
}

export function mountRoutes(app, ctx) {
  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, ctx.uploadDir),
      filename: (_req, _file, cb) => cb(null, crypto.randomBytes(16).toString("hex")),
    }),
    limits: { fileSize: ctx.config.maxUploadMb * 1024 * 1024, files: 1 },
  });

  const sessionSeconds = Math.round(ctx.config.sessionDays * 86400);

  function authenticate(req) {
    const token = bearerToken(req);
    if (!token) return null;
    const row = getSessionUser(ctx.db, hashToken(token));
    if (!row) return null;
    return { token, tokenHash: hashToken(token), user: toUser(row), row };
  }

  function requireUser(req, res, next) {
    const auth = authenticate(req);
    if (!auth) {
      res.status(401).json({ error: "You need to sign in." });
      return;
    }
    req.auth = auth;
    next();
  }

  function requireAdmin(req, res, next) {
    if (req.auth.user.role !== "admin") {
      res.status(403).json({ error: "Only the admin can do that." });
      return;
    }
    next();
  }

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, name: "garh-comn", maxUploadMb: ctx.config.maxUploadMb });
  });

  app.get("/api/host-info", (req, res) => {
    const port = ctx.httpServer.address()?.port || ctx.config.port;
    const https = ctx.config.https;
    res.json({
      port,
      https,
      addresses: describeAddresses(lanAddresses(ctx.config.dataDir), https, port),
    });
  });

  app.post("/api/login", (req, res) => {
    const username = normalizeUsername(req.body?.username);
    const password = String(req.body?.password || "");
    const ip = clientIp(req);
    const limited = ctx.limiter.check(ip, username || "-");
    if (limited.limited) {
      res.setHeader("Retry-After", String(limited.retryAfter));
      res.status(429).json({ error: "Too many sign-in attempts. Wait a few minutes and try again." });
      return;
    }
    const row = username ? getUserByUsername(ctx.db, username) : null;
    const hash = row?.password_hash || ctx.dummyHash;
    const matches = verifyPassword(password, hash);
    if (!row || !matches) {
      ctx.limiter.recordFailure(ip, username || "-");
      res.status(401).json({ error: "That username and password do not match." });
      return;
    }
    if (Number(row.disabled)) {
      ctx.limiter.recordFailure(ip, username);
      res.status(403).json({ error: "This account is disabled. Ask the admin to turn it back on." });
      return;
    }
    ctx.limiter.clearUser(ip, username);
    const token = newToken();
    const expiresAt = Date.now() + sessionSeconds * 1000;
    createSession(ctx.db, row.id, hashToken(token), expiresAt);
    res.setHeader("Set-Cookie", sessionCookie(token, { https: ctx.config.https, maxAgeSec: sessionSeconds }));
    const leak = path.join(ctx.config.dataDir, "admin-password.txt");
    if (row.role === "admin" && fs.existsSync(leak)) fs.unlinkSync(leak);
    console.log(`${new Date().toISOString()} ${row.username} signed in`);
    res.json({ token, user: toUser(row), maxUploadMb: ctx.config.maxUploadMb });
  });

  app.post("/api/logout", (req, res) => {
    const token = bearerToken(req);
    if (token) deleteSession(ctx.db, hashToken(token));
    res.setHeader("Set-Cookie", clearSessionCookie(ctx.config.https));
    res.json({ ok: true });
  });

  app.get("/api/me", requireUser, (req, res) => {
    res.json({ user: req.auth.user, maxUploadMb: ctx.config.maxUploadMb });
  });

  app.get("/api/users", requireUser, (_req, res) => {
    res.json({ users: listUsers(ctx.db) });
  });

  app.get("/api/conversations", requireUser, (req, res) => {
    res.json({ conversations: listConversations(ctx.db, req.auth.user.id) });
  });

  app.post("/api/conversations", requireUser, (req, res) => {
    let conversationId;
    if (req.body?.userId) {
      conversationId = findOrCreateDirect(ctx.db, req.auth.user.id, Number(req.body.userId));
    } else if (req.body?.type === "group") {
      if (req.auth.user.role !== "admin") throw new HttpError(403, "Only the admin can create a group.");
      const name = cleanText(req.body.name, 40, "group name");
      const ids = Array.isArray(req.body.memberIds) ? req.body.memberIds : [];
      conversationId = createGroup(ctx.db, { name, creatorId: req.auth.user.id, memberIds: ids });
    } else {
      throw new HttpError(400, "Choose a person or a group name.");
    }
    const ids = memberIds(ctx.db, conversationId);
    const dtoByUser = ids.map((id) => [id, buildConversation(ctx.db, conversationId, id)]);
    publishConversation(ctx.presence, dtoByUser);
    res.status(201).json({ conversation: buildConversation(ctx.db, conversationId, req.auth.user.id) });
  });

  app.patch("/api/conversations/:id", requireUser, (req, res) => {
    if (req.auth.user.role !== "admin") throw new HttpError(403, "Only the admin can change a group.");
    const conversationId = Number(req.params.id);
    const hasName = Object.prototype.hasOwnProperty.call(req.body || {}, "name");
    const hasMembers = Object.prototype.hasOwnProperty.call(req.body || {}, "memberIds");
    if (!hasName && !hasMembers) throw new HttpError(400, "Nothing to change.");
    const name = hasName ? cleanText(req.body.name, 40, "group name") : null;
    const memberIdsInput = hasMembers ? (Array.isArray(req.body.memberIds) ? req.body.memberIds : []) : null;
    const change = updateGroup(ctx.db, conversationId, {
      name,
      memberIds: memberIdsInput,
      actorId: req.auth.user.id,
    });
    const ids = memberIds(ctx.db, conversationId);
    publishConversation(ctx.presence, ids.map((id) => [id, buildConversation(ctx.db, conversationId, id)]));
    if (change.removed.length) publishConversationRemoved(ctx.presence, change.removed, conversationId, "removed");
    res.json({ conversation: buildConversation(ctx.db, conversationId, req.auth.user.id) });
  });

  app.delete("/api/conversations/:id", requireUser, (req, res) => {
    if (req.auth.user.role !== "admin") throw new HttpError(403, "Only the admin can delete a group.");
    const conversationId = Number(req.params.id);
    const removed = deleteGroup(ctx.db, conversationId);
    for (const attachmentId of removed.attachmentIds) {
      fs.rmSync(path.join(ctx.config.dataDir, "uploads", attachmentId), { force: true });
    }
    publishConversationRemoved(ctx.presence, removed.memberIds, conversationId, "deleted");
    res.json({ ok: true });
  });

  app.get("/api/conversations/:id/messages", requireUser, (req, res) => {
    const result = listMessages(ctx.db, Number(req.params.id), req.auth.user.id, {
      before: Number(req.query.before || 0),
      limit: Number(req.query.limit || 50),
    });
    res.json(result);
  });

  function sendMessage(req, res) {
    const conversationId = Number(req.params.id);
    let attachment = null;
    if (req.file) {
      const original = safeName(req.file.originalname);
      const ext = original.includes(".") ? original.split(".").pop().toLowerCase() : "";
      let mime = req.file.mimetype || "";
      if (!ALLOWED_MIME.has(mime)) mime = EXT_MIME[ext] || "";
      if (!ALLOWED_MIME.has(mime)) {
        fs.unlinkSync(req.file.path);
        throw new HttpError(400, "That file type is not allowed. Use a photo, PDF, text, audio, or zip.");
      }
      attachment = { id: req.file.filename, name: original, mime, size: req.file.size };
    }
    const body = String(req.body?.body || "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim();
    if (!body && !attachment) throw new HttpError(400, "Write a message or attach a file.");
    if (body.length > 4000) throw new HttpError(400, "Messages must be under 4000 characters.");
    const message = createMessage(ctx.db, {
      conversationId,
      senderId: req.auth.user.id,
      body,
      attachment,
      onlineUserIds: ctx.presence.onlineIds(),
    });
    publishMessage(ctx.presence, message);
    res.status(201).json({ message });
  }

  app.post("/api/conversations/:id/messages", requireUser, (req, res, next) => {
    const type = req.headers["content-type"] || "";
    if (type.includes("multipart/form-data")) {
      upload.single("file")(req, res, (error) => {
        if (error) return next(error);
        try {
          sendMessage(req, res);
        } catch (err) {
          next(err);
        }
      });
      return;
    }
    try {
      sendMessage(req, res);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/conversations/:id/read", requireUser, (req, res) => {
    const messageId = Number(req.body?.messageId);
    if (!messageId) throw new HttpError(400, "Missing message.");
    const event = markRead(ctx.db, req.auth.user.id, Number(req.params.id), messageId);
    publishRead(ctx.presence, memberIds(ctx.db, Number(req.params.id)), event);
    res.json({ ok: true, ...event });
  });

  app.get("/api/files/:id", requireUser, (req, res) => {
    const id = String(req.params.id || "");
    if (!/^[a-f0-9]{32}$/.test(id)) throw new HttpError(404, "File not found.");
    const message = userCanAccessFile(ctx.db, req.auth.user.id, id);
    if (!message) throw new HttpError(404, "File not found.");
    const filePath = path.join(ctx.uploadDir, id);
    if (!filePath.startsWith(ctx.uploadDir) || !fs.existsSync(filePath)) throw new HttpError(404, "File not found.");
    const mime = message.attachment_mime || "application/octet-stream";
    const inline = mime.startsWith("image/") || mime.startsWith("audio/") || mime === "application/pdf";
    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Disposition", contentDisposition(inline ? "inline" : "attachment", message.attachment_name));
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.sendFile(filePath);
  });

  app.get("/api/admin/users", requireUser, requireAdmin, (_req, res) => {
    res.json({ users: listUsers(ctx.db, { includeDisabled: true }) });
  });

  app.post("/api/admin/users", requireUser, requireAdmin, (req, res) => {
    const username = normalizeUsername(req.body?.username);
    assertUsername(username);
    const displayName = cleanText(req.body?.displayName, 40, "display name");
    const passwordHash = hashPassword(req.body?.password, ctx.config.bcryptRounds);
    const user = toUser(createUser(ctx.db, { username, displayName, passwordHash, role: "user" }));
    const everyone = ctx.db.get("SELECT id FROM conversations WHERE is_everyone = 1");
    if (everyone) {
      const ids = memberIds(ctx.db, Number(everyone.id));
      publishConversation(ctx.presence, ids.map((id) => [id, buildConversation(ctx.db, Number(everyone.id), id)]));
    }
    console.log(`${new Date().toISOString()} admin created ${username}`);
    res.status(201).json({ user });
  });

  app.patch("/api/admin/users/:id", requireUser, requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    if (typeof req.body?.disabled !== "boolean") throw new HttpError(400, "Say whether the account is disabled.");
    if (id === req.auth.user.id && req.body.disabled) throw new HttpError(400, "You cannot disable your own account.");
    const row = setDisabled(ctx.db, id, req.body.disabled);
    if (req.body.disabled) {
      deleteUserSessions(ctx.db, id);
      ctx.presence.disconnectUser(id, "This account is disabled.");
    }
    res.json({ user: toUser(row) });
  });

  app.post("/api/admin/users/:id/password", requireUser, requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const user = getUser(ctx.db, id);
    if (!user) throw new HttpError(404, "No account with that id.");
    const passwordHash = hashPassword(req.body?.password, ctx.config.bcryptRounds);
    setPasswordHash(ctx.db, id, passwordHash);
    const except = id === req.auth.user.id ? req.auth.tokenHash : null;
    deleteUserSessions(ctx.db, id, except);
    if (id !== req.auth.user.id) ctx.presence.disconnectUser(id, "Your password was changed. Sign in again.");
    res.json({ ok: true });
  });

  app.delete("/api/admin/users/:id", requireUser, requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    if (id === req.auth.user.id) throw new HttpError(400, "You cannot delete your own account.");
    deleteUser(ctx.db, id);
    ctx.presence.disconnectUser(id, "This account was deleted.");
    res.json({ ok: true });
  });

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found." });
  });

  app.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof HttpError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    if (error?.code === "LIMIT_FILE_SIZE") {
      res.status(413).json({ error: `That file is larger than the ${ctx.config.maxUploadMb} MB limit.` });
      return;
    }
    if (error?.type === "entity.too.large" || error?.status === 413) {
      res.status(413).json({ error: "That upload is too large." });
      return;
    }
    if (error instanceof SyntaxError && error.status === 400) {
      res.status(400).json({ error: "The request was not valid JSON." });
      return;
    }
    console.error(error);
    res.status(500).json({ error: "The host hit an unexpected error." });
  });
}
