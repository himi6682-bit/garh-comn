import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = path.resolve("data");
fs.mkdirSync(dataDir, { recursive: true });
const names = new Set(["IP:127.0.0.1", "DNS:localhost", "DNS:porch.local"]);
for (const addrs of Object.values(os.networkInterfaces())) {
  for (const addr of addrs || []) {
    if ((addr.family === "IPv4" || addr.family === 4) && !addr.internal) names.add(`IP:${addr.address}`);
  }
}
try {
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-days", "825", "-nodes",
    "-keyout", path.join(dataDir, "key.pem"),
    "-out", path.join(dataDir, "cert.pem"),
    "-subj", "/CN=porch.local",
    "-addext", `subjectAltName=${[...names].join(",")}`,
  ], { stdio: "inherit" });
} catch (error) {
  console.error("Could not run openssl. On Termux: pkg install openssl");
  process.exit(1);
}
console.log("Wrote data/cert.pem and data/key.pem");
console.log('Set "https": true in config.json and start Garh-Comn again.');
console.log("Each phone must open the https address once and accept the certificate warning.");
