import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { HttpError } from "./errors.js";

const COLORS = ["#ef6a32", "#e2a15a", "#c9b458", "#8fce6b", "#5fbfa8", "#6cb6e0", "#7f8fdb", "#c58bdb", "#e07aa0", "#d97b63"];

export function colorFor(username) {
  let hash = 0;
  for (const char of username) hash = (hash * 33 + char.charCodeAt(0)) >>> 0;
  return COLORS[hash % COLORS.length];
}

export function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

export function assertUsername(username) {
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) {
    throw new HttpError(400, "Usernames are 3–32 characters: letters, numbers, dots, dashes, or underscores, and must start with a letter or number.");
  }
}

export function assertPassword(password) {
  const value = String(password || "");
  if (value.length < 8 || value.length > 72) {
    throw new HttpError(400, "Passwords need 8 to 72 characters.");
  }
  return value;
}

export function cleanText(value, max, label) {
  const text = String(value || "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim();
  if (!text) throw new HttpError(400, `Enter a ${label}.`);
  if (text.length > max) throw new HttpError(400, `${label[0].toUpperCase()}${label.slice(1)} must be under ${max} characters.`);
  return text;
}

export function hashPassword(password, rounds) {
  return bcrypt.hashSync(assertPassword(password), rounds);
}

export function verifyPassword(password, hash) {
  return bcrypt.compareSync(String(password || ""), hash);
}

export function dummyHash(rounds) {
  return bcrypt.hashSync("porch-dummy-password", rounds);
}

export function newToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

export function readCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export function sessionCookie(token, { https, maxAgeSec }) {
  const parts = [
    `porch_session=${encodeURIComponent(token)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${maxAgeSec}`,
  ];
  if (https) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookie(https) {
  const parts = ["porch_session=", "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=0"];
  if (https) parts.push("Secure");
  return parts.join("; ");
}

export function createLoginLimiter({ max = 8, windowMs = 10 * 60 * 1000, ipMax = 40 } = {}) {
  const byUser = new Map();
  const byIp = new Map();

  function bump(map, key) {
    const now = Date.now();
    let entry = map.get(key);
    if (!entry || entry.reset <= now) {
      entry = { count: 0, reset: now + windowMs };
      map.set(key, entry);
    }
    entry.count += 1;
    return entry;
  }

  return {
    check(ip, username) {
      const now = Date.now();
      const user = byUser.get(`${ip}:${username}`);
      const ipEntry = byIp.get(ip);
      if (user && user.reset > now && user.count >= max) {
        return { limited: true, retryAfter: Math.ceil((user.reset - now) / 1000) };
      }
      if (ipEntry && ipEntry.reset > now && ipEntry.count >= ipMax) {
        return { limited: true, retryAfter: Math.ceil((ipEntry.reset - now) / 1000) };
      }
      return { limited: false };
    },
    recordFailure(ip, username) {
      bump(byUser, `${ip}:${username}`);
      bump(byIp, ip);
    },
    clearUser(ip, username) {
      byUser.delete(`${ip}:${username}`);
    },
  };
}

export function clientIp(req) {
  const raw = req.socket?.remoteAddress || "";
  return raw.replace(/^::ffff:/, "");
}

export function bearerToken(req) {
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) return header.slice(7).trim();
  return readCookie(req.headers.cookie, "porch_session");
}
