#!/usr/bin/env bash
# Builds an UNSIGNED iOS .ipa of Cal Track. SideStore / AltStore sign it with your free Apple ID when you install it, so
# nothing here needs your Apple ID or a paid developer account. Run from anywhere:   bash scripts/build-ios-ipa.sh
#
# Needs: Xcode.app (App Store), CocoaPods (`brew install cocoapods`), Node 22 + pnpm, and apps/app/.env (Supabase URL + anon key,
# baked into the build). Takes 10-30 minutes the first time (pod install + a Release compile).
# Output: build/CalTrack-unsigned.ipa  (build/ is git-ignored)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/build}"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
export EXPO_NO_TELEMETRY=1
export LANG="${LANG:-en_US.UTF-8}"   # CocoaPods refuses to run without a UTF-8 locale

fail() { echo "ERROR: $*" >&2; exit 1; }
[ -x "$DEVELOPER_DIR/usr/bin/xcodebuild" ] || fail "Xcode not found at $DEVELOPER_DIR (install Xcode from the App Store, or set DEVELOPER_DIR)"
command -v pod  >/dev/null || fail "CocoaPods missing: brew install cocoapods"
command -v node >/dev/null || fail "Node missing (nvm use 22)"
[ -f "$ROOT/apps/app/.env" ] || fail "apps/app/.env is missing: the Supabase URL and anon key are baked into the app at build time"
grep -q '^EXPO_PUBLIC_SUPABASE_URL=https://' "$ROOT/apps/app/.env" || fail "EXPO_PUBLIC_SUPABASE_URL in apps/app/.env is not set"

echo "==> Xcode: $("$DEVELOPER_DIR/usr/bin/xcodebuild" -version | head -1)"
cd "$ROOT/apps/app"

echo "==> Generating the native iOS project (expo prebuild) and installing pods"
npx expo prebuild --platform ios --clean

WORKSPACE="$(ls -d ios/*.xcworkspace | head -1)"
SCHEME="$(basename "$WORKSPACE" .xcworkspace)"
ARCHIVE="$OUT/$SCHEME.xcarchive"
rm -rf "$ARCHIVE" "$OUT/Payload" "$OUT/CalTrack-unsigned.ipa"
mkdir -p "$OUT"

echo "==> Archiving $SCHEME (Release, unsigned)"
"$DEVELOPER_DIR/usr/bin/xcodebuild" \
  -workspace "$WORKSPACE" -scheme "$SCHEME" \
  -configuration Release -sdk iphoneos -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE" \
  archive \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" \
  | tee "$OUT/xcodebuild.log" | tail -n 40

APP="$(find "$ARCHIVE/Products/Applications" -maxdepth 1 -name '*.app' | head -1)"
[ -n "$APP" ] || fail "no .app in the archive; see $OUT/xcodebuild.log"

# Embed the entitlements (HealthKit ...) with an AD-HOC signature. Without any signature the entitlements are not in the binary at all,
# SideStore/AltStore cannot see that the app wants HealthKit and iOS then answers "Missing com.apple.developer.healthkit entitlement".
# The tool replaces this signature with your Apple ID's when you install.
ENTITLEMENTS="$(ls "$ROOT"/apps/app/ios/*/*.entitlements 2>/dev/null | head -1 || true)"
if [ -n "$ENTITLEMENTS" ]; then
  echo "==> Embedding entitlements from ${ENTITLEMENTS#"$ROOT"/} (ad-hoc signature)"
  codesign --force --deep --sign - --entitlements "$ENTITLEMENTS" "$APP"
fi

echo "==> Packaging the .ipa"
mkdir -p "$OUT/Payload"
cp -R "$APP" "$OUT/Payload/"
(cd "$OUT" && zip -qry CalTrack-unsigned.ipa Payload && rm -rf Payload)

echo
echo "Done: $OUT/CalTrack-unsigned.ipa"
echo "Install it with SideStore or AltStore (they sign it with your free Apple ID; it expires after 7 days and is renewed from there)."
