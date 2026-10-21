#!/bin/bash
#
# Build the signed BIES app bundle (.aab) for Google Play.
#
#   android/ship.sh              next version code, then build
#   android/ship.sh --no-bump    build with the current version code
#
# Steps: the native web bundle (production URLs from .env.native), cap sync
# for Android, a version code one higher than the last (Play refuses a repeat),
# a release bundle signed with the upload key, and a check that it really is
# signed with that key. Upload the bundle in Play Console yourself.
#
# Needs the upload key in ~/.bies-android (android/make-upload-key.sh makes it).
# Its password is read by Gradle from there and never printed.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
ANDROID="$ROOT/android"
BUMP=true
[[ "${1:-}" == "--no-bump" ]] && BUMP=false

export JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
KEYTOOL="$JAVA_HOME/bin/keytool"

# --- upload key -------------------------------------------------------------

PROPS="$HOME/.bies-android/keystore.properties"
if [[ ! -f "$PROPS" ]]; then
    echo "error: no upload key. Run android/make-upload-key.sh first." >&2
    exit 1
fi
if [[ ! -f "$ROOT/.env.native" && ! -f "$ROOT/.env.native.local" ]]; then
    echo "error: .env.native is missing: the app would call /api on https://localhost." >&2
    echo "Copy .env.native.example and set the production URLs." >&2
    exit 1
fi

# --- web bundle -------------------------------------------------------------

echo "==> native web build + cap sync android"
SYNC_LOG=$(mktemp)
if ! { npx vite build --mode native && npx cap sync android; } >"$SYNC_LOG" 2>&1; then
    tail -20 "$SYNC_LOG" >&2
    echo "error: the native build or cap sync failed (log: $SYNC_LOG)" >&2
    exit 1
fi
# The bundle must call the production API, not /api on https://localhost.
API_URL=""
for f in "$ROOT/.env.native" "$ROOT/.env.native.local"; do
    [[ -f "$f" ]] || continue
    line=$(grep '^VITE_API_URL=' "$f" | tail -1 || true)
    [[ -n "$line" ]] && API_URL=${line#VITE_API_URL=}
done
if [[ -z "$API_URL" ]] || ! grep -rqF "$API_URL" "$ANDROID/app/src/main/assets/public/assets"; then
    echo "error: the synced bundle doesn't contain VITE_API_URL ($API_URL)" >&2
    exit 1
fi
echo "    API: $API_URL"

# --- version code -----------------------------------------------------------

GRADLE="$ANDROID/app/build.gradle"
CURRENT=$(grep -m1 -E '^\s*versionCode [0-9]+' "$GRADLE" | sed 's/[^0-9]//g')
CODE=$CURRENT
KEEP_NUMBER=true
if $BUMP; then
    CODE=$((CURRENT + 1))
    sed -i '' -E "s/^([[:space:]]*versionCode )${CURRENT}\$/\1${CODE}/" "$GRADLE"
    KEEP_NUMBER=false
fi
echo "==> version code $CODE"
# If this run fails before producing a bundle, put the number back.
on_exit() {
    if ! $KEEP_NUMBER; then
        sed -i '' -E "s/^([[:space:]]*versionCode )${CODE}\$/\1${CURRENT}/" "$GRADLE"
        echo "    (version code put back to $CURRENT)" >&2
    fi
}
trap on_exit EXIT

# --- bundle -----------------------------------------------------------------

echo "==> building the release bundle"
BUILD_LOG=$(mktemp)
if ! (cd "$ANDROID" && ./gradlew -q bundleRelease) >"$BUILD_LOG" 2>&1; then
    grep -iE 'error|failed|what went wrong' "$BUILD_LOG" | head -20 >&2 || tail -20 "$BUILD_LOG" >&2
    echo "error: the build failed (log: $BUILD_LOG)" >&2
    exit 1
fi
AAB="$ANDROID/app/build/outputs/bundle/release/app-release.aab"
[[ -f "$AAB" ]] || { echo "error: no bundle at $AAB" >&2; exit 1; }

# --- signature check --------------------------------------------------------

# Signed with the upload key, not unsigned or with the debug key.
CERT=$("$KEYTOOL" -printcert -jarfile "$AAB" 2>/dev/null || true)
if ! grep -q 'CN=BIES, O=Build in El Salvador' <<<"$CERT"; then
    echo "error: the bundle isn't signed with the upload key" >&2
    exit 1
fi
SHA256=$(grep -m1 'SHA256:' <<<"$CERT" | sed 's/.*SHA256: *//')

OUT="$ANDROID/releases"
mkdir -p "$OUT"
cp "$AAB" "$OUT/BIES-$CODE.aab"
KEEP_NUMBER=true

echo "==> signed with the upload key (SHA-256 $SHA256)"
echo "==> $OUT/BIES-$CODE.aab"
echo "    Upload it in Play Console. Then commit the version code in android/app/build.gradle."
