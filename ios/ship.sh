#!/bin/bash
#
# Build BIES for iOS and upload it to TestFlight.
#
#   ios/ship.sh              build, archive, export, validate, upload
#   ios/ship.sh --dry-run    everything except the upload
#
# Steps: the native web bundle (production URLs from .env.native), cap sync,
# the next build number, an archive, an export re-signed with the Apple
# Distribution identity, a check that it really is distribution-signed, then
# altool validate and upload. Signing is automatic: Xcode registers the bundle
# ID and makes the profiles itself, through the App Store Connect API key.
#
# Needs ios/.asc-credentials (gitignored):
#   ASC_ISSUER_ID=<uuid: App Store Connect → Users and Access → Integrations>
#   ASC_KEY_ID=<key id; its AuthKey_<id>.p8 lives in ~/.appstoreconnect/private_keys>
#   ASC_TEAM_ID=<Apple Developer team id>
# The private key itself is never read here: xcodebuild and altool find it.
#
# Before the first upload, the app needs a record in App Store Connect (My Apps
# → + → New App, bundle ID com.bies.app). The API can't create one.

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT=$(pwd)
IOS="$ROOT/ios/App"

DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

# --- credentials ------------------------------------------------------------

CREDS="$ROOT/ios/.asc-credentials"
if [[ ! -f "$CREDS" ]]; then
    echo "error: ios/.asc-credentials is missing (it is gitignored). It needs:" >&2
    echo "  ASC_ISSUER_ID=...  ASC_KEY_ID=...  ASC_TEAM_ID=..." >&2
    exit 1
fi
# shellcheck disable=SC1090
source "$CREDS"

KEY_PATH="$HOME/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8"
if [[ ! -f "$KEY_PATH" ]]; then
    echo "error: no private key at $KEY_PATH. A .p8 downloads only once;" >&2
    echo "if it is lost, make a new key in App Store Connect and update ASC_KEY_ID." >&2
    exit 1
