# Android (Google Play) build

The Android app is the same React bundle as the web app, wrapped by Capacitor 8
(`android/`, package `com.bies.app`, target API 36).

## Prerequisites

- **Android Studio.** Its bundled JDK 21 is what Gradle needs:
  `export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"`
- **Android SDK platform 36.** Install it from Android Studio's SDK Manager.
- **`.env.native` at the repo root.** Copy `.env.native.example` and set absolute
  production URLs. Without it, every API call in the app resolves against
  `https://localhost` and fails.

  ```
  VITE_API_URL=https://app.buildinelsalvador.com/api
  VITE_NOSTR_RELAY=wss://app.buildinelsalvador.com/relay
  ```

## Build

```bash
npm ci
npm run cap:sync              # vite build --mode native, then cap sync (iOS + Android)
cd android && ./gradlew assembleDebug    # app/build/outputs/apk/debug/app-debug.apk
```

Or open the project with `npx cap open android` and use Android Studio.

## Release builds for Play

1. **Create the upload key, once:** `android/make-upload-key.sh`. It asks for a password
   (never shown) and writes the key and its settings to `~/.bies-android`, outside the
   repo. Play App Signing holds the real app-signing key; this one only signs uploads.
   **Save the `.jks` file and the password in the shared Bitwarden.** A lost upload key
   can be reset through Play support, but it takes days.
2. **Build:** `android/ship.sh`. It builds the web bundle with the production URLs,
   syncs it, raises `versionCode` by one (Play refuses a repeat; `--no-bump` keeps it),
   builds the release bundle, checks it is signed with the upload key, and copies it to
   `android/releases/BIES-<versionCode>.aab` (git-ignored). Commit the new version code.
3. **Upload to Play Console:** Test and release → Internal testing first, then Closed
   testing. `versionName` in `android/app/build.gradle` is what users see.

**New personal developer accounts** must run a closed test with at least 12 testers
who stay opted in for 14 consecutive days before Play allows a production release.
The production-access application is then reviewed, usually within 7 days.
Organization accounts are exempt.

## Push notifications

Push is **off on Android** (`ANDROID_PUSH_ENABLED = false` in
`src/config/featureFlags.js`). Calling `register()` without Firebase can crash the
app. To turn it on:

1. Create a Firebase project.
2. Add `android/app/google-services.json`.
3. Implement FCM sending on the server (`apns.service.ts` only covers iOS).
4. Flip the flag.

## Known gaps to check on a device

- **Edge-to-edge.** Android 16 forces it at target API 36. With a WebView of 140 or
  newer, the page draws under the status bar and gesture bar and CSS
  `env(safe-area-inset-*)` keeps content clear, as on iOS. Older WebViews get
  padding instead, and the window background (`bies_bars`, the header colour)
  fills the gap. Checked on the emulator's WebView 134 (2026-10-21).
- **Amber sign-in.** Off inside the app (`Login.jsx`); it needs an app deep link
  before it can work there.
