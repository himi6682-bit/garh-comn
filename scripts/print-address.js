import { loadConfig } from "../server/config.js";
import { describeAddresses, kindLabel, lanAddresses } from "../server/net.js";
import fs from "node:fs";
import path from "node:path";

const config = loadConfig();
let port = config.port;
const portFile = path.join(config.dataDir, "port.txt");
if (fs.existsSync(portFile)) port = Number(fs.readFileSync(portFile, "utf8").trim()) || port;
const scheme = config.https ? "https" : "http";
console.log(`${scheme}://127.0.0.1:${port}`);
for (const row of describeAddresses(lanAddresses(config.dataDir), config.https, port)) {
  console.log(`${row.url}   ${kindLabel(row.kind)} (${row.name})`);
}
