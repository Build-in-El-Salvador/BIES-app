# NIP-49 Encrypted .nostrkey File — Technical Reference

## Overview

BIES uses **NIP-49** to encrypt Nostr private keys into portable `.nostrkey` files that users download and store offline. The file contains the secret key encrypted with **scrypt + XChaCha20-Poly1305** — the user's password is the only thing protecting it.

All encryption and decryption happens **client-side only**. The server never sees passwords, secret keys, or ncryptsec values. The `.nostrkey` file is the user's authoritative key backup — if they lose it and have no passkey, there is no recovery path.

---

## Architecture

### File Map

| File | Responsibility |
|---|---|
| `src/services/keyfileService.js` | NIP-49 encryption, decryption, file building, parsing, and download trigger |
| `src/pages/Signup.jsx` | Key generation, password entry, encryption, download, confirmation |
| `src/pages/Login.jsx` | File upload / ncryptsec paste, password entry, decryption, auth |
| `src/pages/Settings.jsx` | Export encrypted key backup for logged-in users |
| `src/pages/settings/TakeYourKey.jsx` | Backup of the key BIES held for an email account ("Take your key"), with NIP-49's key security byte set to `0x00`: handled insecurely, as the spec asks for keys a server has seen |
| `src/services/nostrSigner.js` | Holds decrypted nsec in memory during active session |
| `src/services/authService.js` | Challenge-response authentication after decryption |

### Data Flow

```
User sets password
    |
    v
keyfileService.buildKeyfile(secretKeyBytes, password, logn)
    |
    v
nostr-tools/nip49 encrypt()
    |
    +--> scrypt(password, random_salt, logn) --> derived key
    |
    +--> XChaCha20-Poly1305(derived_key, random_nonce, secretKey) --> ciphertext
    |
    v
ncryptsec1... (bech32-encoded encrypted key)
    |
    v
JSON payload assembled (.nostrkey format)
    |
    v
triggerDownload() --> browser file save dialog
```

---

## .nostrkey File Format

### JSON Structure

```json
{
  "format": "nostrkey",
  "version": 1,
  "npub": "npub1abc123...",
  "ncryptsec": "ncryptsec1qyz789...",
  "created_at": "2026-03-16T20:00:00.000Z",
  "client": "BIES v1.0"
}
```

### Fields

| Field | Type | Description |
|---|---|---|
| `format` | string | Fixed `"nostrkey"` — identifies the file type |
| `version` | number | Protocol version (currently `1`). Files with a higher version are rejected. |
| `npub` | string | User's public key in bech32 (`npub1...`). Used for identity preview on login. |
| `ncryptsec` | string | NIP-49 encrypted secret key (`ncryptsec1...`). The core payload. |
| `created_at` | string | ISO 8601 timestamp of file creation |
| `client` | string | Client identifier (`BIES v1.0`) |

### Filename Convention

Pattern: `nostr-{8-char-npub-suffix}.nostrkey`

Example: `nostr-3ab12c4f.nostrkey`

The suffix is the last 8 characters of the npub, making files distinguishable when a user has multiple keys.

---

## NIP-49 Cryptographic Details

### Algorithm Stack

| Layer | Algorithm | Purpose |
|---|---|---|
| KDF | scrypt | Derive encryption key from user password |
| Cipher | XChaCha20-Poly1305 | Authenticated encryption of the secret key |
| Encoding | bech32 (`ncryptsec1...`) | Portable string format per NIP-19 |

### Scrypt Parameters

| Setting | `logn` | Memory Cost | Use Case |
|---|---|---|---|
| Default | 16 | 64 MiB | Fast on most devices |
| Stronger | 18 | 256 MiB | Better brute-force resistance |
| Maximum | 20 | 1 GiB | Highest security, slow on low-end hardware |

The `logn` parameter controls the CPU/memory cost of deriving the encryption key. Higher values make password guessing exponentially harder but take longer to compute. Users can choose this during signup via an "Encryption Strength" option.

### Encryption Process

