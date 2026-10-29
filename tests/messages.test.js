import assert from "node:assert/strict";
import test from "node:test";
import { api, login, openSocket, startTestServer } from "./helpers.js";

async function withPeople() {
  const server = await startTestServer();
  const admin = await login(server.baseUrl, "admin", "admin-pass-123");
  const maya = await api(server.baseUrl, admin.data.token, "/api/admin/users", {
    method: "POST",
    body: JSON.stringify({ username: "maya", displayName: "Maya Chen", password: "maya-pass-123" }),
  });
  const sam = await api(server.baseUrl, admin.data.token, "/api/admin/users", {
    method: "POST",
    body: JSON.stringify({ username: "sam", displayName: "Sam Okonkwo", password: "sam-pass-1234" }),
  });
  const mayaLogin = await login(server.baseUrl, "maya", "maya-pass-123");
  const samLogin = await login(server.baseUrl, "sam", "sam-pass-1234");
  return {
    server,
    admin: admin.data,
    maya: { ...maya.data.user, token: mayaLogin.data.token },
    sam: { ...sam.data.user, token: samLogin.data.token },
  };
}

test("direct and everyone messages are delivered, stored, and survive a restart", async () => {
  const ctx = await withPeople();
  const dataDir = ctx.server.config.dataDir;
  try {
    const mayaSocket = await openSocket(ctx.server.baseUrl, ctx.maya.token);
    const samSocket = await openSocket(ctx.server.baseUrl, ctx.sam.token);
    await mayaSocket.waitFor("ready");
    await samSocket.waitFor("ready");

    const direct = await api(ctx.server.baseUrl, ctx.maya.token, "/api/conversations", {
      method: "POST",
      body: JSON.stringify({ userId: ctx.sam.id }),
    });
    assert.equal(direct.response.status, 201);
    assert.equal(direct.data.conversation.type, "direct");

    const incoming = samSocket.waitFor("message");
    const sent = await api(ctx.server.baseUrl, ctx.maya.token, `/api/conversations/${direct.data.conversation.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ body: "The switch table is up." }),
    });
    assert.equal(sent.response.status, 201);
    const delivered = await incoming;
    assert.equal(delivered.message.body, "The switch table is up.");
    assert.equal(delivered.message.receipts[0].userId, ctx.sam.id);
    assert.ok(delivered.message.receipts[0].deliveredAt);

    const readNotice = mayaSocket.waitFor("read");
    const read = await api(ctx.server.baseUrl, ctx.sam.token, `/api/conversations/${direct.data.conversation.id}/read`, {
      method: "POST",
      body: JSON.stringify({ messageId: sent.data.message.id }),
    });
    assert.equal(read.response.status, 200);
    const readEvent = await readNotice;
    assert.deepEqual(readEvent.messageIds, [sent.data.message.id]);

    const history = await api(ctx.server.baseUrl, ctx.sam.token, `/api/conversations/${direct.data.conversation.id}/messages`);
    assert.equal(history.data.messages.at(-1).body, "The switch table is up.");
    assert.ok(history.data.messages.at(-1).receipts[0].readAt);

    const outsider = await api(ctx.server.baseUrl, ctx.admin.token, `/api/conversations/${direct.data.conversation.id}/messages`);
    assert.equal(outsider.response.status, 403);

    const lists = await api(ctx.server.baseUrl, ctx.maya.token, "/api/conversations");
    const everyone = lists.data.conversations.find((conversation) => conversation.isEveryone);
    assert.ok(everyone);
    assert.ok(everyone.members.some((member) => member.id === ctx.sam.id));
    const groupIncoming = samSocket.waitFor("message");
    const groupSent = await api(ctx.server.baseUrl, ctx.maya.token, `/api/conversations/${everyone.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ body: "Everyone can hear this." }),
    });
    assert.equal(groupSent.response.status, 201);
    const groupMessage = await groupIncoming;
    assert.equal(groupMessage.message.body, "Everyone can hear this.");

    const typing = samSocket.waitFor("typing");
    mayaSocket.send(JSON.stringify({ type: "typing", conversationId: direct.data.conversation.id, isTyping: true }));
    const typingEvent = await typing;
    assert.equal(typingEvent.displayName, "Maya Chen");
    assert.equal(typingEvent.isTyping, true);

    mayaSocket.close();
    samSocket.close();
    await ctx.server.stop();

    const restarted = await startTestServer({ dataDir, port: 0 });
    try {
      const again = await login(restarted.baseUrl, "sam", "sam-pass-1234");
      const reloaded = await api(restarted.baseUrl, again.data.token, "/api/conversations");
      const dm = reloaded.data.conversations.find((conversation) => conversation.type === "direct");
      const messages = await api(restarted.baseUrl, again.data.token, `/api/conversations/${dm.id}/messages`);
      assert.equal(messages.data.messages.at(-1).body, "The switch table is up.");
      const room = reloaded.data.conversations.find((conversation) => conversation.isEveryone);
      const roomMessages = await api(restarted.baseUrl, again.data.token, `/api/conversations/${room.id}/messages`);
      assert.equal(roomMessages.data.messages.at(-1).body, "Everyone can hear this.");
    } finally {
      await restarted.stop();
    }
  } finally {
    if (ctx.server) {
      try { await ctx.server.stop(); } catch { /* already stopped */ }
    }
  }
});

