package chat.porch.server;

import java.util.List;

public interface Sql {
    void exec(String sql);

    void exec(String sql, Object... args);

    long insert(String sql, Object... args);

    Row queryOne(String sql, Object... args);

    List<Row> query(String sql, Object... args);

    void transaction(Runnable work);

    void close();
}
