#!/bin/bash
#
# Create the Android upload key, once:
#
#   android/make-upload-key.sh
#
# Google Play signs the app with its own key (Play App Signing); this one only
# proves an upload came from us. It goes in ~/.bies-android, outside the repo:
#   bies-upload.jks          the key
#   keystore.properties      where it is and its password, for android/ship.sh
# The password is typed here and never shown. Save the .jks file and the
# password in the shared Bitwarden: a lost upload key can be reset through
# Play support, but it takes days.
set -euo pipefail

DIR="$HOME/.bies-android"
KEYSTORE="$DIR/bies-upload.jks"
PROPS="$DIR/keystore.properties"
KEYTOOL="/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/keytool"

if [[ -e "$KEYSTORE" || -e "$PROPS" ]]; then
    echo "error: an upload key already exists in $DIR. Not replacing it." >&2
    exit 1
fi
if [[ ! -x "$KEYTOOL" ]]; then
    echo "error: keytool not found; it comes with Android Studio ($KEYTOOL)." >&2
    exit 1
fi

read -rsp "Choose a password for the upload key (at least 12 characters): " PASS1; echo
read -rsp "Type it again: " PASS2; echo
if [[ "$PASS1" != "$PASS2" ]]; then
    echo "error: the two passwords don't match." >&2
    exit 1
fi
if (( ${#PASS1} < 12 )); then
    echo "error: use at least 12 characters." >&2
    exit 1
fi

mkdir -p "$DIR"
chmod 700 "$DIR"
umask 077
export BIES_UPLOAD_KEY_PASS="$PASS1"
"$KEYTOOL" -genkeypair -keystore "$KEYSTORE" -storetype PKCS12 -alias bies-upload \
    -keyalg RSA -keysize 4096 -validity 10000 \
    -dname "CN=BIES, O=Build in El Salvador, C=SV" \
    -storepass:env BIES_UPLOAD_KEY_PASS -keypass:env BIES_UPLOAD_KEY_PASS 2>/dev/null
unset BIES_UPLOAD_KEY_PASS

{
    echo "storeFile=$KEYSTORE"
    echo "keyAlias=bies-upload"
    echo "storePassword=$PASS1"
    echo "keyPassword=$PASS1"
} > "$PROPS"
unset PASS1 PASS2

echo
echo "Upload key created in $DIR."
echo "Now save both in the shared Bitwarden:"
echo "  - the file $KEYSTORE (attach it to the item)"
echo "  - the password you just typed"
