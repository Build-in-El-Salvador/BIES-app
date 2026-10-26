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

## Zapstore release

Pushing a signed `vX.Y.Z` tag builds an APK, signs it, and publishes it to
Zapstore (`.github/workflows/zapstore-release.yml`, listing in `zapstore.yaml`).
Nobody clicks anything after the tag, so **who can push a `v*` tag is the
security boundary** (see "One-time setup"). The workflow's own checks catch
honest mistakes (wrong commit, version drift, red CI, a tag signed by the wrong
person); they do not stop someone who can create the tag, because the workflow
that runs is the one in the commit the tag points at.

BIES ships on three channels with three different signing keys. Android refuses
an update signed by a different key, so a copy from one channel never updates a
copy from another: switch by uninstalling first, and **back up the Nostr key
before you do** (the app holds it).

| Channel | Built by | Key | Trigger |
|---|---|---|---|
| Google Play | `android/ship.sh` | upload key, `~/.bies-android` on the maintainer's machine | by hand |
| Testers | `android-apk.yml` | `bies-ci`, a repository secret that any workflow a writer can push can read | every push to `main` |
| Zapstore | `zapstore-release.yml` | `bies-zapstore`, only in the `android-release` environment | a `vX.Y.Z` tag |

### How it is split

Each secret sits in a job that runs none of the project's code:

- `build` runs npm, Vite, Capacitor and Gradle, which execute dependency code.
  It has no secrets and produces an **unsigned** APK.
- `sign` holds the APK key. It has no checkout, no npm and no Gradle: it
  downloads the unsigned APK and runs the SDK's `apksigner`.
- `preflight` and `zapstore` hold the Nostr signer. `preflight` runs before
  anything is public and checks that the signer may publish this exact APK
  (listed, proof active, authorised, version code higher, certificate as pinned).
- `release` attaches the APK to the GitHub release with a build attestation and
  is the only job with `contents: write`.

What a compromised build dependency can still do is tamper with the unsigned
APK before it is signed. That is inherent to building from dependencies; the
mitigation is dependency review, not the pipeline.

### Releasing

1. `main` is protected, so the release commit goes through a pull request: on a
   branch run `scripts/version.sh patch|minor|major` (it bumps the version files
   and writes `CHANGELOG.md`), open the PR, wait for CI, merge.
2. Tag **the commit `main` now points at**, signed, then push only the tag. A
   squash or rebase merge gives the commit a new SHA, so delete the local tag
   `version.sh` made on the branch first:
   ```bash
   git tag -d vX.Y.Z; git checkout main && git pull
   git tag -s vX.Y.Z -m "BIES X.Y.Z"      # needs tag.gpgsign / gpg.format ssh / user.signingkey
   git push origin vX.Y.Z
   ```
   Tags must be **SSH-signed** with a key listed in `RELEASE_TAG_SIGNERS`.
3. The workflow refuses the tag unless it is annotated, named like its own
   object (a re-pushed old signed tag is rejected), signed by an allowed key, on
   `main`'s first-parent history (a merged PR's intermediate commits are not
   releasable), at the version in `version.json`, `package.json` and
   `server/package.json`, has a `CHANGELOG.md` section at the start of a line, and
   `ci.yml` passed on that commit. It waits up to 20 minutes for CI still running.
4. Once signed, `preflight` checks the Zapstore side, the GitHub release is made,
   and `zapstore` publishes the release asset and reads the relay back. A
   re-run after a partial failure skips the publish if the relay already has it.

`versionCode` is `major*1_000_000 + minor*1_000 + patch` (0.3.1 is 3001), so it
rises with the version and is independent of Play's counter. For the very first
tag, the rolling `latest` tag from `android-apk.yml` sorts as the "previous tag"
in `version.sh`: delete it locally (`git tag -d latest`) or write the first
changelog entry by hand.

Push one tag at a time and wait for the run: GitHub keeps only one *waiting* run
per concurrency group, so a third tag pushed while two are queued cancels the
middle one. A run shown as "cancelled" is a release that did not happen; re-run
it. A run whose CI was cancelled by a quicker merge needs `ci.yml` re-run first.

A pull request touching the workflow, or a manual run, does everything up to and
including the signature with a throwaway key, then `zsp check` on the result. It
never releases or publishes and never gets an environment.

### One-time setup (needs a repository admin and whoever holds the keys; nothing here is automatic)

