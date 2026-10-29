import dgram from "node:dgram";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage } from "electron";
import { startHosting } from "../server/main.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let hosted = null;
let chatWindow = null;
let chooser = null;
let tray = null;
const foundHosts = new Map();

function isPrivate(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(hostname);
}

function dataDir() {
  return path.join(app.getPath("userData"), "data");
}

function needsSetup() {
  return !fs.existsSync(path.join(dataDir(), "porch.db"));
}

function openChat(url) {
  if (chatWindow && !chatWindow.isDestroyed()) {
    chatWindow.loadURL(url);
    chatWindow.show();
    chatWindow.focus();
    return chatWindow;
  }
  chatWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 380,
    minHeight: 560,
    title: "Garh-Comn",
    autoHideMenuBar: true,
    backgroundColor: "#100e0c",
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  chatWindow.loadURL(url);
  chatWindow.on("close", (event) => {
    if (hosted && !app.isQuitting) {
      event.preventDefault();
      chatWindow.hide();
    }
  });
  return chatWindow;
}

async function becomeHost(details) {
  if (hosted) {
    openChat(hosted.baseUrl);
    return { ok: true, url: hosted.baseUrl };
  }
  const firstRun = needsSetup();
  if (firstRun && String(details?.password || "").length < 8) {
    return { error: "Choose an admin password with at least 8 characters." };
  }
  fs.mkdirSync(dataDir(), { recursive: true });
  hosted = await startHosting({
    dataDir: dataDir(),
    host: "0.0.0.0",
    port: 8787,
    adminUsername: details?.username || "admin",
    adminPassword: details?.password || "",
    adminDisplayName: details?.displayName || "Admin",
    prompt: false,
    allowGenerate: false,
    quiet: false,
    discovery: true,
  });
  installTray();
  openChat(hosted.baseUrl);
  return { ok: true, url: hosted.baseUrl };
}

function installTray() {
  if (tray) return;
  const iconPath = path.join(ROOT, "public", "icons", "icon-32.png");
  const image = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  tray = new Tray(image.isEmpty() ? nativeImage.createFromDataURL("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAA4AAAAOCAYAAAAfSC3RAAAAHElEQVQ4T2NkoBAwUqifAWMGKgxM/P//fwYkAAB4sQh2o7m0tQAAAABJRU5ErkJggg==") : image);
  tray.setToolTip("Garh-Comn is hosting");
  const menu = Menu.buildFromTemplate([
    { label: "Open chat", click: () => hosted && openChat(hosted.baseUrl) },
    { label: "Quit Garh-Comn", click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on("click", () => hosted && openChat(hosted.baseUrl));
}

function openChooser() {
  chooser = new BrowserWindow({
    width: 560,
    height: 720,
    title: "Garh-Comn",
    autoHideMenuBar: true,
    backgroundColor: "#100e0c",
    webPreferences: {
      preload: path.join(ROOT, "desktop", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  chooser.loadFile(path.join(ROOT, "desktop", "chooser.html"));
  listenForHosts();
}

function listenForHosts() {
  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
  socket.on("message", (message) => {
    try {
      const payload = JSON.parse(message.toString());
      if (payload.app !== "porch") return;
      const key = (payload.addresses || []).map((row) => row.url).join("|");
      foundHosts.set(key, payload);
      if (chooser && !chooser.isDestroyed()) chooser.webContents.send("hosts", [...foundHosts.values()]);
    } catch {
      // Ignore other broadcasts.
    }
  });
  socket.on("error", () => socket.close());
  socket.bind(45878);
}

app.on("certificate-error", (event, _contents, url, _error, _certificate, callback) => {
  try {
    if (isPrivate(new URL(url).hostname)) {
      event.preventDefault();
      callback(true);
      return;
    }
  } catch {
    // Fall through and reject the certificate.
  }
  callback(false);
});

app.whenReady().then(() => {
  ipcMain.handle("needs-setup", () => needsSetup());
  ipcMain.handle("host", async (_event, details) => {
    try {
      return await becomeHost(details);
    } catch (error) {
      return { error: error.message || String(error) };
    }
  });
  ipcMain.handle("join", (_event, raw) => {
    let url = String(raw || "").trim();
    if (!url) return { error: "Enter the address shown on the host." };
    if (!url.includes("://")) url = `http://${url}`;
    try {
      const parsed = new URL(url);
      if (!parsed.port) parsed.port = "8787";
      openChat(parsed.toString());
      return { ok: true };
    } catch {
      return { error: "That address is not a valid URL." };
    }
  });
  openChooser();
});

let stopping = false;

app.on("before-quit", (event) => {
  app.isQuitting = true;
  if (!hosted || stopping) return;
  stopping = true;
  event.preventDefault();
  const closing = hosted;
  hosted = null;
  closing.stop().finally(() => app.quit());
});

app.on("window-all-closed", () => {
  if (!hosted) app.quit();
});
