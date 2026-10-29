package chat.porch.server;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Android's org.json methods throw a checked JSONException. Desktop org.json does not. */
public final class J {
    private J() {}

    public static JSONObject put(JSONObject object, String key, Object value) {
        try {
            return object.put(key, value);
        } catch (JSONException error) {
            throw new IllegalStateException(error);
        }
    }

    public static JSONArray put(JSONArray array, Object value) {
        return array.put(value);
    }
}
