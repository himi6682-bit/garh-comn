import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import express from "express";
import { dummyHash } from "./auth.js";
import { createLoginLimiter } from "./auth.js";
import { openDatabase } from "./db.js";
import { createPresence, attachRealtime } from "./realtime.js";
import { mountRoutes } from "./routes.js";
import { ensureEveryone } from "./store.js";

export async function createApp(config) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const uploadDir = path.join(config.dataDir, "uploads");
  fs.mkdirSync(uploadDir, { recursive: true });
  const db = await openDatabase(config.dataDir);
  ensureEveryone(db);
  const presence = createPresence();
  const limiter = createLoginLimiter();
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self' ws: wss:; manifest-src 'self'; worker-src 'self'",
    );
    next();
  });
  app.use(express.json({ limit: "64kb" }));

  let httpServer;
  if (config.https) {
    if (!fs.existsSync(config.certFile) || !fs.existsSync(config.keyFile)) {
      throw new Error("HTTPS is on, but data/cert.pem or data/key.pem is missing. Run: npm run cert");
    }
    httpServer = https.createServer(
      { cert: fs.readFileSync(config.certFile), key: fs.readFileSync(config.keyFile) },
      app,
    );
  } else {
    httpServer = http.createServer(app);
  }

  const ctx = {
    db,
    config,
    presence,
    limiter,
    uploadDir,
    httpServer,
    dummyHash: dummyHash(config.bcryptRounds),
  };
  mountRoutes(app, ctx);
  const publicDir = path.join(config.root, "public");
  app.use(express.static(publicDir, {
    index: "index.html",
    setHeaders(res, filePath) {
      if (/\.(html|css|js)$/.test(filePath) || filePath.endsWith("sw.js") || filePath.endsWith(".webmanifest")) {
        res.setHeader("Cache-Control", "no-cache");
      }
    },
  }));
  const realtime = attachRealtime(httpServer, ctx);

  async function close() {
    realtime.close();
    await new Promise((resolve) => {
      httpServer.close(() => resolve());
      httpServer.closeAllConnections?.();
    });
    db.close();
  }

  return { app, httpServer, db, config, close, presence };
}
