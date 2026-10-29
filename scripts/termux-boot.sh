#!/data/data/com.termux/files/usr/bin/bash
# Garh-Comn boot script for Termux:Boot.
# Copy to ~/.termux/boot/start-garh-comn.sh and chmod +x it.
# Edit GARH_HOME if you did not install in ~/garh-comn.

GARH_HOME="$HOME/garh-comn"
termux-wake-lock || true
cd "$GARH_HOME" || exit 1

for _ in 1 2 3 4 5 6 7 8 9 10; do
  if ip -4 addr show | grep -q 'inet '; then
    break
  fi
  sleep 3
done

mkdir -p "$GARH_HOME/data"
exec node server/index.js >> "$GARH_HOME/data/garh-comn.log" 2>&1
