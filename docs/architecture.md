# Architecture

BIES runs as 6 services orchestrated by Docker Compose. In development, you only need the frontend (Vite) and backend (Express) — the relay, proxy, and translation services are optional.

## Service Topology

```
                         ┌─────────────────────────────────┐
                         │         Nginx (port 8082)       │
                         │   static frontend + reverse proxy│
                         └──────┬──────────┬───────────────┘
                                │          │
                    ┌───────────▼──┐   ┌───▼──────────────┐
                    │  /api, /ws   │   │  /relay           │
                    │              │   │                   │
                    ▼              │   ▼                   │
          ┌─────────────────┐     │   ┌──────────────────┐│
          │  Express Backend│     │   │ NIP-42 Auth Proxy ││
          │  (port 3001)    │     │   │ (port 7778)       ││
          │                 │     │   │                   ││
          │  REST API       │     │   │  Verifies JWT     ││
          │  WebSocket      │     │   │  Signs NIP-42     ││
          │  Auth (JWT)     │     │   │  challenge events ││
          └──┬──┬──┬──┬─────┘     │   └───────┬──────────┘│
             │  │  │  │           │           │           │
             │  │  │  │           │           ▼           │
             │  │  │  │           │   ┌──────────────────┐│
             │  │  │  │           │   │   strfry Relay    ││
             │  │  │  │           │   │   (port 7777)    ││
             │  │  │  │           │   │                  ││
             │  │  │  │           │   │  Private Nostr   ││
             │  │  │  │           │   │  relay for the   ││
             │  │  │  │           │   │  community       ││
             │  │  │  │           │   └──────────────────┘│
             │  │  │  │           │                        
             ▼  │  │  │           │                        
    ┌────────┐  │  │  │           │                        
    │Database│  │  │  │           │    ┌──────────────────┐
    │SQLite/ │  │  │  │           │    │  LibreTranslate  │
    │Postgres│  │  │  │           │    │  (port 5000)     │
    └────────┘  │  │  │           │    │  EN/ES           │
                │  │  │           │    └──────────────────┘
                ▼  │  │           │                        
          ┌──────┐ │  │           │                        
          │Redis │ │  │           │                        
          │(opt) │ │  │           │                        
          └──────┘ │  │           │                        
                   ▼  ▼           │                        
             ┌──────┐ ┌──────┐   │                        
             │  S3  │ │Coinos│   │                        
             │  R2  │ │  API │   │                        
             └──────┘ └──────┘   │                        
```

## Services

### 1. Express Backend (`bies-server`)

The central API server. Handles all business logic, authentication, and data persistence.

**Responsibilities:**
- REST API (22 route files, 23 controllers)
- WebSocket server for real-time messaging and notifications
- JWT authentication and Nostr challenge-response verification
- Prisma ORM for database operations (30+ models)
- Coinos API proxy for Lightning wallet operations
- File upload handling (S3 or local filesystem)
- Rate limiting and input sanitization

**Key paths:**
- `server/src/index.ts` — Express app setup, route mounting, WebSocket attachment
- `server/src/routes/` — 22 REST route files
- `server/src/controllers/` — 23 business logic controllers
- `server/src/services/` — Nostr, Coinos, WebSocket, Redis, storage services
- `server/src/middleware/` — Auth, rate limiting, sanitization, audit logging

### 2. strfry Relay (`bies-relay`)

