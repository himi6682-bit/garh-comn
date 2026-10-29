import { WebSocket } from "ws";
import { api, login, openSocket, startTestServer } from "../tests/helpers.js";

const server = await startTestServer();
const log = [];
const note = (line) => {
  log.push(line);
  console.log(line);
};

try {
  const admin = await login(server.baseUrl, "admin", "admin-pass-123");
  if (admin.response.status !== 200) throw new Error("admin login failed");
  note(`admin signed in as ${admin.data.user.displayName}`);

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
  note("created Maya and Sam");

  const mayaSocket = await openSocket(server.baseUrl, mayaLogin.data.token);
  const samSocket = await openSocket(server.baseUrl, samLogin.data.token);
  const mayaReady = await mayaSocket.waitFor("ready");
  const samReady = await samSocket.waitFor("ready");
  async function seen(socket, initial, otherId) {
    let ids = new Set(initial);
    const deadline = Date.now() + 3000;
    while (!ids.has(otherId) && Date.now() < deadline) {
      ids = new Set((await socket.waitFor("presence", 1000)).userIds);
    }
    return ids;
  }
  const mayaIds = await seen(mayaSocket, mayaReady.presence, sam.data.user.id);
  const samIds = await seen(samSocket, samReady.presence, maya.data.user.id);
  if (!mayaIds.has(sam.data.user.id) || !samIds.has(maya.data.user.id)) {
    throw new Error(`presence missing: maya saw ${[...mayaIds]}, sam saw ${[...samIds]}`);
  }
  note("both online. Maya sees Sam, Sam sees Maya");

  const direct = await api(server.baseUrl, mayaLogin.data.token, "/api/conversations", {
    method: "POST",
    body: JSON.stringify({ userId: sam.data.user.id }),
  });
  const incoming = samSocket.waitFor("message");
  const sent = await api(server.baseUrl, mayaLogin.data.token, `/api/conversations/${direct.data.conversation.id}/messages`, {
    method: "POST",
    body: JSON.stringify({ body: "The switch table is up." }),
  });
  const delivered = await incoming;
  if (!delivered.message.receipts[0].deliveredAt) throw new Error("message was not marked delivered");
  note(`1:1 delivered to Sam while he is online: "${delivered.message.body}"`);

  const readWait = mayaSocket.waitFor("read");
  await api(server.baseUrl, samLogin.data.token, `/api/conversations/${direct.data.conversation.id}/read`, {
    method: "POST",
    body: JSON.stringify({ messageId: sent.data.message.id }),
  });
  const read = await readWait;
  if (!read.messageIds.includes(sent.data.message.id)) throw new Error("read tick missing");
  note("Maya got the read tick");

  const lists = await api(server.baseUrl, mayaLogin.data.token, "/api/conversations");
  const everyone = lists.data.conversations.find((conversation) => conversation.isEveryone);
  const groupWait = samSocket.waitFor("message");
  await api(server.baseUrl, admin.data.token, `/api/conversations/${everyone.id}/messages`, {
    method: "POST",
    body: JSON.stringify({ body: "Everyone can hear this." }),
  });
  const group = await groupWait;
  note(`group message in Everyone reached Sam: "${group.message.body}"`);

  mayaSocket.close();
  samSocket.close();
  const dataDir = server.config.dataDir;
  await server.stop();

  const restarted = await startTestServer({ dataDir });
  try {
    const again = await login(restarted.baseUrl, "sam", "sam-pass-1234");
    const conversations = await api(restarted.baseUrl, again.data.token, "/api/conversations");
    const dm = conversations.data.conversations.find((conversation) => conversation.type === "direct");
    const room = conversations.data.conversations.find((conversation) => conversation.isEveryone);
    const dmMessages = await api(restarted.baseUrl, again.data.token, `/api/conversations/${dm.id}/messages`);
    const roomMessages = await api(restarted.baseUrl, again.data.token, `/api/conversations/${room.id}/messages`);
    const dmBody = dmMessages.data.messages.at(-1).body;
    const roomBody = roomMessages.data.messages.at(-1).body;
    if (dmBody !== "The switch table is up." || roomBody !== "Everyone can hear this.") {
      throw new Error(`history mismatch: ${dmBody} / ${roomBody}`);
    }
    const ticks = dmMessages.data.messages.at(-1).receipts[0];
    if (!ticks.readAt) throw new Error("read tick was not saved");
    note("after restart Sam still has the direct message, the group message, and the read tick");
  } finally {
    await restarted.stop();
  }
  note("E2E_OK");
} catch (error) {
  console.error(error);
  try { await server.stop(); } catch { /* already stopped */ }
  process.exit(1);
}
