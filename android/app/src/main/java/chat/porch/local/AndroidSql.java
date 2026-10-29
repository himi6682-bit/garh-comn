package chat.porch.local;

import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteStatement;

import chat.porch.server.Row;
import chat.porch.server.Sql;

import java.io.File;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class AndroidSql implements Sql {
    private final SQLiteDatabase database;

    public AndroidSql(File file) {
        File parent = file.getParentFile();
        if (parent != null) parent.mkdirs();
        database = SQLiteDatabase.openOrCreateDatabase(file, null);
        database.setForeignKeyConstraintsEnabled(true);
    }

    @Override
    public synchronized void exec(String sql) {
        database.execSQL(sql);
    }

    @Override
    public synchronized void exec(String sql, Object... args) {
        database.execSQL(sql, args);
    }

    @Override
    public synchronized long insert(String sql, Object... args) {
        SQLiteStatement statement = database.compileStatement(sql);
        try {
            bind(statement, args);
            return statement.executeInsert();
        } finally {
            statement.close();
        }
    }

    @Override
    public synchronized Row queryOne(String sql, Object... args) {
        List<Row> rows = query(sql, args);
        return rows.isEmpty() ? null : rows.get(0);
    }

    @Override
    public synchronized List<Row> query(String sql, Object... args) {
        String[] bound = new String[args.length];
        for (int i = 0; i < args.length; i++) bound[i] = args[i] == null ? null : String.valueOf(args[i]);
        Cursor cursor = database.rawQuery(sql, bound);
        try {
            List<Row> rows = new ArrayList<Row>();
            while (cursor.moveToNext()) {
                Map<String, Object> values = new LinkedHashMap<String, Object>();
                for (int i = 0; i < cursor.getColumnCount(); i++) {
                    String name = cursor.getColumnName(i);
                    if (cursor.isNull(i)) values.put(name, null);
                    else if (cursor.getType(i) == Cursor.FIELD_TYPE_INTEGER) values.put(name, cursor.getLong(i));
                    else if (cursor.getType(i) == Cursor.FIELD_TYPE_FLOAT) values.put(name, cursor.getDouble(i));
                    else values.put(name, cursor.getString(i));
                }
                rows.add(new Row(values));
            }
            return rows;
        } finally {
            cursor.close();
        }
    }

    @Override
    public synchronized void transaction(Runnable work) {
        database.beginTransaction();
        try {
            work.run();
            database.setTransactionSuccessful();
        } finally {
            database.endTransaction();
        }
    }

    @Override
    public synchronized void close() {
        database.close();
    }

    private static void bind(SQLiteStatement statement, Object[] args) {
        for (int i = 0; i < args.length; i++) {
            Object value = args[i];
            if (value == null) statement.bindNull(i + 1);
            else if (value instanceof Integer) statement.bindLong(i + 1, (Integer) value);
            else if (value instanceof Long) statement.bindLong(i + 1, (Long) value);
            else statement.bindString(i + 1, String.valueOf(value));
        }
    }
}