A private Nostr relay running [strfry](https://github.com/hoytech/strfry). This is the community's own relay — only authenticated members can read and write.

**Why a private relay:**
- Community content stays within the community unless explicitly published to public relays
- Write policy prevents spam (only whitelisted pubkeys)
- NIP-42 auth ensures only BIES members can access it

**Key paths:**
- `relay/` — Dockerfile and strfry configuration
- Write policy controls which pubkeys can publish

### 3. NIP-42 Auth Proxy (`bies-auth-proxy`)

A lightweight proxy that sits between Nginx and strfry. When a client connects to the relay, the proxy handles the NIP-42 authentication challenge:

1. Client connects to `/relay` via WebSocket
2. Proxy sends `AUTH` challenge
3. Client signs a kind:22242 event with their Nostr key
4. Proxy verifies the signature and checks the pubkey against the whitelist
5. If valid, proxies the connection through to strfry

**Key paths:**
- `relay-proxy/` — Rust-based auth proxy

### 4. LibreTranslate (`bies-translate`)

Self-hosted translation service for English/Spanish bilingual support. The frontend calls it via the backend to translate UI content and user-generated text.

### 5. Nginx (`bies-nginx`)

Reverse proxy and static file server. Routes:

| Path | Destination |
|------|-------------|
| `/` | Static React SPA (built by Vite) |
| `/api/*` | Express backend |
| `/ws` | WebSocket upgrade to Express |
| `/relay` | WebSocket upgrade to NIP-42 auth proxy |
| `/uploads/*` | Static file serving |

**Key paths:**
- `deploy/nginx.conf` — Nginx configuration

### 6. Bug Tracker (`bies-bugs`)

Internal bug tracking service.

## Frontend Architecture

### React SPA

The frontend is a single-page React application built with Vite. It communicates with the backend via REST API and WebSocket, and directly with Nostr relays (both private and public) via the WebSocket-based Nostr protocol.

### State Management

No external state library. BIES uses React Context + hooks:

| Context | Purpose |
|---------|---------|
| `AuthContext` | Current user, JWT, login/logout |
| `ThemeContext` | Light/dark mode |
| `UserModeContext` | Builder vs. Investor view toggle |
| `LightboxContext` | Image viewer state |

### Service Layer

Frontend services handle all protocol and API interactions:

| Service | Responsibility |
|---------|---------------|
| `api.js` | HTTP client with JWT injection, all REST endpoints |
| `nostrService.js` | Relay connections, event subscriptions, profile cache |
| `nostrSigner.js` | Unified signing (in-memory key, extension, or passkey re-acquire) |
| `authService.js` | Login/logout, session restore, challenge-response |
| `keytrService.js` | Passkey encryption via @sovit.xyz/keytr |
| `keyfileService.js` | NIP-49 encrypted keyfile handling |
| `lightningService.js` | LUD-16 LNURL-pay resolution |
| `nwcService.js` | NIP-47 Nostr Wallet Connect client |
| `blossomService.js` | Media upload to Blossom protocol servers |
| `translationService.js` | LibreTranslate API calls |

### Routing

34 pages organized into public, authenticated, and admin route groups:

**Public:** Landing, Login, Signup
**Authenticated:** Feed, Discover, Profile, Projects, Events, Messages, Notifications, Settings, Following, Media, News, Team
**Admin:** Dashboard, Projects, Events, Users, Audit Log, News Settings, Investor Vetting

## Backend Architecture

### Express + Prisma

The backend is a TypeScript Express server using Prisma ORM. It follows a controllers/routes/services pattern:

```
Request → Route → Middleware → Controller → Service → Database/External API
```

### Middleware Chain

1. **Helmet.js** — Security headers (CSP, HSTS, CORS)
2. **Rate Limiting** — Per-endpoint limits (general: 300/15min, auth: 20/15min, upload: 30/15min)
3. **Body Parser** — JSON with 50MB limit for media
4. **Auth Middleware** — the access token is checked against its session on every request, so logging out, a ban or a deletion apply at once (see Sessions below); optional vs. required
5. **Role Guards** — Admin, staff, investor role checks
6. **Sanitization** — DOMPurify on all text inputs
7. **Audit Logging** — Admin actions logged with actor, resource, IP

### WebSocket Server

Attached to the Express HTTP server at `/ws`. Handles:

- **Notifications** — Real-time push to connected clients
- **DM delivery** — Instant message forwarding
- **Typing indicators** — Per-conversation
- **Online presence** — Track who's active
- **Heartbeat** — 30-second keepalive to prevent proxy timeouts

Authentication: the access token is sent as a WebSocket subprotocol (`new WebSocket(url, ['bies.v1', token])`), never in the URL, which proxies log. The session is checked on connect, and the socket closes with code 4003 when the session ends (4001 means: refresh the token and reconnect).

### Sessions

`services/session.service.ts` (server) and `src/services/session.js` (app):

- **Sign-in starts a session** (a `Session` row per device) and returns a 15-minute **access token** (a JWT naming the user and the session) plus a **refresh token**.
- **The refresh token** is `rt1.<session>.<mac>`, recomputed from a key derived from `JWT_SECRET`, the session's salt and a counter; the database alone can't produce one. The web app gets it as an `httpOnly`, `SameSite=Strict` cookie on `/api/auth`, which its scripts can't read; the native app and other clients get it in the response body.
- **`POST /api/auth/refresh`** replaces both tokens. A replaced refresh token presented again ends the session (a stolen copy shows up this way), except within 60 seconds, which covers a lost response or two tabs refreshing at once.
- **Sessions end** on logout (`POST /api/auth/logout`, this device), on a ban, deletion or merge (every device), after 30 days unused or 90 days after sign-in. Ended sessions are deleted after 30 days.
- **The app** refreshes a minute before the access token expires, retries once on `token_expired`, and signs out on any other 401 reason (`session_ended`, `suspended`, `account_deleted`, `invalid_token`).

### Database Schema

30+ Prisma models. Core entities:

| Model | Purpose |
|-------|---------|
| `User` | Auth identity (Nostr pubkey, email, role enum) |
| `Profile` | Display info (name, bio, avatar, skills, Lightning address) |
| `Project` | Builder projects (stage, category, funding, team) |
| `ProjectTeamMember` | Team roles (Founder, Cofounder, Advisor, Member) |
| `Investment` | Funding commitments (amount, currency, status, terms) |
| `WatchlistItem` | Investor saved projects with private notes |
| `Event` | Calendar events (NIP-52 sync, RSVP, visibility) |
| `EventAttendee` | RSVP tracking |
| `Message` | Encrypted DMs (NIP-04 reference, read receipt) |
| `Notification` | Activity feed entries |
| `Follow` | Social graph (follower/following) |
| `ZapReceipt` | NIP-57 Lightning payment tracking |
| `AuditLog` | Admin action history |
| `Session` | One per sign-in per device: refresh-token counter, idle and hard expiry, revocation |
| `PushSubscription` | Web Push API subscriptions |
| `BrowserFingerprint` | Ban evasion detection |

### External Integrations

| Service | Protocol | Purpose |
|---------|----------|---------|
| Coinos | REST API | Custodial Lightning wallet (create, pay, balance) |
| Public Nostr relays | WebSocket (NIP-01) | Reading profiles, publishing events |
| S3-compatible storage | AWS SDK | File uploads (R2, Spaces, or AWS) |
| Redis | ioredis | Distributed caching (optional, in-memory fallback) |
| SMTP | Nodemailer | Email notifications |

## Security Architecture

### Client-Side

- **Private keys never leave the browser** — encrypted with passkeys (AES-256-GCM via PRF/KiH) or NIP-49 keyfiles
- **In-memory key zeroing** — `Uint8Array.fill(0)` on logout
- **DOMPurify** — All rendered user content sanitized
- **WebAuthn origin binding** — Passkey credentials tied to the hostname

### Server-Side

- **No access to private keys** — Auth is challenge-response only
- **Encrypted token storage** — Coinos JWTs encrypted with AES-256-GCM at rest
- **Rate limiting** — Graduated per endpoint type
- **Input validation** — Zod schemas on all API inputs
- **Audit trail** — Every admin action logged
- **Fingerprinting** — Browser fingerprint tracking for ban evasion

### Network

- **HTTPS everywhere** — Nginx terminates TLS
- **CORS enforcement** — Whitelist of allowed origins
- **CSP headers** — No inline scripts, strict source policy
- **WebSocket auth** — access token (as a subprotocol) required for `/ws`, NIP-42 for `/relay`

## Data Flow Examples

### User Posts a Note to the Community Feed

```
1. User types note in compose box
2. Frontend creates kind:1 Nostr event
3. nostrSigner signs the event (in-memory key or extension)
4. If "private" toggle: publish to BIES relay only (via /relay WebSocket)
5. If "public" toggle: publish to BIES relay + public relays
6. Other connected clients receive the event via their relay subscriptions
7. Feed re-renders with the new note
```

### User Zaps Another Member

```
1. User clicks zap button on a profile/note
2. ZapModal opens, user selects amount
3. Frontend resolves recipient's Lightning address (LUD-16)
4. Frontend creates kind:9734 zap request event, signed by sender
5. LNURL callback returns a BOLT-11 invoice
6. Payment attempt chain:
   a. Coinos connected? → POST /api/wallet/coinos/pay
   b. NWC connected? → kind:23194 via NWC relay
   c. WebLN available? → window.webln.sendPayment()
   d. None? → Show QR code for manual scan
7. On payment success, zap receipt (kind:9735) appears on relays
```

### User Logs In with Passkey

```
1. User clicks "Passkey" on login page
2. keytrService checks for stored credential index (fast path)
3. If found: fetch kind:31777 events from public relays for that pubkey
4. WebAuthn prompt (biometric/PIN)
5. PRF output or KiH handle key decrypts the nsec
6. authService sends challenge request to backend
7. nostrSigner signs kind:27235 challenge event
8. Backend verifies signature and starts a session: a 15-minute access token + user object, and a refresh token (an httpOnly cookie on the web)
9. Access token stored in localStorage, nsec held in memory only
```
