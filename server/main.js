import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import crypto from "node:crypto";
import { stdin, stdout } from "node:process";
import { assertPassword, assertUsername, hashPassword, normalizeUsername } from "./auth.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { describeAddresses, kindLabel, lanAddresses } from "./net.js";
import { createUser, deleteUserSessions, getUserByUsername, setPasswordHash } from "./store.js";

function generatePassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.randomBytes(12);
  let out = "";
  for (let i = 0; i < 12; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

async function promptPassword() {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const value = await rl.question("Choose an admin password (8+ characters, visible as you type): ");
      if (String(value).length >= 8 && String(value).length <= 72) return value;
      stdout.write("Use 8 to 72 characters.\n");
    }
  } finally {
    rl.close();
  }
  throw new Error("No admin password was set.");
}

function acquireLock(dataDir) {
  const lockPath = path.join(dataDir, "porch.lock");
  if (fs.existsSync(lockPath)) {
    const pid = Number(fs.readFileSync(lockPath, "utf8").trim());
    if (pid && pid !== process.pid && isAlive(pid)) {
      throw new Error(`Garh-Comn is already running (process ${pid}). Stop it before starting another copy.`);
    }
  }
  fs.writeFileSync(lockPath, String(process.pid));
  return lockPath;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function ensureAdmin(db, config, { resetAdmin = false, allowGenerate = false, prompt = false } = {}) {
  const username = normalizeUsername(config.adminUsername || "admin");
  assertUsername(username);
  const existing = getUserByUsername(db, username) || db.get?.("SELECT * FROM users WHERE role = 'admin' ORDER BY id LIMIT 1");
  const anyUser = db.get ? db.get("SELECT id FROM users LIMIT 1") : null;
  if (resetAdmin) {
    const admin = getUserByUsername(db, username);
    if (!admin || admin.role !== "admin") throw new Error("No admin account matches that username yet. Start Garh-Comn once without --reset-admin.");
    const password = await resolvePassword(config, { allowGenerate: false, prompt });
    setPasswordHash(db, admin.id, hashPassword(password, config.bcryptRounds));
    deleteUserSessions(db, admin.id);
    console.log(`Admin password reset for ${admin.username}. Everyone using that account must sign in again.`);
    return { generatedPassword: null };
  }
  if (anyUser) return { generatedPassword: null, demo: false };
  let generated = null;
  let demo = false;
  let password = config.adminPassword;
  if (!password && config.demo) {
    password = "garh-demo";
    demo = true;
  }
  if (!password && prompt && stdin.isTTY) password = await promptPassword();
  if (!password && allowGenerate) {
    password = generatePassword();
    generated = password;
  }
  if (!password) {
    throw new Error("Set an admin password before the first start. At a terminal, Garh-Comn asks you to type one. Otherwise set adminPassword in config.json or ADMIN_PASSWORD. For a documented demo only, start with GARH_DEMO=1.");
  }
  assertPassword(password);
  const displayName = cleanDisplay(config.adminDisplayName);
  createUser(db, {
    username,
    displayName,
    passwordHash: hashPassword(password, config.bcryptRounds),
    role: "admin",
  });
  if (generated) {
    const file = path.join(config.dataDir, "admin-password.txt");
    fs.writeFileSync(file, `username: ${username}\npassword: ${generated}\n`, { mode: 0o600 });
  }
  return { generatedPassword: generated, username, demo };
}

async function resolvePassword(config, { prompt }) {
  if (config.adminPassword) {
    assertPassword(config.adminPassword);
    return config.adminPassword;
  }
  if (prompt && stdin.isTTY) return promptPassword();
  throw new Error("Set adminPassword in config.json or ADMIN_PASSWORD in the environment, then run again.");
}

function cleanDisplay(value) {
  const text = String(value || "Admin").replace(/[\u0000-\u001F]/g, "").trim();
  return text.slice(0, 40) || "Admin";
}

function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("error", onError);
      reject(error);
    };
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve(server.address().port);
    });
  });
}

