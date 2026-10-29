import dgram from "node:dgram";
import { WebSocketServer } from "ws";
import { bearerToken, hashToken } from "./auth.js";
import { describeAddresses, lanAddresses } from "./net.js";
import { getSessionUser, markDelivered, memberIds } from "./store.js";

const DISCOVERY_PORT = 45878;

export function createPresence() {
  const sockets = new Map();

  function ids() {
    return [...sockets.keys()];
  }

  function broadcast(ioSend) {
    const payload = JSON.stringify({ type: "presence", userIds: ids() });
    for (const set of sockets.values()) {
      for (const socket of set) ioSend(socket, payload);
    }
  }

  return {
    ids,
    isOnline(userId) {
      const set = sockets.get(Number(userId));
      return !!set && set.size > 0;
    },
    onlineIds() {
      return new Set(ids());
    },
    add(userId, socket) {
      const id = Number(userId);
      let set = sockets.get(id);
      const wasOffline = !set || set.size === 0;
      if (!set) {
        set = new Set();
        sockets.set(id, set);
      }
      set.add(socket);
      socket.porchUserId = id;
      if (wasOffline) broadcast(sendRaw);
      return wasOffline;
    },
    remove(socket) {
      const id = socket.porchUserId;
      const set = sockets.get(id);
      if (!set) return false;
      set.delete(socket);
      if (set.size === 0) {
        sockets.delete(id);
        broadcast(sendRaw);
        return true;
      }
      return false;
    },
    send(userId, payload) {
      const set = sockets.get(Number(userId));
      if (!set) return;
      const raw = JSON.stringify(payload);
      for (const socket of set) sendRaw(socket, raw);
    },
    disconnectUser(userId, reason) {
      const set = sockets.get(Number(userId));
      if (!set) return;
      const raw = JSON.stringify({ type: "kicked", reason });
      for (const socket of [...set]) {
        sendRaw(socket, raw);
        try {
          socket.close(4001, "revoked");
        } catch {
          // Already closing.
        }
      }
    },
  };
}

function sendRaw(socket, raw) {
  if (socket.readyState !== 1) return;
  try {
    socket.send(raw);
  } catch {
    // The close handler will drop the socket.
  }
}

export function publishMessage(presence, message) {
  const payload = { type: "message", message };
  const memberSet = new Set((message.receipts || []).map((receipt) => receipt.userId));
  if (message.senderId != null) memberSet.add(message.senderId);
  for (const userId of memberSet) presence.send(userId, payload);
}

export function publishConversation(presence, dtoByUser) {
  for (const [userId, conversation] of dtoByUser) {
    presence.send(userId, { type: "conversation", conversation });
  }
}

export function publishConversationRemoved(presence, userIds, conversationId, reason) {
  for (const userId of userIds) {
    presence.send(userId, { type: "conversation-removed", conversationId, reason });
  }
}

export function publishRead(presence, conversationMemberIds, event) {
  for (const userId of conversationMemberIds) presence.send(userId, { type: "read", ...event });
}

export function publishDelivered(presence, rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.conversationId}:${row.userId}`;
    if (!groups.has(key)) groups.set(key, { ...row, messageIds: [] });
    groups.get(key).messageIds.push(row.messageId);
  }
  for (const group of groups.values()) {
    const payload = {
      type: "delivered",
      conversationId: group.conversationId,
      userId: group.userId,
      messageIds: group.messageIds,
      deliveredAt: group.deliveredAt,
    };
    if (group.senderId != null) presence.send(group.senderId, payload);
  }
}

export function attachRealtime(httpServer, ctx) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.porchToken = url.searchParams.get("token") || bearerToken(req);
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (socket) => {
    const row = getSessionUser(ctx.db, hashToken(socket.porchToken || ""));
    if (!row) {
      sendRaw(socket, JSON.stringify({ type: "kicked", reason: "Your session is no longer valid." }));
      socket.close(4001, "unauthorized");
      return;
    }
    const user = {
      id: Number(row.id),
      username: row.username,
      displayName: row.display_name,
      role: row.role,
    };
    socket.porchUser = user;
    ctx.presence.add(user.id, socket);
    const delivered = markDelivered(ctx.db, user.id);
    publishDelivered(ctx.presence, delivered);
    sendRaw(socket, JSON.stringify({ type: "ready", userId: user.id, presence: ctx.presence.ids() }));

    socket.on("message", (data) => {
      let payload;
      try {
        payload = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!payload || typeof payload !== "object") return;
      if (payload.type === "ping") {
        sendRaw(socket, JSON.stringify({ type: "pong" }));
        return;
      }
      if (payload.type === "typing") {
        const conversationId = Number(payload.conversationId);
        if (!memberIds(ctx.db, conversationId).includes(user.id)) return;
        const event = {
          type: "typing",
          conversationId,
          userId: user.id,
          displayName: user.displayName,
          isTyping: !!payload.isTyping,
        };
        for (const id of memberIds(ctx.db, conversationId)) {
          if (id !== user.id) ctx.presence.send(id, event);
        }
      }
    });

    socket.on("close", () => {
      ctx.presence.remove(socket);
    });
    socket.on("error", () => {
      ctx.presence.remove(socket);
    });
  });

  const discovery = ctx.config.discovery ? startDiscovery(ctx) : null;
  return {
    close() {
      discovery?.stop();
      for (const client of wss.clients) {
        try {
          client.close();
        } catch {
          // Ignore sockets already closing.
        }
      }
      wss.close();
    },
  };
}

function startDiscovery(ctx) {
  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
  socket.on("error", (error) => {
    console.error(`Discovery beacon: ${error.message}`);
  });
  const timer = setInterval(() => {
    let port = ctx.httpServer.address()?.port;
    if (!port) return;
    const addresses = describeAddresses(lanAddresses(ctx.config.dataDir), ctx.config.https, port);
    if (!addresses.length) return;
    const payload = Buffer.from(JSON.stringify({
      v: 1,
      app: "porch",
      port,
      https: !!ctx.config.https,
      addresses: addresses.map((row) => ({ address: row.address, kind: row.kind, name: row.name, label: row.label })),
    }));
    const targets = new Set(["255.255.255.255"]);
    for (const row of addresses) if (row.broadcast) targets.add(row.broadcast);
    for (const target of targets) socket.send(payload, DISCOVERY_PORT, target, () => {});
  }, 2500);
  if (typeof timer.unref === "function") timer.unref();
  socket.bind(0, () => {
    try {
      socket.setBroadcast(true);
    } catch {
      // Some platforms refuse broadcast. Direct addresses still work.
    }
  });
  socket.unref?.();
  return {
    stop() {
      clearInterval(timer);
      try {
        socket.close();
      } catch {
        // Already closed.
      }
    },
  };
}

export { DISCOVERY_PORT };
