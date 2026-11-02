# BIES — the Build in El Salvador community app

BIES is the app for the [Build in El Salvador](https://buildinelsalvador.com) community: the people, businesses, farms, events and opportunities that make up the builder scene in El Salvador. It runs on the web at [app.buildinelsalvador.com](https://app.buildinelsalvador.com) and as a native app for iOS and Android.

Under the hood it is a Nostr client. Every member's identity is a Nostr keypair they can take with them, the community feed runs on BIES's own members-only relay, and members choose what, if anything, goes out to the wider Nostr network.

## What it does

### For members
- **Feed** — Posts, replies, reactions and reposts on the private BIES relay. On the web, members can also read the public Nostr network and post to it.
- **Members** — Find people in the community by skills, location and what they're working on. Profiles have photo albums, details and recommendations.
- **Businesses** — A directory of local businesses, with **BIES Trusted** recommendations ("vouches") and reviews from members.
- **Farms** — A directory of farms, their products, and places to stay.
- **BIES Talents** — Members show their skills and services with photos and videos as proof of work.
- **Opportunities** — Jobs, partnerships, businesses for sale, grants and programs, and projects looking to meet the right people.
- **Events** — Official BIES events and community meetups. Hosts can be businesses, with co-hosts and sponsors. Tickets open the host's own page (pretix, Luma).
- **Notifications** — In-app and push notifications.
- **Privacy** — Members choose who sees each part of their profile, whether they appear in the directory, and who they block.
- **Bilingual** — English and Spanish.

### Your account and your key
- **Sign in with email** — The app holds an encrypted Nostr key for the member and signs for them, so no Nostr knowledge is needed to join.
- **Take your key** — An email member can export their key at any time (nsec, QR code, or an encrypted NIP-49 backup) and move to self-custody. BIES then deletes its copy.
- **Sign in with Nostr** — Browser extension (NIP-07), remote signer (NIP-46 bunker or nostrconnect), Amber (NIP-55, Android browser), nsec or seed phrase, encrypted key file (NIP-49), or a passkey (web only).
- **Delete account** — Removes the account and its posts from BIES and its relay. For email accounts, BIES also asks public relays to delete them.

### For admins
- **Moderation** — Reports, bans, blocks and listing review.
- **Feature flags** — Turn features on or off at runtime, without a deploy.
- **Feedback** — Testers and members report problems from any page, with a screenshot.
- **Audit log** — Every admin action is recorded.

### Built but switched off
These features are in the code but switched off in production. Admins can turn them on at runtime: Lightning wallet and zaps, encrypted direct messages (NIP-17), points and leaderboard, marketplace (NIP-99, Shopstr-compatible), bounties, cowork, courses, media and news. See [docs/feature-toggles.md](docs/feature-toggles.md).

The iOS and Android apps include only the features listed in [src/config/appScope.js](src/config/appScope.js). Anything outside that list stays off in the apps even if its flag is on, because new app features ship with an app update.

## Tech stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, Vite 5, React Router 6, styled-jsx |
| Native apps | Capacitor 8 (iOS and Android) |
| Backend | Express 4, TypeScript, Prisma ORM, Zod |
| Database | SQLite (dev) / PostgreSQL (prod) |
| Auth | Email code with a hosted signer, NIP-07, NIP-46, NIP-55, NIP-49 key files, passkeys, NIP-42 relay auth |
| Relay | strfry, behind a NIP-42 auth proxy (members only) |
| Payments (off by default) | Lightning via NWC (NIP-47), WebLN and Coinos; NIP-57 zaps |
| Storage | S3-compatible (R2, Spaces, AWS) or local disk |
| Translation | LibreTranslate (EN/ES) |
| Deployment | Docker Compose, Nginx |
| Testing | Vitest (server), Node test runner (client units), Playwright (E2E) |

## Nostr protocol usage

| NIP | What BIES uses it for |
|-----|----------------------|
| NIP-01 | Notes, profiles (kind 0), reactions |
| NIP-05 | `name@buildinelsalvador.com` identifiers for every member |
| NIP-06 | Seed phrase sign-in |
| NIP-07 | Browser extension sign-in |
| NIP-09 / NIP-62 | Deletion requests when an account is deleted |
| NIP-17 | Encrypted direct messages (flagged off) |
| NIP-19 | npub / nsec / ncryptsec encoding |
| NIP-42 | Members-only relay authentication |
| NIP-46 | Remote signer sign-in (bunker, nostrconnect) |
| NIP-47 | Nostr Wallet Connect (flagged off) |
| NIP-49 | Encrypted key backups |
| NIP-52 | Calendar events and RSVPs |
| NIP-55 | Amber signer on Android |
| NIP-57 | Lightning zaps (flagged off) |
| NIP-99 | Directory and marketplace listings |

See [docs/nostr-integration.md](docs/nostr-integration.md) for more detail.

## Architecture

```
Web app (React)  ·  iOS / Android (Capacitor)
    │
    │── HTTPS / WebSocket
    │
    ├── Nginx (reverse proxy + static frontend)
    │       │
    │       ├── /api ──► Express backend (REST + WebSocket)
    │       │               │
    │       │               ├── PostgreSQL (structured data)
    │       │               ├── Hosted signer (keys for email accounts)
    │       │               └── S3 / local uploads
    │       │
    │       └── /relay ──► NIP-42 auth proxy ──► strfry (private BIES relay)
    │
    ├── Public Nostr relays (only when a member publishes publicly)
    │
    └── LibreTranslate (EN/ES)
```

See [docs/architecture.md](docs/architecture.md) for the full breakdown.

## Getting started

### Prerequisites
- Node.js 24 (see `.nvmrc`)
- npm

### Development setup

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
npm run db:migrate   # Apply migrations
npm run db:seed      # Optional: populate test data

# Start dev servers (two terminals)
cd server && npm run dev     # Backend on :3001
npm run dev                  # Frontend on :5173
```

Vite proxies `/api`, `/ws`, `/relay` and `/uploads` to the backend.

### Checks

```bash
npm run lint
npm run test:unit
cd server && npm test
```

### Production (Docker)

```bash
docker compose up -d
```

This starts the backend, the strfry relay, the NIP-42 auth proxy, LibreTranslate, the feedback tracker and Nginx. See [docs/deployment.md](docs/deployment.md).

### Native apps

See [docs/IOS_TESTFLIGHT.md](docs/IOS_TESTFLIGHT.md) and [docs/ANDROID.md](docs/ANDROID.md).

## Project structure

```
BIES/
  src/                    # React frontend
    pages/                # Route pages
    components/           # Reusable UI
    services/             # Nostr, auth, signing, media, payments
    config/               # Feature flags and app scope
    i18n/                 # EN/ES translations
  server/                 # Express backend (TypeScript)
    src/
      controllers/
      routes/
      services/           # Nostr, hosted signer, storage, WebSocket
      middleware/         # Auth, rate limiting, sanitization, audit
    prisma/               # Schema, migrations, seed
  relay/                  # strfry relay + write policy
  relay-proxy/            # NIP-42 authentication proxy
  ios/, android/          # Capacitor native projects
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
| [Feature Toggles](docs/feature-toggles.md) | Runtime feature flags |
| [iOS / TestFlight](docs/IOS_TESTFLIGHT.md) | Building and shipping the iOS app |
| [Android](docs/ANDROID.md) | Building and shipping the Android app |
| [Keytr Implementation](docs/keytr-implementation.md) | Passkey sign-in |
| [NIP-49 Keyfiles](docs/nostrkey-download.md) | Encrypted key file format and flows |
| [Coinos Wallet](docs/coinos-wallet-integration.md) | Custodial Lightning wallet integration |

## License

Private — All rights reserved.