export function printBanner({ https, port, dataDir, generatedPassword, username, demo = false }) {
  const scheme = https ? "https" : "http";
  const addresses = describeAddresses(lanAddresses(dataDir), https, port);
  console.log("");
  console.log("Garh-Comn is ready.");
  console.log("");
  console.log("  On this device");
  console.log(`    ${scheme}://127.0.0.1:${port}`);
  console.log("");
  if (addresses.length) {
    console.log("  On this network");
    for (const row of addresses) {
      console.log(`    ${row.url}   ${kindLabel(row.kind)} (${row.name})`);
    }
    console.log("");
    console.log("Open one of those network addresses on each phone.");
    console.log("If this tablet is plugged into a switch, use the Ethernet address.");
  } else {
    console.log("  No other network address yet.");
    console.log("  Plug in USB Ethernet or join Wi-Fi, then look at the admin screen.");
    console.log("  The address list updates when the adapter connects.");
  }
  console.log("");
  if (demo) {
    console.log("  DEMO MODE. Do not use this on a network you care about.");
    console.log(`  Admin username: ${username}`);
    console.log("  Admin password: garh-demo");
    console.log("");
  }
  if (generatedPassword) {
    console.log(`  First-run admin username: ${username}`);
    console.log(`  First-run admin password: ${generatedPassword}`);
    console.log("  This password is printed once. It is also in data/admin-password.txt.");
    console.log("  Delete that file after you sign in.");
    console.log("");
  }
  console.log("Accounts are created by the admin. There is no public sign-up.");
  console.log("");
}

export async function startHosting(overrides = {}) {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 18) {
    throw new Error(`Garh-Comn needs Node.js 18 or newer. This one is ${process.versions.node}.`);
  }
  const config = { ...loadConfig(), ...stripEmpty(overrides) };
  if (overrides.dataDir) config.dataDir = path.resolve(overrides.dataDir);
  if (overrides.adminPassword != null) config.adminPassword = String(overrides.adminPassword);
  fs.mkdirSync(config.dataDir, { recursive: true });
  const resetAdmin = overrides.resetAdmin ?? process.argv.includes("--reset-admin");
  const preview = await createApp(config);
  try {
    const bootstrap = await ensureAdmin(preview.db, config, {
      resetAdmin,
      allowGenerate: overrides.allowGenerate !== false,
      prompt: overrides.prompt !== false,
    });
    const host = config.host || "0.0.0.0";
    let port;
    const startPort = Number(config.port);
    const portToTry = Number.isFinite(startPort) ? startPort : 8787;
    let lastError;
    if (portToTry === 0) {
      port = await listen(preview.httpServer, host, 0);
    } else {
      for (let candidate = portToTry; candidate < portToTry + 10; candidate += 1) {
        try {
          port = await listen(preview.httpServer, host, candidate);
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          if (error.code !== "EADDRINUSE") throw error;
        }
      }
    }
    if (!port) throw lastError || new Error("No free port.");
    fs.writeFileSync(path.join(config.dataDir, "port.txt"), String(port));
    const lockPath = overrides.lock === false ? null : acquireLock(config.dataDir);
    if (!overrides.quiet) {
      printBanner({
        https: config.https,
        port,
        dataDir: config.dataDir,
      generatedPassword: bootstrap.generatedPassword,
      username: bootstrap.username || config.adminUsername,
      demo: bootstrap.demo,
      });
    }
    const stop = async () => {
      if (lockPath) {
        try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
      }
      await preview.close();
    };
    return {
      port,
      host: preview.httpServer.address().address,
      config,
      stop,
      db: preview.db,
      baseUrl: `${config.https ? "https" : "http"}://127.0.0.1:${port}`,
    };
  } catch (error) {
    await preview.close();
    throw error;
  }
}

function stripEmpty(overrides) {
  const out = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export async function main() {
  try {
    const hosted = await startHosting();
    const shutdown = async () => {
      console.log("\nStopping Garh-Comn.");
      await hosted.stop();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (error) {
    console.error(error.message || error);
    process.exit(1);
  }
}