1. **Release keystore.** Generate it offline (PKCS12, alias `bies-zapstore`, RSA
   4096, ~100 years, store password equal to key password) and back it up
   outside the repository. It can never be rotated for installed users. Put the
   base64 in the `android-release` environment as `ANDROID_RELEASE_KEYSTORE_B64`
   and the password as `ANDROID_RELEASE_KEYSTORE_PASS`. Set the repository
   variable `ZAPSTORE_CERT_SHA256` to its certificate SHA-256 (public, lowercase hex).
2. **Nostr signer.** A NIP-46 `bunker://` URL in the `zapstore-release`
   environment as `SIGN_WITH`; the workflow refuses anything else, so a private
   key can never go there. Scope that connection to the Zapstore event kinds
   (32267, 30063, 3063) if the signer can, and give it a name you can revoke.
   zsp opens a new client session on every run (twice per release), so the
   signer must accept repeated connections with that URL: test
   `SIGN_WITH='bunker://…' zsp check` repeatedly before the first release.
3. **Identity proof and the first release, once, by hand.** Run `zsp` yourself
   (not an agent) with the keystore and signer. It proves you control both and
   publishes the listing. Do this **from a GitHub release of an APK signed with
   this keystore, using this repository's `zapstore.yaml`**, so the exact path
   the workflow depends on (the latest release, the filters, the file name) is
   proven before CI relies on it. The proof (kind 30509) **expires after 2
   years**; CI cannot renew it, so `zsp check` will start returning
   `requires_human`. Re-run `zsp` before then.
4. **Repository settings.**
   - Environments `android-release` and `zapstore-release`, each limited to
     deployment **tags** matching `v[0-9]*.[0-9]*.[0-9]*`, with no secrets elsewhere.
   - A **tag ruleset on `v*`**: only release managers may create, update or delete
     tags; block force pushes; keep the bypass list to the same people.
   - Branch protection on `main`: pull request required, review required with
     stale approvals dismissed, the four `ci.yml` jobs required. Add CODEOWNERS for
     `.github/`, `zapstore.yaml`, `android/`, `package*.json`, `scripts/` and
     `version.json`: all of them change what gets signed.
   - Variable `RELEASE_TAG_SIGNERS`: one SSH allowed-signers line per release
     manager, restricted to tags: `name@example.com namespaces="git" ssh-ed25519 AAAA…`.
   - Workflow token read-only by default; approval required for workflows from
     outside collaborators; secrets not sent to fork pull requests; releases immutable.

### Check the settings took (an admin, once, and after any change)

These settings live outside the repository and **fail silently**: GitHub creates
an environment with no restrictions the moment a workflow names one that does
not exist, and a missing tag rule looks identical to a working one.

```bash
R=Build-in-El-Salvador/BIES-app
for e in android-release zapstore-release; do
  gh api repos/$R/environments/$e/deployment-branch-policies     --jq '.branch_policies[] | {name, type}'   # expect only: type "tag", name v[0-9]*.[0-9]*.[0-9]*
done
for id in $(gh api repos/$R/rulesets --jq '.[].id'); do
  gh api repos/$R/rulesets/$id --jq '{name, target, enforcement, bypass_actors, rules: [.rules[].type]}'
done                                            # tag ruleset: creation, update, deletion, non_fast_forward; short bypass list
gh api repos/$R/actions/secrets --jq '.secrets[].name'   # must NOT list SIGN_WITH or ANDROID_RELEASE_*
```

Then prove the boundary instead of trusting it: from a throwaway branch (not a
tag), dispatch a workflow whose job sets `environment: android-release`. GitHub
must refuse it ("not allowed to deploy"), and a `v*` tag pushed by someone outside
the release managers must be rejected by the ruleset.

### Maintenance

- **zsp is pinned** in `.github/actions/install-zsp/action.yml` to a release and
  its git **commit**; the workflow builds from a clone at that commit against the
  `go.sum` it carries, so every dependency is pinned by hash. To bump it: read the
  release, take the new tag's commit from `git ls-remote
  https://github.com/zapstore/zsp 'refs/tags/v*'`, change both values in one pull
  request, and let the dry run pass.
- **Actions are pinned to commits;** Dependabot proposes bumps with a 14-day
  delay, for the workflows and for `.github/actions/*`.
- **Stopping releases:** delete the `SIGN_WITH` secret, revoke that session in
  the signer, or disable the workflow. Published Nostr events cannot be taken
  back; ship a higher version, and raise `min_allowed_version_code` if users must
  move off a bad one.
- **Known gaps:** `android/gradle/wrapper/gradle-wrapper.properties` has no
  `distributionSha256Sum`, so the Gradle download is not integrity-checked; and
  `android-apk.yml`'s tester key is readable by anyone who can push a workflow.

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
