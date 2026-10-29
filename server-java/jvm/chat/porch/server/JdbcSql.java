package chat.porch.server;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class JdbcSql implements Sql {
    private final Connection connection;

    public JdbcSql(String file) {
        try {
            connection = DriverManager.getConnection("jdbc:sqlite:" + file);
            exec("PRAGMA foreign_keys = ON");
        } catch (SQLException error) {
            throw new IllegalStateException(error);
        }
    }

    @Override
    public synchronized void exec(String sql) {
        try (Statement statement = connection.createStatement()) {
            statement.execute(sql);
        } catch (SQLException error) {
            throw new IllegalStateException(error);
        }
    }

    @Override
    public synchronized void exec(String sql, Object... args) {
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            bind(statement, args);
            statement.executeUpdate();
        } catch (SQLException error) {
            throw new IllegalStateException(error);
        }
    }

    @Override
    public synchronized long insert(String sql, Object... args) {
        exec(sql, args);
        Row row = queryOne("SELECT last_insert_rowid() AS id");
        return row == null ? 0L : row.lng("id");
    }

    @Override
    public synchronized Row queryOne(String sql, Object... args) {
        List<Row> rows = query(sql, args);
        return rows.isEmpty() ? null : rows.get(0);
    }

    @Override
    public synchronized List<Row> query(String sql, Object... args) {
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            bind(statement, args);
            try (ResultSet results = statement.executeQuery()) {
                List<Row> rows = new ArrayList<Row>();
                ResultSetMetaData meta = results.getMetaData();
                while (results.next()) {
                    Map<String, Object> values = new LinkedHashMap<String, Object>();
                    for (int i = 1; i <= meta.getColumnCount(); i++) {
                        values.put(meta.getColumnLabel(i), results.getObject(i));
                    }
                    rows.add(new Row(values));
                }
                return rows;
            }
        } catch (SQLException error) {
            throw new IllegalStateException(error);
        }
    }

    @Override
    public synchronized void transaction(Runnable work) {
        try {
            connection.setAutoCommit(false);
            work.run();
            connection.commit();
        } catch (RuntimeException error) {
            rollback();
            throw error;
        } catch (SQLException error) {
            rollback();
            throw new IllegalStateException(error);
        } finally {
            try {
                connection.setAutoCommit(true);
            } catch (SQLException ignored) {
                // The connection is closing.
            }
        }
    }

    @Override
    public synchronized void close() {
        try {
            connection.close();
        } catch (SQLException ignored) {
            // Already closed.
        }
    }

    private void rollback() {
        try {
            connection.rollback();
        } catch (SQLException ignored) {
            // Keep the original error.
        }
    }

    private static void bind(PreparedStatement statement, Object[] args) throws SQLException {
        for (int i = 0; i < args.length; i++) {
            Object value = args[i];
            if (value == null) statement.setObject(i + 1, null);
            else if (value instanceof Integer) statement.setInt(i + 1, (Integer) value);
            else if (value instanceof Long) statement.setLong(i + 1, (Long) value);
            else statement.setString(i + 1, String.valueOf(value));
        }
    }
}
