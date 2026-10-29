#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/android-sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
if [[ ! -x "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" ]]; then
  echo "Android SDK not found at $ANDROID_HOME."
  echo "Install command-line tools, then: sdkmanager \"platforms;android-36\" \"build-tools;36.0.0\" \"platform-tools\""
  exit 1
fi
printf 'sdk.dir=%s\n' "$ANDROID_HOME" > "$ROOT/android/local.properties"
cd "$ROOT/android"
GRADLE="${GRADLE:-$HOME/gradle-8.14.3/bin/gradle}"
if [[ ! -x "$GRADLE" ]]; then
  GRADLE="$(command -v gradle)"
fi
"$GRADLE" assembleDebug --no-daemon
APK="$ROOT/android/app/build/outputs/apk/debug/app-debug.apk"
mkdir -p "$ROOT/dist"
cp "$APK" "$ROOT/dist/garh-comn.apk"
if [[ -d /opt/cursor/artifacts ]]; then
  cp "$APK" /opt/cursor/artifacts/garh-comn.apk
fi
echo "APK: $ROOT/dist/garh-comn.apk"