1. User provides a **password** (minimum 8 characters)
2. A **random salt** is generated
3. **scrypt** derives a 256-bit encryption key from password + salt (cost set by `logn`)
4. A **random 24-byte nonce** is generated (XChaCha20 uses extended nonces)
5. The 32-byte secret key is encrypted with **XChaCha20-Poly1305** using the derived key + nonce
6. Salt, nonce, and ciphertext are encoded as a **bech32 string** with `ncryptsec` prefix

### Decryption Process

1. User provides the **ncryptsec** string and their **password**
2. The bech32 string is decoded to extract salt, nonce, and ciphertext
3. **scrypt** re-derives the encryption key from password + extracted salt
4. **XChaCha20-Poly1305** decrypts the ciphertext using derived key + extracted nonce
5. If the password is wrong, the AEAD authentication tag check fails — decryption is rejected
6. On success, the 32-byte secret key is returned

### Implementation

Provided by the `nostr-tools` library (v2):

```javascript
import { encrypt, decrypt } from 'nostr-tools/nip49'

// Encrypt
const ncryptsec = encrypt(secretKeyBytes, password, logn)

// Decrypt
const secretKeyBytes = decrypt(ncryptsec, password)
```

---

## keyfileService API

### `buildKeyfile(secretKeyBytes, password, logn = 16)`

Encrypts a secret key and assembles the .nostrkey JSON payload.

- **Input**: 32-byte `Uint8Array`, password string, scrypt cost
- **Output**: `{ json: string, filename: string, npub: string }`
- Does **not** trigger a download — returns the JSON string for the caller to handle

### `triggerDownload(jsonString, filename)`

Saves a string as a file download in the browser.

- Creates a `Blob` with MIME type `application/octet-stream`
- Uses `URL.createObjectURL()` + programmatic anchor click
- Revokes the object URL immediately after download starts

### `parseKeyfile(text)`

Parses file contents into a structured object.

- **Input**: Raw file text (JSON or plain ncryptsec string)
- **Output**: `{ ncryptsec: string, npub?: string, filename?: string }`
- Tries JSON parse first (looks for `format: "nostrkey"`)
- Falls back to detecting a raw `ncryptsec1...` string
- Legacy fallback: extracts `nsec1...` from old plaintext key files
- Rejects files with `version` higher than 1

### `decrypt(ncryptsec, password, expectedNpub = null)`

Decrypts an ncryptsec string back to a usable secret key.

- **Input**: ncryptsec string, password, optional npub for verification
- **Output**: `{ secretKeyBytes: Uint8Array, nsec: string, npub: string }`
- Validates the decrypted key matches `expectedNpub` (if provided)
- On failure, zeros the secret key bytes before throwing

### `encryptAndDownload(nsecString, password, logn = 16)`

Convenience method that encrypts an nsec and immediately triggers a browser download.

- **Input**: bech32 nsec string, password, scrypt cost
- **Output**: `{ npub: string, filename: string }`
- Used by Settings export and the legacy nsec migration flow

---

## User Flows

### Signup: Create & Download

```
Step 0: Generate Keys
  - BIP-39 seed phrase generated (NIP-06)
  - Derive secret key + public key
  - Display seed phrase for user to write down

Step 1: Set Password & Encrypt
  - User enters password (min 8 chars, strength indicator shown)
  - User confirms password
  - Optional: adjust scrypt logn (16/18/20) via "Encryption Strength"
  - buildKeyfile() encrypts the secret key

Step 2: Download & Confirm
  - .nostrkey file auto-downloads to browser
  - User checks "I have stored my key file safely"
  - Optional: save a passkey for quick future login

Step 3: Profile Setup
  - User sets display name, role
  - nsec login triggers challenge-response with backend
  - JWT issued, user enters dashboard
```

### Login: Upload & Decrypt

