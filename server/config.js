import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function configuredPassword(value) {
  const password = String(value ?? "").trim();
  if (!password || password === "change-this-password") return "";
  return password;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Could not read ${file}: ${error.message}`);
  }
}

export function loadConfig(env = process.env) {
  const configPath = env.PORCH_CONFIG || path.join(process.cwd(), "config.json");
  const rootConfig = path.join(ROOT, "config.json");
  const chosen = fs.existsSync(configPath) ? configPath : fs.existsSync(rootConfig) ? rootConfig : null;
  const file = chosen ? readJson(chosen) : {};
  const dataDir = path.resolve(ROOT, env.DATA_DIR || file.dataDir || "data");
  const port = Number(env.PORT || file.port || 8787);
  const maxUploadMb = Number(env.MAX_UPLOAD_MB || file.maxUploadMb || 8);
  return {
    root: ROOT,
    configPath: chosen,
    port: Number.isFinite(port) ? port : 8787,
    host: env.HOST || file.host || "0.0.0.0",
    dataDir,
    adminUsername: String(env.ADMIN_USERNAME || file.adminUsername || "admin").trim().toLowerCase(),
    adminPassword: configuredPassword(env.ADMIN_PASSWORD ?? file.adminPassword),
    adminDisplayName: String(env.ADMIN_DISPLAY_NAME || file.adminDisplayName || "Admin"),
    demo: env.GARH_DEMO === "1" || file.demo === true,
    https: env.PORCH_HTTPS === "1" || file.https === true,
    certFile: path.join(dataDir, "cert.pem"),
    keyFile: path.join(dataDir, "key.pem"),
    maxUploadMb: Number.isFinite(maxUploadMb) ? maxUploadMb : 8,
    sessionDays: Number(file.sessionDays || 30),
    bcryptRounds: Number(env.BCRYPT_ROUNDS || file.bcryptRounds || 10),
    discovery: env.PORCH_DISCOVERY !== "0" && file.discovery !== false,
  };
}
