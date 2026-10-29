import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { startHosting } from "../server/main.js";

export async function startTestServer(extra = {}) {
  const dataDir = extra.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), "porch-"));
  const hosted = await startHosting({
    dataDir,
    adminUsername: "admin",
    adminPassword: "admin-pass-123",
    adminDisplayName: "Ada Admin",
    port: 0,
    host: "127.0.0.1",
    https: false,
    discovery: false,
    lock: false,
    prompt: false,
    allowGenerate: false,
    quiet: true,
    bcryptRounds: 6,
    ...extra,
    dataDir,
  });
  return hosted;
}

export async function login(baseUrl, username, password) {
  const response = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const data = await response.json();
  return { response, data };
}

export function authHeaders(token, extra = {}) {
  return { Authorization: `Bearer ${token}`, ...extra };
}

export async function api(baseUrl, token, path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.body && !(options.body instanceof FormData) && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

export function openSocket(baseUrl, token) {
  const socket = new WebSocket(baseUrl.replace(/^http/, "ws") + `/ws?token=${encodeURIComponent(token)}`);
  const queue = [];
  const waiters = [];
  socket.on("message", (raw) => {
    const payload = JSON.parse(String(raw));
    const index = waiters.findIndex((waiter) => waiter.type === payload.type);
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      waiter.resolve(payload);
    } else {
      queue.push(payload);
    }
  });
  socket.waitFor = (type, timeoutMs = 4000) => {
    const found = queue.findIndex((payload) => payload.type === type);
    if (found >= 0) return Promise.resolve(queue.splice(found, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), timeoutMs);
      waiters.push({
        type,
        resolve: (payload) => {
          clearTimeout(timer);
          resolve(payload);
        },
      });
    });
  };
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}
