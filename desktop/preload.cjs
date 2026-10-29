const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("porch", {
  needsSetup: () => ipcRenderer.invoke("needs-setup"),
  host: (details) => ipcRenderer.invoke("host", details),
  join: (url) => ipcRenderer.invoke("join", url),
  onHosts: (callback) => ipcRenderer.on("hosts", (_event, hosts) => callback(hosts)),
});