fi
AUTH=(-authenticationKeyPath "$KEY_PATH" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")

if [[ ! -f "$ROOT/.env.native" && ! -f "$ROOT/.env.native.local" ]]; then
    echo "error: .env.native is missing: the app would call /api on capacitor://localhost." >&2
    echo "Copy .env.native.example and set the production URLs." >&2
    exit 1
fi

# --- web bundle -------------------------------------------------------------

echo "==> native web build + cap sync"
SYNC_LOG=$(mktemp)
if ! npm run --silent cap:sync >"$SYNC_LOG" 2>&1; then
    tail -20 "$SYNC_LOG" >&2
    echo "error: the native build or cap sync failed (log: $SYNC_LOG)" >&2
    exit 1
fi
# The bundle must call the production API, not /api on capacitor://localhost.
# Vite reads .env.native, then .env.native.local over it.
API_URL=""
for f in "$ROOT/.env.native" "$ROOT/.env.native.local"; do
    [[ -f "$f" ]] || continue
    line=$(grep '^VITE_API_URL=' "$f" | tail -1 || true)
    [[ -n "$line" ]] && API_URL=${line#VITE_API_URL=}
done
if [[ -z "$API_URL" ]] || ! grep -rqF "$API_URL" "$IOS/App/public/assets"; then
    echo "error: the synced bundle doesn't contain VITE_API_URL ($API_URL)" >&2
    exit 1
fi
echo "    API: $API_URL"

# --- build number -----------------------------------------------------------

# Unique and increasing for each upload: App Store Connect refuses a repeat.
PBXPROJ="$IOS/App.xcodeproj/project.pbxproj"
CURRENT=$(grep -m1 'CURRENT_PROJECT_VERSION = ' "$PBXPROJ" | sed 's/[^0-9]//g')
NEXT=$((CURRENT + 1))
echo "==> build $CURRENT -> $NEXT"
sed -i '' "s/CURRENT_PROJECT_VERSION = ${CURRENT};/CURRENT_PROJECT_VERSION = ${NEXT};/g" "$PBXPROJ"

# If this run fails before producing a build, put the number back.
KEEP_NUMBER=false
SIGCHECK=""
on_exit() {
    [[ -n "$SIGCHECK" ]] && rm -rf "$SIGCHECK"
    if ! $KEEP_NUMBER; then
        sed -i '' "s/CURRENT_PROJECT_VERSION = ${NEXT};/CURRENT_PROJECT_VERSION = ${CURRENT};/g" "$PBXPROJ"
        echo "    (build number put back to $CURRENT)" >&2
    fi
}
trap on_exit EXIT

# Not ios/App/build: cap sync's pod install runs an Xcode clean, which refuses
# to delete a build folder that Xcode didn't make, and the sync fails.
BUILD="$ROOT/ios/archives"
ARCHIVE="$BUILD/BIES${NEXT}.xcarchive"
EXPORT="$BUILD/export${NEXT}"
mkdir -p "$BUILD"

# --- archive ----------------------------------------------------------------

echo "==> archiving"
xcodebuild -workspace "$IOS/App.xcworkspace" -scheme App -configuration Release \
    -destination 'generic/platform=iOS' -archivePath "$ARCHIVE" \
    DEVELOPMENT_TEAM="$ASC_TEAM_ID" \
    -allowProvisioningUpdates "${AUTH[@]}" archive \
    | grep -E 'error:|ARCHIVE (SUCCEEDED|FAILED)' || true
[[ -d "$ARCHIVE" ]] || { echo "error: archive failed" >&2; exit 1; }

# --- export -----------------------------------------------------------------

# The archive is signed for development; the export re-signs it for the store.
cat > "$BUILD/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key>
    <string>app-store-connect</string>
    <key>teamID</key>
    <string>${ASC_TEAM_ID}</string>
    <key>uploadSymbols</key>
    <true/>
    <key>signingStyle</key>
    <string>automatic</string>
    <key>destination</key>
    <string>export</string>
</dict>
</plist>
PLIST

echo "==> exporting"
xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportPath "$EXPORT" \
    -exportOptionsPlist "$BUILD/ExportOptions.plist" -allowProvisioningUpdates "${AUTH[@]}" \
    | tail -3

IPA=$(ls "$EXPORT"/*.ipa 2>/dev/null | head -1)
[[ -n "$IPA" ]] || { echo "error: no .ipa in $EXPORT" >&2; exit 1; }

# A development-signed build uploads fine and fails processing an hour later.
# Look inside the .ipa (a zip): codesign on the zip itself says "not signed".
SIGCHECK=$(mktemp -d)
unzip -o -q "$IPA" -d "$SIGCHECK"
# Captured, not piped: under pipefail, grep -q closing the pipe early would
# fail a perfectly signed build.
SIGNATURE=$(codesign -dvvv "$SIGCHECK"/Payload/*.app 2>&1 || true)
if ! printf '%s\n' "$SIGNATURE" | grep -q "Apple Distribution"; then
    echo "error: the app in $IPA is not signed with an Apple Distribution identity" >&2
    printf '%s\n' "$SIGNATURE" | grep Authority >&2 || true
    exit 1
fi
echo "==> signed: Apple Distribution"

# --- validate, then upload --------------------------------------------------

echo "==> validating"
xcrun altool --validate-app -f "$IPA" -t ios --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID" | tail -4

if $DRY_RUN; then
    echo "==> dry run: not uploading. Build $NEXT is at $IPA (number not kept)"
    exit 0
fi

echo "==> uploading"
xcrun altool --upload-app -f "$IPA" -t ios --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID" | tail -5
KEEP_NUMBER=true

echo
echo "==> build $NEXT uploaded. Processing takes 5-30 minutes; then it is under"
echo "    TestFlight in App Store Connect. Internal testers need no review."
echo "    Commit the build number bump in ios/App/App.xcodeproj/project.pbxproj."
