package chat.porch.server;

public final class Schema {
    static final String SQL =
            "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);"
                    + "CREATE TABLE IF NOT EXISTS users ("
                    + "id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,"
                    + "password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('admin','user')),"
                    + "disabled INTEGER NOT NULL DEFAULT 0, color TEXT NOT NULL, created_at INTEGER NOT NULL);"
                    + "CREATE TABLE IF NOT EXISTS sessions ("
                    + "token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,"
                    + "created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);"
                    + "CREATE TABLE IF NOT EXISTS conversations ("
                    + "id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL CHECK (type IN ('direct','group')),"
                    + "name TEXT, created_by INTEGER, is_everyone INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);"
                    + "CREATE TABLE IF NOT EXISTS conversation_members ("
                    + "conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,"
                    + "user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,"
                    + "joined_at INTEGER NOT NULL, last_read_message_id INTEGER NOT NULL DEFAULT 0,"
                    + "PRIMARY KEY (conversation_id, user_id));"
                    + "CREATE TABLE IF NOT EXISTS messages ("
                    + "id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,"
                    + "sender_id INTEGER, body TEXT NOT NULL DEFAULT '', attachment_id TEXT, attachment_name TEXT,"
                    + "attachment_mime TEXT, attachment_size INTEGER, created_at INTEGER NOT NULL);"
                    + "CREATE TABLE IF NOT EXISTS receipts ("
                    + "message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,"
                    + "user_id INTEGER NOT NULL, delivered_at INTEGER, read_at INTEGER, PRIMARY KEY (message_id, user_id));"
                    + "CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);"
                    + "CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);"
                    + "CREATE INDEX IF NOT EXISTS idx_receipts_user ON receipts(user_id, read_at);"
                    + "CREATE INDEX IF NOT EXISTS idx_members_user ON conversation_members(user_id);"
                    + "CREATE UNIQUE INDEX IF NOT EXISTS idx_one_everyone ON conversations(is_everyone) WHERE is_everyone = 1;";

    private Schema() {}

    public static void migrate(Sql db) {
        for (String statement : SQL.split(";")) {
            String sql = statement.trim();
            if (!sql.isEmpty()) db.exec(sql);
        }
        Row version = db.queryOne("SELECT value FROM meta WHERE key = ?", "schema_version");
        if (version == null) db.exec("INSERT INTO meta (key, value) VALUES (?, ?)", "schema_version", "1");
        db.exec("DELETE FROM sessions WHERE expires_at <= ?", System.currentTimeMillis());
    }
}
