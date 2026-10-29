import assert from "node:assert/strict";
import test from "node:test";
import { interfaceKind, ipv4Broadcast, kindLabel, mergeAddresses } from "../server/net.js";
import { loadConfig } from "../server/config.js";

test("usb ethernet addresses are kept beside wifi", () => {
  assert.equal(interfaceKind("eth0"), "ethernet");
  assert.equal(interfaceKind("rndis0"), "ethernet");
  assert.equal(interfaceKind("wlan0"), "wifi");
  assert.equal(kindLabel("ethernet"), "Ethernet");
  const merged = mergeAddresses(
    [{ name: "wlan0", address: "192.168.1.15", kind: "wifi", broadcast: "192.168.1.255" }],
    [{ name: "eth0", address: "192.168.4.20", kind: "ethernet" }],
  );
  assert.deepEqual(merged.map((row) => row.address), ["192.168.4.20", "192.168.1.15"]);
  assert.equal(merged[0].kind, "ethernet");
});

test("broadcast address uses the interface mask", () => {
  assert.equal(ipv4Broadcast("192.168.4.20", "255.255.255.0"), "192.168.4.255");
});

test("the server defaults to every network interface", () => {
  const config = loadConfig({ PORT: "", HOST: "", DATA_DIR: "", PORCH_HTTPS: "", ADMIN_PASSWORD: "" });
  assert.equal(config.host, "0.0.0.0");
});
