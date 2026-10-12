# BIES — A Nostr Client for Productive Communities

BIES (Build in El Salvador) is a Nostr-native community client designed for groups that need more than a feed — projects, events, investments, identity, and real payments. It's the precursor to **nostrbook**: the idea that communities should own their social graph, their data, and their money, without asking permission from a platform.

Where most Nostr clients are built for open global conversation, BIES is built for **focused, productive communities** — groups of builders and investors who need to coordinate, transact, and grow together. It combines the sovereign identity and censorship resistance of Nostr with the structured collaboration tools communities actually need.

## Why This Exists

Social platforms for communities (Slack, Discord, LinkedIn) own your identity, your connections, and your content. You can't leave without losing everything. Nostr fixes identity and messaging, but most Nostr clients stop at the feed.

BIES extends Nostr into a full community operating system:

- **Your identity is your Nostr keypair** — portable, self-sovereign, verifiable (NIP-05)
- **Your messages are encrypted end-to-end** — NIP-04 DMs that no server can read
- **Your payments are Lightning-native** — zap anyone instantly, no bank required
- **Your community data lives on relays you control** — private strfry relay with NIP-42 auth
- **Your keys never touch a server** — passkey encryption, keyfiles, or browser extensions

## What It Does

### For Communities
- **Social feed** — Real-time Nostr notes (NIP-01) with media, replies, and zaps. Private community feed on your own relay, plus a public explore feed from the wider Nostr network.
- **Encrypted messaging** — NIP-04 DMs with read receipts and real-time WebSocket delivery.
- **Member directory** — Discover members by role, skills, and location. Every profile is a Nostr identity.
- **Events** — Create and manage events with RSVP, attendee tracking, and NIP-52 calendar sync.
- **Lightning payments** — Zap members, fund projects, tip content. Coinos (custodial), NWC (self-custodial), or WebLN — your choice.
- **Bilingual** — English and Spanish with real-time translation via LibreTranslate.

### For Builders
- **Project pages** — Full lifecycle tracking from Idea to Scaling with funding goals, team management, and pitch deck access controls.
- **Project updates** — Timeline-style updates published to Nostr relays.
- **Analytics** — Track impressions, unique viewers, and engagement on projects and profiles.

### For Investors
- **Deal flow** — Browse and filter projects by category, stage, and funding needs.
- **Watchlists** — Save projects with private notes.
- **Investment tracking** — Commit funding with status tracking (Pending, Committed, Completed) and multi-currency support (USD, BTC, SATS).
- **Vetting** — Investor role requires admin approval to prevent spam.

### For Admins
- **Moderation** — Approve, feature, or flag projects and events.
- **User management** — Role assignment and bans.
- **Audit log** — Every admin action logged with actor, resource, IP, and timestamp.

## The Nostrbook Vision

BIES is a vertical-specific implementation of a broader pattern: **community-owned social platforms built on Nostr**. The architecture is designed so that the community-specific parts (builder/investor roles, project tracking, investment commitments) sit on top of a general-purpose Nostr social layer (feed, messaging, identity, payments, events).

That general-purpose layer is what becomes **nostrbook** — a framework where any community can stand up their own productive social platform with:

- Sovereign identity (Nostr keypairs, not email/password)
- Private community spaces (authenticated relays)
- Structured collaboration (projects, events, roles)
- Native payments (Lightning, not Stripe)
- Portable social graphs (follow lists on Nostr, not locked in a database)

The investment/builder features in BIES are the first "vertical module." Future communities could swap in their own: research groups, DAOs, cooperatives, creator collectives, local business networks.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, Vite 5, React Router 6, styled-jsx |
| Backend | Express 4, TypeScript, Prisma ORM, Zod |
| Database | SQLite (dev) / PostgreSQL (prod) |
| Auth | Nostr NIP-42, Passkeys (WebAuthn/keytr), NIP-49 keyfiles, JWT |
| Payments | Lightning via Coinos, NWC (NIP-47), WebLN, NIP-57 zaps |
| Relay | strfry with NIP-42 auth proxy |
| Storage | S3-compatible (R2, Spaces, AWS) or local |
| Translation | LibreTranslate (EN/ES) |
| Deployment | Docker Compose (6 services), Nginx |
| Testing | Playwright E2E |

## Nostr Protocol Usage

BIES implements these NIPs to build a full community client on top of the Nostr protocol:

| NIP | What BIES Uses It For |
|-----|----------------------|
| NIP-01 | Social feed — publishing and reading notes |
| NIP-04 | Encrypted direct messages between members |
| NIP-05 | Identity verification (`username@buildinelsalvador.com`) |
| NIP-06 | BIP-39 seed phrase key generation on signup |
| NIP-19 | Bech32 encoding for public/private keys (npub/nsec) |
| NIP-42 | Private relay authentication — only members can read/write |
| NIP-46 | Browser extension signing (Alby, nos2x) |
| NIP-47 | Nostr Wallet Connect for self-custodial payments |
| NIP-49 | Encrypted keyfile backup (`.nostrkey` files) |
| NIP-52 | Calendar events (kind:31923) |
| NIP-57 | Lightning zaps with on-chain receipts |

