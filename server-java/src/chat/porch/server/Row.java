package chat.porch.server;

import java.util.LinkedHashMap;
import java.util.Map;

public final class Row {
    private final Map<String, Object> values;

    public Row(Map<String, Object> values) {
        this.values = values;
    }

    public static Row of(String key, Object value) {
        Map<String, Object> map = new LinkedHashMap<String, Object>();
        map.put(key, value);
        return new Row(map);
    }

    public Object get(String key) {
        return values.get(key);
    }

    public boolean isNull(String key) {
        return values.get(key) == null;
    }

    public String str(String key) {
        Object value = values.get(key);
        return value == null ? null : String.valueOf(value);
    }

    public long lng(String key) {
        Object value = values.get(key);
        if (value == null) return 0L;
        if (value instanceof Number) return ((Number) value).longValue();
        return Long.parseLong(String.valueOf(value));
    }

    public boolean bool(String key) {
        return lng(key) != 0L;
    }
}