test("a photo can be shared and a stranger cannot download it", async () => {
  const ctx = await withPeople();
  try {
    const direct = await api(ctx.server.baseUrl, ctx.maya.token, "/api/conversations", {
      method: "POST",
      body: JSON.stringify({ userId: ctx.sam.id }),
    });
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    const form = new FormData();
    form.append("body", "A picture of the porch.");
    form.append("file", new Blob([png], { type: "image/png" }), "porch.png");
    const sent = await fetch(`${ctx.server.baseUrl}/api/conversations/${direct.data.conversation.id}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ctx.maya.token}` },
      body: form,
    });
    const body = await sent.json();
    assert.equal(sent.status, 201);
    assert.equal(body.message.attachment.mime, "image/png");
    const file = await fetch(`${ctx.server.baseUrl}/api/files/${body.message.attachment.id}`, {
      headers: { Authorization: `Bearer ${ctx.sam.token}` },
    });
    assert.equal(file.status, 200);
    assert.equal(file.headers.get("content-type"), "image/png");
    const stranger = await fetch(`${ctx.server.baseUrl}/api/files/${body.message.attachment.id}`, {
      headers: { Authorization: `Bearer ${ctx.admin.token}` },
    });
    assert.equal(stranger.status, 404);
  } finally {
    await ctx.server.stop();
  }
});

