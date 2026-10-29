import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import initSqlJs from "sql.js";

const require = createRequire(import.meta.url);

let sqlPromise;

function loadSql() {
  if (!sqlPromise) {
    sqlPromise = (async () => {
      let wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
      const unpacked = wasmPath.replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
      if (unpacked !== wasmPath && fs.existsSync(unpacked)) wasmPath = unpacked;
      const wasmBinary = fs.readFileSync(wasmPath);
      return initSqlJs({ wasmBinary });
    })();
  }
  return sqlPromise;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
  disabled INTEGER NOT NULL DEFAULT 0,
  color TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (type IN ('direct', 'group')),
  name TEXT,
  created_by INTEGER,
  is_everyone INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL,
  last_read_message_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id INTEGER,
  body TEXT NOT NULL DEFAULT '',
  attachment_id TEXT,
  attachment_name TEXT,
  attachment_mime TEXT,
  attachment_size INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS receipts (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL,
  delivered_at INTEGER,
  read_at INTEGER,
  PRIMARY KEY (message_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);
CREATE INDEX IF NOT EXISTS idx_receipts_user ON receipts(user_id, read_at);
CREATE INDEX IF NOT EXISTS idx_members_user ON conversation_members(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_everyone ON conversations(is_everyone) WHERE is_everyone = 1;
`;

export class AppDb {
  constructor(sqlDb, filePath) {
    this.sql = sqlDb;
    this.filePath = filePath;
    this.inTx = false;
    this.closed = false;
  }

  exec(sql) {
    this.sql.exec(sql);
  }

  run(sql, params = []) {
    this.sql.run(sql, params);
    const idRow = this.get("SELECT last_insert_rowid() AS id");
    const id = idRow ? Number(idRow.id) : 0;
    const changes = this.sql.getRowsModified();
    if (!this.inTx) this.save();
    return { id, changes };
  }

  get(sql, params = []) {
    const stmt = this.sql.prepare(sql);
    try {
      stmt.bind(params);
      if (!stmt.step()) return null;
      return stmt.getAsObject();
    } finally {
      stmt.free();
    }
  }

  all(sql, params = []) {
    const stmt = this.sql.prepare(sql);
    try {
      stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  }

  transaction(fn) {
    if (this.inTx) return fn();
    this.inTx = true;
    this.sql.run("BEGIN");
    try {
      const result = fn();
      this.sql.run("COMMIT");
      this.save();
      return result;
    } catch (error) {
      try {
        this.sql.run("ROLLBACK");
      } catch {
        // The transaction may already be closed.
      }
      throw error;
    } finally {
      this.inTx = false;
    }
  }

  save() {
    if (this.closed) return;
    const data = this.sql.export();
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, Buffer.from(data));
    fs.renameSync(tmp, this.filePath);
  }

  close() {
    if (this.closed) return;
    this.save();
    this.closed = true;
    this.sql.close();
  }
}

function migrate(db) {
  db.exec(SCHEMA);
  const version = db.get("SELECT value FROM meta WHERE key = ?", ["schema_version"]);
  if (!version) {
    db.run("INSERT INTO meta (key, value) VALUES (?, ?)", ["schema_version", "1"]);
  }
  db.run("DELETE FROM sessions WHERE expires_at <= ?", [Date.now()]);
}

export async function openDatabase(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const filePath = path.join(dataDir, "porch.db");
  const SQL = await loadSql();
  const existing = fs.existsSync(filePath) ? new Uint8Array(fs.readFileSync(filePath)) : null;
  const sqlDb = existing ? new SQL.Database(existing) : new SQL.Database();
  sqlDb.run("PRAGMA foreign_keys = ON");
  const db = new AppDb(sqlDb, filePath);
  migrate(db);
  return db;
}
