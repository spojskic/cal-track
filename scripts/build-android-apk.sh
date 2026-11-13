#!/usr/bin/env bash
# Builds an installable Android .apk of Ration (a release build, signed with Expo's default debug key: fine for sideloading and
# for a GitHub release, not for Google Play). Run from anywhere:   bash scripts/build-android-apk.sh [output-dir]
#
# Needs: JDK 17 (JAVA_HOME), the Android SDK (Android Studio installs it; ANDROID_HOME or ~/Library/Android/sdk), Node 22 + pnpm,
# and apps/app/.env (Supabase URL + anon key, baked into the build). Takes 10-20 minutes the first time (Gradle downloads a lot).
# Output: build/Ration-<version>.apk  (build/ is git-ignored)
#
# ANDROID_ABIS (default arm64-v8a,x86_64) limits the CPU architectures in the file, which keeps it small. Use
# ANDROID_ABIS=arm64-v8a,armeabi-v7a,x86_64,x86 for every architecture.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/build}"
export EXPO_NO_TELEMETRY=1

fail() { echo "ERROR: $*" >&2; exit 1; }
command -v node >/dev/null || fail "Node missing (nvm use 22)"
command -v java >/dev/null || fail "JDK missing: install JDK 17 (brew install --cask zulu@17) and set JAVA_HOME"
[ -f "$ROOT/apps/app/.env" ] || fail "apps/app/.env is missing: the Supabase URL and anon key are baked into the app at build time"
grep -q '^EXPO_PUBLIC_SUPABASE_URL=https://' "$ROOT/apps/app/.env" || fail "EXPO_PUBLIC_SUPABASE_URL in apps/app/.env is not set"

JAVA_MAJOR="$(java -version 2>&1 | sed -n '1s/.*version "\([0-9]*\).*/\1/p')"
if [ "${JAVA_MAJOR:-0}" -lt 17 ] || [ "${JAVA_MAJOR:-0}" -gt 21 ]; then
  echo "WARNING: java $JAVA_MAJOR found; the Android build is tested with JDK 17 (point JAVA_HOME at one if Gradle complains)" >&2
fi

SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [ -z "$SDK" ]; then
  for candidate in "$HOME/Library/Android/sdk" "$HOME/Android/Sdk"; do
    [ -d "$candidate" ] && SDK="$candidate" && break
  done
fi
[ -n "$SDK" ] && [ -d "$SDK" ] || fail "Android SDK not found: install Android Studio, open it once, or set ANDROID_HOME"
export ANDROID_HOME="$SDK"

# arm64-v8a + x86_64: phones and emulators, one file. The Gradle flags are the laptop-safe shape of the
# startup-crash fix era (capped heap, 2 workers, no daemon - a bare `./gradlew assembleRelease` OOMs a 15 GB
# machine during a release build); they also work on bigger machines, just a bit slower. Override with
# GRADLE_FLAGS="..." (word-split, so quote the -D value yourself) or ANDROID_ABIS for other architectures.
ABIS="${ANDROID_ABIS:-arm64-v8a,x86_64}"
if [ -n "${GRADLE_FLAGS:-}" ]; then
  # shellcheck disable=SC2086
  set -- $GRADLE_FLAGS
else
  set -- -Dorg.gradle.jvmargs="-Xmx2g -XX:MaxMetaspaceSize=512m" -Dorg.gradle.workers.max=2 --no-daemon
fi
VERSION="$(node -p "require('$ROOT/apps/app/app.json').expo.version")"

cd "$ROOT/apps/app"
echo "==> Generating the native Android project (expo prebuild)"
npx expo prebuild --platform android --clean
printf 'sdk.dir=%s\n' "$SDK" > android/local.properties

echo "==> Building the release APK with Gradle (architectures: $ABIS)"
(cd android && ./gradlew assembleRelease "-PreactNativeArchitectures=$ABIS" "$@" | tail -n 40)

APK="android/app/build/outputs/apk/release/app-release.apk"
[ -f "$APK" ] || fail "no APK at apps/app/$APK; see the Gradle output above"

mkdir -p "$OUT"
cp "$APK" "$OUT/Ration-$VERSION.apk"
echo
echo "==> Done: $OUT/Ration-$VERSION.apk ($(du -h "$OUT/Ration-$VERSION.apk" | cut -f1))"
shasum -a 256 "$OUT/Ration-$VERSION.apk" | cut -d' ' -f1 | sed 's/^/    sha256: /'
echo "    Send it to a phone and open it (allow \"install unknown apps\" for the app you open it with)."