## Key Management

Private keys never touch the server. BIES offers multiple client-side key management options, all producing the same result: a signed Nostr challenge-response that proves identity to the backend.

| Method | How It Works | Best For |
|--------|-------------|----------|
| **Passkeys** (keytr) | PRF or KiH encryption via WebAuthn, keys stored as kind:31777 events on public relays | Daily login, cross-device |
| **NIP-49 keyfiles** | scrypt + XChaCha20-Poly1305 encrypted `.nostrkey` files | Offline backup, portability |
| **Browser extensions** | NIP-46 delegation to Alby, nos2x, etc. | Power users with existing setups |
| **Seed phrases** | BIP-39 (NIP-06) mnemonic recovery | Emergency recovery |

See [docs/passkey-implementation.md](docs/passkey-implementation.md), [docs/keytr-implementation.md](docs/keytr-implementation.md), and [docs/nostrkey-download.md](docs/nostrkey-download.md) for technical details.

## Architecture

```
Browser (React SPA)
    │
    │── HTTPS / WebSocket
    │
    ├── Nginx (reverse proxy + static frontend)
    │       │
    │       ├── /api ──► Express Backend (REST + WebSocket)
    │       │               │
    │       │               ├── SQLite / PostgreSQL (structured data)
    │       │               ├── Redis (optional cache)
    │       │               ├── S3/R2 (file storage)
    │       │               └── Coinos API (Lightning wallets)
    │       │
    │       └── /relay ──► NIP-42 Auth Proxy
    │                       │
    │                       └── strfry (private Nostr relay)
    │
    ├── Public Nostr Relays (damus, primal, nos.lol, etc.)
    │
    └── LibreTranslate (EN/ES)
```

See [docs/architecture.md](docs/architecture.md) for the full breakdown.

## Getting Started

### Prerequisites
- Node.js 20+
- npm

### Development Setup

```bash
# Frontend
npm install

# Backend
cd server && npm install

# Configure environment
cp server/.env.example server/.env
# Edit server/.env — JWT_SECRET and ENCRYPTION_SECRET are required

# Set up database
cd server
npm run db:migrate   # Apply migrations (records history for later schema work)
npm run db:seed      # Optional: populate test data

# Start dev servers (two terminals)
cd server && npm run dev     # Backend on :3001
npm run dev                  # Frontend on :5173
```

Vite proxies `/api`, `/ws`, `/relay`, and `/uploads` to the backend automatically.

### Production (Docker)

```bash
docker compose up -d
```

Starts 6 services: Express backend, strfry relay, NIP-42 auth proxy, LibreTranslate, Nginx, and bug tracker. Access at `http://localhost:8082`.

See [docs/development.md](docs/development.md) and [docs/deployment.md](docs/deployment.md) for detailed guides.

## Project Structure

```
BIES/
  src/                    # React frontend
    pages/                # 34 route pages
    components/           # Reusable UI (Feed, ZapModal, Navbar, etc.)
    services/             # Nostr, auth, payments, media, signing
    context/              # Auth, Theme, UserMode providers
    hooks/                # useAuth, useWallet, useNostr, useZap
    config/               # Feature flags
    i18n/                 # EN/ES translations
  server/                 # Express backend (TypeScript)
    src/
      controllers/        # 23 controllers
      routes/             # 22 REST API route files
      services/           # Nostr, Coinos, WebSocket, storage
      middleware/          # Auth, rate limiting, sanitization, audit
    prisma/               # Schema (30+ models), migrations, seed
  relay/                  # strfry Nostr relay + write policy
  relay-proxy/            # NIP-42 authentication proxy
  deploy/                 # Nginx config
  docs/                   # Technical documentation
  e2e/                    # Playwright E2E tests
```

## Documentation

| Document | Description |
|----------|-------------|
| [Architecture](docs/architecture.md) | System design, service topology, data flow |
| [Nostr Integration](docs/nostr-integration.md) | Protocol usage, relay strategy, event kinds |
| [Development Guide](docs/development.md) | Local setup, scripts, testing, project layout |
| [Deployment Guide](docs/deployment.md) | Docker, Nginx, environment variables, production |
| [Passkey Implementation](docs/passkey-implementation.md) | WebAuthn PRF encryption, storage, session lifecycle |
| [Keytr Implementation](docs/keytr-implementation.md) | NIP-K1 library integration, PRF/KiH modes |
| [NIP-49 Keyfiles](docs/nostrkey-download.md) | Encrypted `.nostrkey` file format and flows |
| [Coinos Wallet](docs/coinos-wallet-integration.md) | Custodial Lightning wallet integration |

## License

Private — All rights reserved.