test("admin can create a group, add members, and they receive messages live", async () => {
  const ctx = await withPeople();
  try {
    const mayaSocket = await openSocket(ctx.server.baseUrl, ctx.maya.token);
    const samSocket = await openSocket(ctx.server.baseUrl, ctx.sam.token);
    await mayaSocket.waitFor("ready");
    await samSocket.waitFor("ready");

    const denied = await api(ctx.server.baseUrl, ctx.maya.token, "/api/conversations", {
      method: "POST",
      body: JSON.stringify({ type: "group", name: "Not allowed", memberIds: [ctx.sam.id] }),
    });
    assert.equal(denied.response.status, 403);

    const createdWait = Promise.all([
      mayaSocket.waitFor("conversation"),
      samSocket.waitFor("conversation"),
    ]);
    const created = await api(ctx.server.baseUrl, ctx.admin.token, "/api/conversations", {
      method: "POST",
      body: JSON.stringify({ type: "group", name: "Switch crew", memberIds: [ctx.maya.id, ctx.sam.id] }),
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.data.conversation.type, "group");
    assert.equal(created.data.conversation.name, "Switch crew");
    assert.equal(created.data.conversation.isEveryone, false);
    const memberIds = created.data.conversation.members.map((member) => member.id).sort();
    assert.deepEqual(memberIds, [ctx.admin.user.id, ctx.maya.id, ctx.sam.id].sort());

    const [mayaConv, samConv] = await createdWait;
    assert.equal(mayaConv.conversation.id, created.data.conversation.id);
    assert.equal(samConv.conversation.name, "Switch crew");

    const incoming = Promise.all([
      mayaSocket.waitFor("message"),
      samSocket.waitFor("message"),
    ]);
    const sent = await api(ctx.server.baseUrl, ctx.admin.token, `/api/conversations/${created.data.conversation.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ body: "Meet by the switch." }),
    });
    assert.equal(sent.response.status, 201);
    const [mayaMsg, samMsg] = await incoming;
    assert.equal(mayaMsg.message.body, "Meet by the switch.");
    assert.equal(samMsg.message.body, "Meet by the switch.");
    assert.equal(samMsg.message.conversationId, created.data.conversation.id);

    const history = await api(ctx.server.baseUrl, ctx.sam.token, `/api/conversations/${created.data.conversation.id}/messages`);
    assert.equal(history.data.messages.at(-1).body, "Meet by the switch.");
    mayaSocket.close();
    samSocket.close();
  } finally {
    await ctx.server.stop();
  }
});

test("admin can rename a group, change members, and delete it", async () => {
  const ctx = await withPeople();
  try {
    const mayaSocket = await openSocket(ctx.server.baseUrl, ctx.maya.token);
    const samSocket = await openSocket(ctx.server.baseUrl, ctx.sam.token);
    await mayaSocket.waitFor("ready");
    await samSocket.waitFor("ready");
    const created = await api(ctx.server.baseUrl, ctx.admin.token, "/api/conversations", {
      method: "POST",
      body: JSON.stringify({ type: "group", name: "Switch crew", memberIds: [ctx.maya.id, ctx.sam.id] }),
    });
    assert.equal(created.response.status, 201);
    const groupId = created.data.conversation.id;
    await mayaSocket.waitFor("conversation");
    await samSocket.waitFor("conversation");

    const lists = await api(ctx.server.baseUrl, ctx.admin.token, "/api/conversations");
    const everyone = lists.data.conversations.find((conversation) => conversation.isEveryone);
    const kept = await api(ctx.server.baseUrl, ctx.admin.token, `/api/conversations/${everyone.id}`, { method: "DELETE" });
    assert.equal(kept.response.status, 400);
    assert.match(kept.data.error, /Everyone/);
    const memberDenied = await api(ctx.server.baseUrl, ctx.maya.token, `/api/conversations/${groupId}`, { method: "DELETE" });
    assert.equal(memberDenied.response.status, 403);

    const renamedWait = mayaSocket.waitFor("conversation");
    const renamed = await api(ctx.server.baseUrl, ctx.admin.token, `/api/conversations/${groupId}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Night shift" }),
    });
    assert.equal(renamed.response.status, 200);
    assert.equal(renamed.data.conversation.name, "Night shift");
    assert.equal((await renamedWait).conversation.name, "Night shift");

    const removedWait = samSocket.waitFor("conversation-removed");
    const trimmed = await api(ctx.server.baseUrl, ctx.admin.token, `/api/conversations/${groupId}`, {
      method: "PATCH",
      body: JSON.stringify({ memberIds: [ctx.maya.id] }),
    });
    assert.equal(trimmed.response.status, 200);
    assert.deepEqual(trimmed.data.conversation.members.map((member) => member.id).sort(), [ctx.admin.user.id, ctx.maya.id].sort());
    const removed = await removedWait;
    assert.equal(removed.conversationId, groupId);
    assert.equal(removed.reason, "removed");
    const samLists = await api(ctx.server.baseUrl, ctx.sam.token, "/api/conversations");
    assert.equal(samLists.data.conversations.some((conversation) => conversation.id === groupId), false);
    const stillThere = await api(ctx.server.baseUrl, ctx.maya.token, `/api/conversations/${groupId}/messages`);
    assert.equal(stillThere.response.status, 200);

    const added = await api(ctx.server.baseUrl, ctx.admin.token, `/api/conversations/${groupId}`, {
      method: "PATCH",
      body: JSON.stringify({ memberIds: [ctx.maya.id, ctx.sam.id] }),
    });
    assert.equal(added.response.status, 200);
    await samSocket.waitFor("conversation");

    const gone = Promise.all([
      mayaSocket.waitFor("conversation-removed"),
      samSocket.waitFor("conversation-removed"),
    ]);
    const deleted = await api(ctx.server.baseUrl, ctx.admin.token, `/api/conversations/${groupId}`, { method: "DELETE" });
    assert.equal(deleted.response.status, 200);
    const [mayaGone, samGone] = await gone;
    assert.equal(mayaGone.reason, "deleted");
    assert.equal(samGone.conversationId, groupId);
    const after = await api(ctx.server.baseUrl, ctx.maya.token, "/api/conversations");
    assert.equal(after.data.conversations.some((conversation) => conversation.id === groupId), false);
    assert.equal(after.data.conversations.some((conversation) => conversation.isEveryone), true);
    const missing = await api(ctx.server.baseUrl, ctx.maya.token, `/api/conversations/${groupId}/messages`);
    assert.equal(missing.response.status, 403);
    mayaSocket.close();
    samSocket.close();
  } finally {
    await ctx.server.stop();
  }
});

test("disabling a user kicks their open connection", async () => {
  const ctx = await withPeople();
  try {
    const socket = await openSocket(ctx.server.baseUrl, ctx.sam.token);
    await socket.waitFor("ready");
    const kicked = socket.waitFor("kicked");
    const result = await api(ctx.server.baseUrl, ctx.admin.token, `/api/admin/users/${ctx.sam.id}`, {
      method: "PATCH",
      body: JSON.stringify({ disabled: true }),
    });
    assert.equal(result.response.status, 200);
    const event = await kicked;
    assert.match(event.reason, /disabled/i);
    socket.close();
  } finally {
    await ctx.server.stop();
  }
});
