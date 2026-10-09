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

1. **Create an upload key, once.** Play App Signing holds the real app-signing key;
   you only keep the upload key.

   ```bash
   keytool -genkeypair -v -keystore bies-upload.jks -alias bies-upload \
     -keyalg RSA -keysize 4096 -validity 10000
   ```

   **Never commit the keystore or its passwords.** Store both in the shared
   Bitwarden. A lost upload key can be reset through Play support, but it takes days.
2. **Raise the version** in `android/app/build.gradle` on every upload:
   - `versionCode` must go up by at least 1 (Play rejects repeats);
   - `versionName` is what users see.
3. **Build a signed bundle:** Android Studio → Build → Generate Signed App Bundle
   → `app-release.aab`.
4. **Upload to Play Console:** Testing → Internal testing first, then Closed testing.

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

- **Edge-to-edge.** Android 16 forces it at target API 36. Check that content
  doesn't sit under the status bar or the gesture bar.
- **Amber sign-in.** It returns to `window.location.origin` + `/amber-callback`,
  which is `https://localhost` inside the app. It needs an app deep link before it
  can work.
- **Share links.** Links built from `window.location.origin` come out as
  `https://localhost/...`.