```
Tab: "Key File"
  - User uploads .nostrkey file (drag-and-drop or file picker)
  - parseKeyfile() extracts ncryptsec + npub
  - "Unlock Your Key" screen shows:
      Identity preview (npub), Filename, Password input
  - User enters password
  - decrypt() recovers the secret key
  - loginWithNsec() authenticates with backend

Tab: "Paste Key"
  - User pastes ncryptsec1... string directly
  - Same unlock flow as above (without filename display)

Tab: "nsec Key"
  - User pastes raw nsec1... (legacy/unencrypted)
  - On login, migration prompt appears:
      "Secure Your Key" screen
      User sets a password
      encryptAndDownload() creates .nostrkey backup
      User advised to delete the old plaintext key
      Can skip migration (not recommended)
```

### Settings: Export Backup

```
Settings > Security > "Export Encrypted Key File"
  - User enters password + confirmation
  - encryptAndDownload() encrypts the in-memory nsec
  - .nostrkey file downloads
  - Password fields cleared
```

---

## Parsing & Compatibility

`parseKeyfile()` handles multiple input formats to maximize compatibility:

| Input | Detected As | Behavior |
|---|---|---|
| Valid .nostrkey JSON (version 1) | Encrypted keyfile | Extract `ncryptsec` + `npub` from JSON |
| .nostrkey JSON with version > 1 | Incompatible | Throws error — file was created by a newer client |
| Raw `ncryptsec1...` string | Encrypted key | Wrap in minimal object (no npub preview) |
| Raw `nsec1...` string | Legacy plaintext | Return nsec directly (triggers migration prompt on login) |
| Old JSON with `nsec` field | Legacy keyfile | Extract nsec (triggers migration prompt on login) |
| Anything else | Invalid | Throws error |

---

## Security Properties

### Protected Against

| Threat | Mitigation |
|---|---|
| File theft without password | scrypt + XChaCha20-Poly1305 — attacker must brute-force the password |
| Password brute-forcing | scrypt cost is tunable (logn 16-20) — higher values make each guess exponentially slower |
| Ciphertext tampering | Poly1305 authentication tag — modified ciphertext fails decryption |
| Server compromise | Server never sees passwords, nsec, or ncryptsec — all crypto is client-side |
| In-memory key exposure | Secret key bytes zeroed on logout (`Uint8Array.fill(0)`) and on decryption failure |

### Limitations

| Limitation | Detail |
|---|---|
| Password strength is user-dependent | A weak password undermines scrypt protection. The UI provides a strength indicator but does not enforce strong passwords beyond the 8-char minimum. |
| No server-side recovery | If the user loses their .nostrkey file, forgets their password, and has no passkey — the key is gone. This is by design (sovereign key management). |
| File format is BIES-specific | The JSON wrapper (`format`, `version`, `client` fields) is not standardized. The `ncryptsec` value inside is standard NIP-49 and portable to any NIP-49-compatible client. |
| scrypt cost is fixed at creation | The logn parameter is baked into the ncryptsec. To upgrade the cost, the user must export a new .nostrkey file with a higher setting. |

---

## Relationship to Passkey System

The .nostrkey file and the passkey system are complementary — both protect the same secret key, but for different purposes:

| | .nostrkey File | Passkey |
|---|---|---|
| Purpose | Portable offline backup | Quick device login |
| Persistence | User's filesystem | Authenticator hardware + localStorage |
| Authentication | Password (user-memorized) | Biometric / PIN (hardware-gated) |
| Cross-device | Yes (copy the file) | Yes (largeBlob on hardware keys) |
| Created during | Signup (mandatory) | Signup or login (optional) |
| Recovery role | Primary — authoritative backup | Secondary — convenience layer |

During signup, the .nostrkey file is created first (Steps 1-2), then the user is offered a passkey (Step 2). The file is the authoritative backup; the passkey is a convenience layer on top.

---

## Testing

E2E tests covering the .nostrkey flow are in `e2e/nip49-keyfile.spec.js`:

- Signup flow with password validation and scrypt parameter selection
- File download and re-upload round-trip
- Wrong password rejection
- ncryptsec paste from text input
- Legacy nsec file migration prompt
- File format validation (JSON structure, bech32 encoding, version check)
- Security checks (no nsec in localStorage or sessionStorage after login)
- UI state management (password visibility toggle, mode switching)
