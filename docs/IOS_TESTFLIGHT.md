# iOS / TestFlight Guide

BIES ships to iOS as a [Capacitor](https://capacitorjs.com/) app: the existing React SPA is bundled into a native shell (a WKWebView) and talks to the production backend over HTTPS. This guide takes you from the current repo state to a build installable via TestFlight.

**Current state of the repo:**

- Capacitor is scaffolded: `capacitor.config.ts` at the repo root, the native Xcode project in `ios/`, and `@capacitor/core`, `@capacitor/app`, `@capacitor/browser` (+ `@capacitor/cli`, `@capacitor/ios` as dev deps) in `package.json`.
- The web code is Capacitor-safe: all Capacitor access goes through runtime `window.Capacitor` guards (`src/utils/platform.js`, `src/utils/openExternal.js`) — the web build is unchanged and never imports `@capacitor/*`.
- Passkey UI is hidden on native (WebAuthn does not exist in WKWebView), the service worker is skipped on native, external links route through the Browser plugin, and the backend CORS allowlist accepts the native WebView origins by default.
- The required `Info.plist` permission strings and `LSApplicationQueriesSchemes` are already in `ios/App/App/Info.plist`.

**What is NOT done yet** (each item has a plan in [Known not-yet-native items](#known-not-yet-native-items)): native geolocation, Keychain storage for secrets, NIP-46 pairing persistence, universal links, the full icon/launch-screen asset set, and removal of the demo login bypass. Native **push notifications** are now implemented in code but require server config + Apple setup — see [Phase 5](#phase-5--push-notifications-apns).

---

## Prerequisites

- **macOS** with **Xcode 15+** (16 recommended) and its Command Line Tools
- **CocoaPods** (`sudo gem install cocoapods` or `brew install cocoapods`)
- An enrolled **Apple Developer Program** account with access to [App Store Connect](https://appstoreconnect.apple.com)
- **Node 20+** and the repo's dependencies installed (`npm install`)
- A reachable **production backend** over HTTPS (the native app cannot use the Vite dev proxy — see Phase 0)

> **TypeScript note:** the Capacitor CLI needs `typescript` resolvable from the repo root to parse `capacitor.config.ts`. It is currently satisfied by a local symlink into `server/node_modules` — if `npx cap sync` ever fails with "Could not find installation of TypeScript", run `npm install -D typescript` at the repo root.

---

## Phase 0 — Build plumbing

### 0.1 Why a native env file is mandatory

Inside the Capacitor shell the WebView origin is `capacitor://localhost`. The web app's defaults break there:

| Default | What happens under `capacitor://localhost` |
| --- | --- |
| `BASE_URL = '/api'` (`src/services/api.js`) | Every fetch resolves to `capacitor://localhost/api/...` → all API calls fail |
| WebSocket URL derived from `BASE_URL` | `/ws` never connects → no realtime notifications/DMs |
| Relay from `window.location` (`src/services/nostrService.js`) | `ws://localhost/relay` → private relay never connects |
| Relative `/uploads/...` asset paths (`src/utils/assets.js`) | All avatars/banners/decks 404 |

Absolute production URLs must be baked in at build time:

```bash
cp .env.native.example .env.native
# Edit .env.native:
#   VITE_API_URL=https://YOUR-PROD-HOST/api
#   VITE_NOSTR_RELAY=wss://YOUR-PROD-HOST/relay
```

> `.env.native` is **not** in `.gitignore` yet — add it there (or name your copy `.env.native.local`, which Vite also loads for `--mode native` and which the existing `*.local` ignore rule covers).

### 0.2 Server CORS

Requests from the native app are cross-origin. The backend now allows the native WebView origins **by default** — `capacitor://localhost` (iOS) and `https://localhost` (Android) — via `corsNativeOrigin` in `server/src/config/index.ts`. To override, set `CORS_NATIVE_ORIGIN` (comma-separated) in the server's `.env`. No action needed unless you've customized it; just make sure the deployed backend includes this server change.

### 0.3 Build and sync

```bash
npm install                      # once
npx vite build --mode native     # builds dist/ with .env.native baked in
npx cap sync ios                 # copies dist/ into ios/App/App/public + updates pods/plugins
```

Repeat `build --mode native` + `cap sync ios` after **every** web code change. (`npx cap add ios` was already run — only needed again if you delete `ios/`. Note it regenerates `Info.plist` defaults, so re-apply the permission strings from Phase 2 if you ever do.)

> Do **not** ship a `dist/` produced by plain `npm run build` to the native app — it will contain the relative `/api` base and nothing will work.

---

## Phase 1 — Xcode signing, bundle ID

### 1.1 Bundle identifier

`capacitor.config.ts` sets `appId: 'com.bies.app'`. **This must match an App ID registered to your Apple Developer account.** Two options:

- **Register `com.bies.app`**: with automatic signing (below) Xcode registers it for you the first time you build to a device; or create it manually at [developer.apple.com → Identifiers](https://developer.apple.com/account/resources/identifiers/list) (type: App IDs → App, explicit bundle ID).
- **Use an identifier you already registered**: change `appId` in `capacitor.config.ts` *and* the Bundle Identifier in Xcode (target **App** → *Signing & Capabilities*), then `npx cap sync ios`.

### 1.2 Signing

```bash
npx cap open ios     # opens ios/App/App.xcworkspace — always the .xcworkspace, never .xcodeproj
```

In Xcode:

1. Select the **App** project in the navigator → target **App** → **Signing & Capabilities** tab.
2. Check **Automatically manage signing**.
3. Select your **Team** (your Apple Developer account — sign in first under Xcode → Settings → Accounts if needed).
4. Confirm the Bundle Identifier and that Xcode reports a valid provisioning profile with no errors.

### 1.3 First run (sanity check)

Select a simulator or a plugged-in iPhone as the run destination and press **Run** (⌘R). Verify:

- The app boots past the splash screen (a boot error on the splash usually means a stale/misbuilt `dist/` — redo Phase 0.3).
- Login works and the feed loads (proves `VITE_API_URL` + CORS are correct).
- The passkey button does **not** appear on the login screen (expected on native).
- An event's "Open in Maps" opens an in-app Safari sheet, not a navigation away from the app.

---

## Phase 2 — Info.plist entries

Already present in `ios/App/App/Info.plist` (verify after any regeneration of the iOS project):

| Key | Why |
| --- | --- |
| `NSLocationWhenInUseUsageDescription` | Cowork GPS check-in (`CheckInModal.jsx` uses `navigator.geolocation`). Without it the request fails instantly with no prompt. |
| `NSPhotoLibraryUsageDescription` | Photo uploads (profile/banner images, event and project images via file inputs). |
| `NSCameraUsageDescription` | The same file inputs offer "Take Photo" on iOS. |
| `LSApplicationQueriesSchemes` (`lightning`, `bitcoin`) | Zap/payment deep links (`ZapModal.jsx`) hand off to wallet apps; declaring the schemes allows `canOpenURL` checks and keeps App Review happy. |

App Review rejects builds whose permission strings are generic ("This app needs camera access") — the strings in the plist state the specific purpose; keep them that way if you edit them.

---

## Phase 3 — App icon and launch screen

Only three PNGs exist today (`public/icons/`: 192, 512, apple-touch-icon) — not enough for the App Store.

1. Produce a **1024×1024 PNG, no alpha/transparency** master icon (App Store Connect rejects icons with an alpha channel).
2. Easiest path — generate the full set with Capacitor's assets tool (one-off, no dependency added):
   ```bash
   mkdir -p assets && cp your-icon-1024.png assets/icon-only.png
   npx @capacitor/assets generate --ios
   ```
   Or drag the 1024px icon into `ios/App/App/Assets.xcassets → AppIcon` in Xcode (single-size slot on Xcode 14+).
3. Launch screen: `ios/App/App/Base.lproj/LaunchScreen.storyboard`. Set its view background to the splash navy `#0A192F` (RGB 10, 25, 47) and optionally center the BIES logo, so launch → in-app splash is seamless. `capacitor.config.ts` already sets the WebView `backgroundColor` to `#0A192F` so there's no white flash after launch.

---

## Phase 4 — Archive and upload to TestFlight

### 4.1 Create the App Store Connect record

1. [App Store Connect](https://appstoreconnect.apple.com) → **My Apps** → **+** → **New App**.
2. Platform **iOS**, name **BIES** (or your preferred store name), primary language, **Bundle ID** = the one from Phase 1.1, SKU = anything unique (e.g. `bies-ios`).

### 4.2 Version and build numbers

In Xcode (target **App** → **General**): **Version** (`MARKETING_VERSION`, e.g. `0.3.0` to match `package.json`) and **Build** (`CURRENT_PROJECT_VERSION`, an integer). Every upload to App Store Connect needs a build number higher than the last one for that version.

### 4.3 Archive

1. Fresh web build first: `npx vite build --mode native && npx cap sync ios`.
2. In Xcode set the run destination to **Any iOS Device (arm64)** (archiving is disabled for simulator destinations).
3. **Product → Archive**. When it finishes, the **Organizer** window opens with the archive.

### 4.4 Upload

1. In Organizer: **Distribute App** → **TestFlight & App Store** (Xcode 15+; on older Xcode: *App Store Connect → Upload*) → accept the defaults (App Store Connect distribution, automatic signing) → **Upload**.
2. Wait for processing in App Store Connect (**TestFlight** tab) — typically 5–30 minutes; you'll get an email.
3. **Export compliance:** you'll be asked about encryption. BIES uses only standard HTTPS/TLS (exempt). Answer accordingly, or preempt the prompt by adding to `Info.plist`:
   ```xml
   <key>ITSAppUsesNonExemptEncryption</key>
   <false/>
   ```

### 4.5 Distribute to testers

- **Internal testing** (up to 100 members of your App Store Connect team): TestFlight tab → Internal Testing → create a group, add testers, add the build. Available immediately, no review.
- **External testing** (up to 10,000 testers via email or public link): create an External group, add the build → requires a one-time **Beta App Review** (usually < 24h). Provide test login instructions (see Review notes below).

Testers install the **TestFlight** app from the App Store and redeem the invite/link.

---

## Phase 5 — Push notifications (APNs)

Native push is **implemented in code** (client + server) but ships inert: with no APNs config the server logs `[APNs] Not configured — native push disabled` at boot and every existing notification path (web push included) works unchanged. To turn it on:

### 5.1 Create an APNs Auth Key (.p8)

1. [developer.apple.com → Certificates, Identifiers & Profiles → Keys](https://developer.apple.com/account/resources/authkeys/list) → **+**.
2. Give it a name, check **Apple Push Notifications service (APNs)**, **Continue** → **Register**.
3. **Download** the `.p8` (you can only download it once). Note the **Key ID** shown on the key page.
4. Your **Team ID** is at the top-right of the developer portal (and under Membership).

One APNs key works for both sandbox and production and for all your apps on the team.

### 5.2 Enable the capability on the App ID / in Xcode

In Xcode (`npx cap open ios`), target **App** → **Signing & Capabilities**:

1. **+ Capability** → **Push Notifications** (this adds the `aps-environment` entitlement; without it `register()` fires `registrationError` and no token is ever produced).
2. **+ Capability** → **Background Modes** → check **Remote notifications** (needed for background delivery).

With automatic signing, adding the capability registers the `com.bies.app` App ID for push for you; otherwise enable Push Notifications on the App ID at developer.apple.com → Identifiers.

### 5.3 Install the plugin pod

`@capacitor/push-notifications` is already in `package.json`, but adding it there is inert until the pod is installed:

```bash
npm install
npx cap sync ios     # installs the CocoaPod + registers the plugin
```

Without `cap sync`, `PushNotifications.register()` throws at runtime.

### 5.4 Configure the server

Set these in the backend's `.env` (see `server/.env.example`). Leaving `APNS_KEY_ID` / `APNS_TEAM_ID` / `APNS_AUTH_KEY` blank keeps native push disabled.

| Env var | Value |
| --- | --- |
| `APNS_KEY_ID` | The Key ID from 5.1 |
| `APNS_TEAM_ID` | Your Apple Developer Team ID |
| `APNS_BUNDLE_ID` | `com.bies.app` (must match `capacitor.config.ts` appId + Xcode bundle id, and the APNs `apns-topic`) |
| `APNS_AUTH_KEY` | The full `.p8` PEM contents. If your secret store is single-line, escape newlines as literal `\n` — the server un-escapes them. |
| `APNS_PRODUCTION` | `true` for TestFlight/App Store, `false` for Xcode debug builds |

Apply the `device_tokens` migration in each environment (`npm run db:migrate` in dev / `prisma migrate deploy` in prod) and restart — the boot log should read `[APNs] Initialized (…host, topic com.bies.app)`.

### 5.5 The sandbox-vs-production caveat (most common failure)

APNs has two hosts and the device token is bound to the environment the app was signed for:

- **Xcode debug builds** sign `aps-environment=development` → tokens are **sandbox** → `APNS_PRODUCTION=false` (`api.sandbox.push.apple.com`).
- **TestFlight / App Store builds** sign `aps-environment=production` → tokens are **production** → `APNS_PRODUCTION=true` (`api.push.apple.com`).

A mismatch returns `400 BadDeviceToken` for every push (the server prunes those tokens automatically). If you test both a debug build and a TestFlight build against one backend, they need different `APNS_PRODUCTION` values — run separate backends or reconfigure between tests. Also ensure the `.p8` key belongs to the same team as the app and that `APNS_BUNDLE_ID` matches, or Apple returns `403 InvalidProviderToken` / `BadTopic`.

---

## Known not-yet-native items

Planned work, in rough priority order. None block a first TestFlight build, but testers should know what won't work.

### 1. Push notifications — IMPLEMENTED (needs config, see [Phase 5](#phase-5--push-notifications-apns))

Native APNs push now ships in code, parallel to the untouched web-push stack:

- Client: `@capacitor/push-notifications` (runtime-only, never statically imported). `src/services/pushService.js` obtains the APNs device token and registers it via `POST /api/notifications/device-token`; `AuthContext.jsx` takes the native branch on `isNativePlatform()` and skips the web-push/`PushPermissionPrompt` path entirely.
- Server: a Prisma `DeviceToken` table alongside `PushSubscription`, register/unregister endpoints, and `server/src/services/apns.service.ts` (Node `http2` + `jsonwebtoken` ES256 provider token). `notification.service.ts` fans out to APNs *in addition to* web-push and prunes dead tokens on `410` / `BadDeviceToken` / `Unregistered`.

It is **gated behind config**: unset `APNS_*` env vars → the server logs one line at boot and every send is a no-op, so this is safe to ship before you finish the Apple setup. To enable it, follow **[Phase 5](#phase-5--push-notifications-apns)** (create the `.p8`, add the Xcode capabilities, `npx cap sync ios`, set the server env vars).

### 2. Geolocation plugin

Cowork check-in (`src/components/cowork/CheckInModal.jsx`) uses `navigator.geolocation.getCurrentPosition`, which works in WKWebView now that `NSLocationWhenInUseUsageDescription` is set, but produces a double prompt (system + WebView). Plan: add `@capacitor/geolocation` and branch on `isNativePlatform()` for a single native permission flow.

### 3. Keychain storage for the NWC secret and the refresh token

`src/services/nwcService.js` stores the Nostr Wallet Connect URI — which embeds the wallet's payment secret — in plain `localStorage`, and `src/services/session.js` keeps the native app's **refresh token** (`bies_refresh`, good for up to 90 days) there too; the web app's is an httpOnly cookie instead. In WKWebView, `localStorage` is unencrypted on disk and can be evicted by the OS under storage pressure (random logouts / wallet disconnects). Plan: a thin platform-aware storage adapter — Keychain/Keystore (e.g. `capacitor-secure-storage-plugin`) for the NWC URI, the refresh token and pasted Nostr keys, cleared on first launch after a reinstall (Keychain items survive uninstalls), `localStorage` unchanged on web. The 15-minute access token can stay in `localStorage`.

### 4. NIP-46 bunker pairing persistence

`src/services/nostrConnectService.js` keeps the ephemeral client key + bunker pointer in `sessionStorage`, which is wiped on every cold app launch — bunker users (Amber, nsecBunker) would re-pair on each restart. Plan: route that pairing through the same storage adapter (Preferences/Keychain on native).

### 5. Universal links

Shared URLs (`/events/:id`, `/project/:id`) currently open in Safari, not the app. Plan: host an `apple-app-site-association` file on the production domain, add the Associated Domains capability (`applinks:YOUR-PROD-HOST`), and handle `appUrlOpen` from `@capacitor/app` (already a dependency) to route into React Router.

### 6. Icon set + launch screen

See Phase 3 — the assets don't exist yet and are required for upload.

### 7. Demo login bypass — MUST be removed before App Review

`src/services/authService.js` (`if (token === 'demo-token')`, marked `TODO: Remove before production — demo bypass`) and `src/services/api.js` (`demoLogin: () => post('/auth/demo-login')`, same TODO) still contain a demo auth bypass, plus whatever `/auth/demo-login` does server-side. **It has intentionally not been removed in this change** — remove it (client calls and the server route) before submitting for external Beta App Review or App Store review. Hidden bypass/debug login paths are a rejection risk under guideline 2.3.1 (hidden features).

---

## App Review gotchas

- **Lightning payments for event tickets — guideline 3.1.5(a).** Apple's In-App Purchase requirement applies to *digital* goods and services. Guideline 3.1.5(a) explicitly permits payment methods other than IAP for "goods or services that will be consumed outside of the app" — physical-world event tickets fall in this category, and Lightning/on-chain payments for real-world goods and services are standard practice in shipped App Store apps. Review your ticket flows before submission anyway: if BIES ever sells *digital* content/features, that portion would require IAP (3.1.1). Keep zaps framed as tips/payments between users for real-world value, not unlocking app functionality.
- **Reviewer access.** Nostr-key login will confuse a reviewer. In App Store Connect → App Review Information, supply a working test account (e.g. a pre-generated nsec or the email flow) and step-by-step login notes. Do this for Beta App Review (external TestFlight) too.
- **Pinch-zoom accessibility.** Already fixed — `index.html` no longer sets `maximum-scale=1, user-scalable=no`. Don't reintroduce it; disabled zoom is a WCAG issue reviewers flag.
- **Permission strings.** Must state a specific purpose (Phase 2). A generic string is a metadata rejection.
- **Custom URL schemes.** `lightning:`/`bitcoin:` links are a silent no-op when no wallet app is installed. The QR + copy fallback in `ZapModal.jsx` mitigates this; a later `@capacitor/app-launcher` + `canOpenUrl` check with a "no wallet found" toast would polish it.
- **Demo/bypass code.** Item 7 above — remove before review.
- **Minimum functionality (4.2).** The app is a full product, not a repackaged website, but make sure the build you submit has working core flows (login, feed, events) against production — a broken first-run is the most common rejection.

---

## Quick reference

```bash
# One-time
npm install
cp .env.native.example .env.native   # then edit with prod URLs

# Every release cycle
npx vite build --mode native
npx cap sync ios
npx cap open ios
# Xcode: bump build number → Product > Archive → Distribute App
```
