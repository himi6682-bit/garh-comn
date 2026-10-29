import assert from "node:assert/strict";
import test from "node:test";
import { api, login, startTestServer } from "./helpers.js";

async function withServer(fn, extra) {
  const server = await startTestServer(extra);
  try {
    await fn(server);
  } finally {
    await server.stop();
  }
}

test("admin can sign in and a wrong password cannot", async () => {
  await withServer(async (server) => {
    const bad = await login(server.baseUrl, "admin", "not-the-password");
    assert.equal(bad.response.status, 401);
    const good = await login(server.baseUrl, "admin", "admin-pass-123");
    assert.equal(good.response.status, 200);
    assert.equal(good.data.user.role, "admin");
    assert.equal(good.data.user.username, "admin");
    assert.equal(good.data.user.passwordHash, undefined);
    const me = await api(server.baseUrl, good.data.token, "/api/me");
    assert.equal(me.data.user.displayName, "Ada Admin");
  });
});

test("there is no public sign-up", async () => {
  await withServer(async (server) => {
    const response = await fetch(`${server.baseUrl}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "maya", password: "maya-pass-123" }),
    });
    assert.equal(response.status, 404);
  });
});

test("admin creates a user, resets the password, and can disable them", async () => {
  await withServer(async (server) => {
    const admin = await login(server.baseUrl, "admin", "admin-pass-123");
    const created = await api(server.baseUrl, admin.data.token, "/api/admin/users", {
      method: "POST",
      body: JSON.stringify({ username: "Maya", displayName: "Maya Chen", password: "maya-pass-123" }),
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.data.user.username, "maya");
    const member = await login(server.baseUrl, "maya", "maya-pass-123");
    assert.equal(member.response.status, 200);

    const forbidden = await api(server.baseUrl, member.data.token, "/api/admin/users");
    assert.equal(forbidden.response.status, 403);

    const reset = await api(server.baseUrl, admin.data.token, `/api/admin/users/${created.data.user.id}/password`, {
      method: "POST",
      body: JSON.stringify({ password: "new-pass-123" }),
    });
    assert.equal(reset.response.status, 200);
    const oldPassword = await login(server.baseUrl, "maya", "maya-pass-123");
    assert.equal(oldPassword.response.status, 401);
    const kicked = await api(server.baseUrl, member.data.token, "/api/me");
    assert.equal(kicked.response.status, 401);
    const fresh = await login(server.baseUrl, "maya", "new-pass-123");
    assert.equal(fresh.response.status, 200);

    const disabled = await api(server.baseUrl, admin.data.token, `/api/admin/users/${created.data.user.id}`, {
      method: "PATCH",
      body: JSON.stringify({ disabled: true }),
    });
    assert.equal(disabled.response.status, 200);
    const blocked = await login(server.baseUrl, "maya", "new-pass-123");
    assert.equal(blocked.response.status, 403);
    const enabled = await api(server.baseUrl, admin.data.token, `/api/admin/users/${created.data.user.id}`, {
      method: "PATCH",
      body: JSON.stringify({ disabled: false }),
    });
    assert.equal(enabled.data.user.disabled, false);
  });
});

test("deleting a user revokes the session and keeps the admin", async () => {
  await withServer(async (server) => {
    const admin = await login(server.baseUrl, "admin", "admin-pass-123");
    const created = await api(server.baseUrl, admin.data.token, "/api/admin/users", {
      method: "POST",
      body: JSON.stringify({ username: "sam", displayName: "Sam Okonkwo", password: "sam-pass-1234" }),
    });
    const sam = await login(server.baseUrl, "sam", "sam-pass-1234");
    const removed = await api(server.baseUrl, admin.data.token, `/api/admin/users/${created.data.user.id}`, {
      method: "DELETE",
    });
    assert.equal(removed.response.status, 200);
    const gone = await api(server.baseUrl, sam.data.token, "/api/me");
    assert.equal(gone.response.status, 401);
    const selfDelete = await api(server.baseUrl, admin.data.token, `/api/admin/users/${admin.data.user.id}`, {
      method: "DELETE",
    });
    assert.equal(selfDelete.response.status, 400);
  });
});

test("login attempts are rate limited", async () => {
  await withServer(async (server) => {
    for (let i = 0; i < 8; i += 1) {
      const attempt = await login(server.baseUrl, "nobody", "wrong-pass-1");
      assert.equal(attempt.response.status, 401);
    }
    const limited = await login(server.baseUrl, "nobody", "wrong-pass-1");
    assert.equal(limited.response.status, 429);
    const other = await login(server.baseUrl, "admin", "admin-pass-123");
    assert.equal(other.response.status, 200);
  });
});

test("the host listens on all interfaces and lists ethernet addresses", async () => {
  await withServer(async (server) => {
    assert.equal(server.host, "127.0.0.1");
    const open = await startTestServer({ host: "0.0.0.0" });
    try {
      assert.equal(open.host, "0.0.0.0");
      const health = await fetch(`${open.baseUrl}/api/health`);
      assert.equal(health.status, 200);
      const { writeFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      writeFileSync(join(open.config.dataDir, "advertise-ips.json"), JSON.stringify({
        addresses: [
          { name: "eth0", address: "192.168.4.20", kind: "ethernet" },
          { name: "wlan0", address: "192.168.1.15", kind: "wifi" },
        ],
      }));
      const info = await fetch(`${open.baseUrl}/api/host-info`);
      const body = await info.json();
      const ethernet = body.addresses.find((row) => row.address === "192.168.4.20");
      const wifi = body.addresses.find((row) => row.address === "192.168.1.15");
      assert.equal(ethernet.kind, "ethernet");
      assert.equal(ethernet.label, "Ethernet");
      assert.equal(ethernet.url, `http://192.168.4.20:${open.port}`);
      assert.equal(wifi.kind, "wifi");
    } finally {
      await open.stop();
    }
  });
});
