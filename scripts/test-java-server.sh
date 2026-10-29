#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIB="${ROOT}/server-java/build/lib"
OUT="${ROOT}/server-java/build/classes"
mkdir -p "$LIB" "$OUT"
download() {
  local url="$1" dest="$2"
  if [[ ! -f "$dest" ]]; then
    curl -fsSL "$url" -o "$dest"
  fi
}
download https://repo1.maven.org/maven2/org/nanohttpd/nanohttpd/2.3.1/nanohttpd-2.3.1.jar "$LIB/nanohttpd.jar"
download https://repo1.maven.org/maven2/org/nanohttpd/nanohttpd-websocket/2.3.1/nanohttpd-websocket-2.3.1.jar "$LIB/nanohttpd-websocket.jar"
download https://repo1.maven.org/maven2/org/mindrot/jbcrypt/0.4/jbcrypt-0.4.jar "$LIB/jbcrypt.jar"
download https://repo1.maven.org/maven2/org/json/json/20240303/json-20240303.jar "$LIB/json.jar"
download https://repo1.maven.org/maven2/org/xerial/sqlite-jdbc/3.47.2.0/sqlite-jdbc-3.47.2.0.jar "$LIB/sqlite-jdbc.jar"
CP="$LIB/nanohttpd.jar:$LIB/nanohttpd-websocket.jar:$LIB/jbcrypt.jar:$LIB/json.jar:$LIB/sqlite-jdbc.jar"
find "$ROOT/server-java" -name '*.java' > "$OUT/sources.txt"
javac --release 17 -encoding UTF-8 -cp "$CP" -d "$OUT" @"$OUT/sources.txt"
java -cp "$OUT:$CP" chat.porch.server.Main --self-test
