import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SKIP_INTERFACE = /^(lo|docker|br-|veth|virbr|tun|tap|wg|zt|cni|flannel|dummy)/;

export function interfaceKind(name = "") {
  const n = String(name).toLowerCase();
  if (n.includes("wi-fi") || n.includes("wifi") || n.includes("wlan") || /^(wl|wlp)/.test(n)) return "wifi";
  if (
    n.includes("ethernet") ||
    n.includes("usb") ||
    n.includes("rndis") ||
    n.includes("ncm") ||
    /^(eth|enx|enp|eno|lan)/.test(n)
  ) {
    return "ethernet";
  }
  return "other";
}

export function kindLabel(kind) {
  if (kind === "ethernet") return "Ethernet";
  if (kind === "wifi") return "Wi-Fi";
  return "Other";
}

function isUsefulV4(address) {
  if (!address || address.startsWith("127.") || address.startsWith("169.254.")) return false;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(address);
}

export function ipv4Broadcast(address, netmask) {
  if (!address || !netmask) return null;
  const ip = address.split(".");
  const mask = netmask.split(".");
  if (ip.length !== 4 || mask.length !== 4) return null;
  const out = [];
  for (let i = 0; i < 4; i += 1) {
    const a = Number(ip[i]);
    const m = Number(mask[i]);
    if (!Number.isInteger(a) || !Number.isInteger(m)) return null;
    out.push((a | (~m & 255)) & 255);
  }
  return out.join(".");
}

export function osAddresses() {
  const preferred = [];
  const fallback = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const addr of addrs || []) {
      const v4 = addr.family === "IPv4" || addr.family === 4;
      if (!v4 || addr.internal || !isUsefulV4(addr.address)) continue;
      const entry = {
        name,
        address: addr.address,
        kind: interfaceKind(name),
        broadcast: ipv4Broadcast(addr.address, addr.netmask),
      };
      if (SKIP_INTERFACE.test(name)) fallback.push(entry);
      else preferred.push(entry);
    }
  }
  return preferred.length ? preferred : fallback;
}

export function readAdvertised(dataDir) {
  if (!dataDir) return [];
  try {
    const raw = fs.readFileSync(path.join(dataDir, "advertise-ips.json"), "utf8");
    const json = JSON.parse(raw);
    const rows = Array.isArray(json.addresses) ? json.addresses : [];
    return rows
      .filter((row) => row && isUsefulV4(row.address))
      .map((row) => ({
        name: String(row.name || "advertised"),
        address: row.address,
        kind: row.kind === "wifi" || row.kind === "ethernet" ? row.kind : interfaceKind(row.name || ""),
        broadcast: row.broadcast || null,
      }));
  } catch {
    return [];
  }
}

export function mergeAddresses(fromOs, extra = []) {
  const byIp = new Map();
  for (const row of fromOs) byIp.set(row.address, { ...row });
  for (const row of extra) {
    const prev = byIp.get(row.address);
    byIp.set(row.address, {
      name: row.name || prev?.name || "network",
      address: row.address,
      kind: row.kind || prev?.kind || "other",
      broadcast: row.broadcast || prev?.broadcast || null,
    });
  }
  return [...byIp.values()].sort((a, b) => {
    const rank = { ethernet: 0, wifi: 1, other: 2 };
    return (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9) || a.address.localeCompare(b.address);
  });
}

export function lanAddresses(dataDir) {
  return mergeAddresses(osAddresses(), readAdvertised(dataDir));
}

export function origin(https, address, port) {
  return `${https ? "https" : "http"}://${address}:${port}`;
}

export function describeAddresses(addresses, https, port) {
  return addresses.map((row) => ({
    ...row,
    label: kindLabel(row.kind),
    url: origin(https, row.address, port),
  }));
}
