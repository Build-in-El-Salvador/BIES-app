# Deployment Guide

BIES deploys as 6 Docker containers orchestrated by Docker Compose. This guide covers production setup, configuration, and operations.

## Prerequisites

- **Docker** 24+ and **Docker Compose** v2
- A server with at least 2 GB RAM and 2 CPU cores
- A domain name with DNS pointing to the server
- TLS certificate (Let's Encrypt recommended)

## Architecture Overview

```
Internet
    │
    │ HTTPS (port 443)
    │
┌───▼──────────────────────────┐
│  External Reverse Proxy      │ ← Caddy, Traefik, or Nginx
│  (TLS termination)           │    with Let's Encrypt
└───┬──────────────────────────┘
    │ HTTP (port 8082)
    │
┌───▼──────────────────────────┐
│  bies-nginx (internal)       │
│  Static frontend + routing   │
│                              │
│  / ──────► Static React SPA  │
│  /api ───► bies-server:3001  │
│  /ws ────► bies-server:3001  │
│  /relay ─► bies-auth-proxy   │
│  /uploads ► static files     │
└──────────────────────────────┘
```

The internal Nginx listens on `127.0.0.1:8082`. You'll need an external reverse proxy (Caddy, Traefik, or another Nginx instance) to handle TLS and forward traffic.

## Quick Deploy

### 1. Configure Environment

```bash
cp server/.env.example server/.env
```

Edit `server/.env` for production:

```bash
# Required
NODE_ENV=production
JWT_SECRET="$(openssl rand -base64 64)"
ENCRYPTION_SECRET="$(openssl rand -hex 16)"
CORS_ORIGIN="https://your-domain.com"

# Database — PostgreSQL recommended for production
DATABASE_URL="postgresql://user:password@host:5432/bies?schema=public&connection_limit=20"

# Or keep SQLite for smaller deployments (< 100 users)
# DATABASE_URL="file:../data/bies.db"
```

### 2. Build and Start

```bash
docker compose up -d --build
```

This builds and starts all 6 services:

| Service | Purpose | Memory Limit |
|---------|---------|-------------|
| `bies-server` | Express backend | 512 MB |
| `bies-relay` | strfry Nostr relay | 256 MB |
| `bies-auth-proxy` | NIP-42 relay auth | 128 MB |
| `bies-translate` | LibreTranslate EN/ES | 512 MB |
| `bies-nginx` | Reverse proxy + static | 128 MB |
| `bies-bugs` | Bug tracker | 128 MB |

Total memory footprint: ~1.5 GB under load.

### 3. Set Up External TLS Proxy

**Caddy (simplest — automatic HTTPS):**

```
your-domain.com {
    reverse_proxy localhost:8082
}
```

**Nginx (with Let's Encrypt):**

```nginx
server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8082;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # WebSocket upgrade for /ws and /relay
    location ~ ^/(ws|relay)$ {
        proxy_pass http://127.0.0.1:8082;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400;
    }
}
```

### 4. Verify

```bash
# Check service health
docker compose ps

# Check backend health
curl https://your-domain.com/api/health

# Check logs
docker compose logs -f bies-server
```

## Environment Variables

### Required

| Variable | Description | Example |
|----------|-------------|---------|
| `JWT_SECRET` | 64-char base64 string for JWT signing | `openssl rand -base64 64` |
| `ENCRYPTION_SECRET` | 32-char string for AES-256-GCM | `openssl rand -hex 16` |
| `DATABASE_URL` | Database connection string | `postgresql://...` or `file:../data/bies.db` |
| `CORS_ORIGIN` | Allowed origins (comma-separated). Must match the web app's origin exactly: sign-in, session refresh and logout refuse any other site | `https://app.buildinelsalvador.com` |

### Recommended

| Variable | Description | Default |
|----------|-------------|---------|
| `TRUST_PROXY` | Proxies in front of the server. Production needs `2` (YunoHost nginx, then the container nginx), or every visitor shares one rate limit | `1` |
| `RESEND_API_KEY` | Resend key ("Sending access" only) for sign-in codes. Without it, production can't send codes | — |
| `ADMIN_PUBKEYS` | Hex Nostr pubkeys auto-promoted to ADMIN | (empty) |
| `NOSTR_RELAYS` | Public relays for reading | `wss://relay.damus.io,...` |
| `REDIS_URL` | Redis for distributed caching | In-memory fallback |

### Optional

| Variable | Description | Default |
|----------|-------------|---------|
| `S3_ENDPOINT` | S3-compatible storage endpoint | Local `uploads/` directory |
| `S3_REGION` | S3 region | `auto` |
| `S3_ACCESS_KEY` | S3 access key | — |
| `S3_SECRET_KEY` | S3 secret key | — |
| `S3_BUCKET` | S3 bucket name | — |
| `S3_PUBLIC_URL` | CDN URL for public files | — |
| `COINOS_API_URL` | Coinos API base URL | `https://coinos.io/api` |
| `EMAIL_FROM` | Sender of sign-in codes | `BIES <login@buildinelsalvador.com>` |
| `EMAIL_CODES_MAX_PER_DAY` | Most sign-in codes sent per 24 h, all addresses together. Resend's free plan allows 100 emails a day in total | `60` |
| `REVIEW_LOGIN_EMAIL` | App Review address that signs in with a fixed code | Off |
| `REVIEW_LOGIN_CODE` | That fixed code: 6 digits, kept out of the code | Off |
| `ACCESS_TOKEN_SECONDS` | Lifetime of an access token; the app renews it before it runs out | `900` |
| `SESSION_IDLE_DAYS` | A session unused this long ends | `30` |
| `SESSION_MAX_DAYS` | Every session ends this long after sign-in | `90` |

`JWT_EXPIRES_IN` is no longer read: access tokens last `ACCESS_TOKEN_SECONDS`, and sessions are renewed with refresh tokens.

## Docker Compose Details

### Volumes

| Volume | Mounted To | Purpose |
|--------|-----------|---------|
| `bies-data` | `/app/data` on bies-server | SQLite database file (if using SQLite) |
| `bies-uploads` | `/app/uploads` on server + nginx | User-uploaded files |
| `relay-data` | `/app/strfry-db` on bies-relay | strfry relay database |
| `relay-whitelist` | Shared between server + relay + proxy | Pubkey whitelist for relay access |
| `bugs-data` | `/app/data` on bies-bugs | Bug tracker data |

### Networks

All services communicate over the `bies-net` bridge network. Only `bies-nginx` exposes a port to the host (`127.0.0.1:8082`).

### Health Checks

- **bies-server:** `GET /api/health` every 30s
- **bies-translate:** Python HTTP check on `/languages` every 30s (60s startup grace)
- **bies-nginx:** Depends on bies-server being healthy before starting

### Resource Limits

Each service has a memory limit set in `docker-compose.yml` via `deploy.resources.limits.memory`. Adjust if you're seeing OOM kills:

```yaml
bies-server:
  deploy:
    resources:
      limits:
        memory: 1G  # increase from default 512M
```

## Multi-Stage Docker Build

The `Dockerfile` uses a multi-stage build:

| Stage | Base | Purpose | Output |
|-------|------|---------|--------|
| `client-build` | node:20-alpine | Compile React SPA with Vite | `dist/` |
| `server-build` | node:20-alpine | Compile TypeScript backend | `dist/`, `node_modules/` |
| `server` | node:20-alpine | Production backend runtime | Runs on port 3001 |
| `nginx` | nginx:1.27-alpine | Static frontend + reverse proxy | Serves on port 8080 |

The server stage runs as a non-root user with `tini` as the init process.

## Database

### SQLite (Small Deployments)

Default for dev and small deployments (< 100 concurrent users):

```bash
DATABASE_URL="file:../data/bies.db"
```

The SQLite file lives in the `bies-data` Docker volume. Backup by copying the volume.

### PostgreSQL (Production)

Recommended for 100+ concurrent users:

```bash
DATABASE_URL="postgresql://bies:password@db-host:5432/bies?schema=public&connection_limit=20&pool_timeout=20"
```

PostgreSQL can run in Docker or as a managed service (AWS RDS, DigitalOcean Managed DB, Supabase).

### Migrations

The server container applies migrations at boot via `server/docker-entrypoint.sh`,
which runs `prisma migrate deploy` before starting the app. Boot never uses
`prisma db push` anymore — the old `db push --accept-data-loss` boot step could
silently drop data on schema changes and is gone.

**Baselining.** The migration history was squashed into a single baseline
migration (`20260704000000_baseline`) because earlier schema changes were only
ever applied with `db push` and no database has a complete `_prisma_migrations`
table. On boot, the entrypoint handles three states:

1. **Fresh/empty database** — `migrate deploy` applies the baseline and
   everything after it.
2. **Existing database without a baseline record** (created by `db push`,
   `_prisma_migrations` missing or lacking the baseline row) — the entrypoint
   first verifies the database schema actually matches `schema.prisma`
   (`prisma migrate diff --exit-code`); a mismatch — e.g. a restored old
   backup — aborts the boot loudly instead of mis-baselining. On a match it
   runs `prisma migrate resolve --applied 20260704000000_baseline` once. This
   is bookkeeping only: it records the baseline as applied and never touches
   application tables or data. Then `migrate deploy` runs as usual.
3. **Already-migrated database** — `migrate deploy` is a no-op (or applies
   only newer migrations).

The check is idempotent, so restarts are safe. Any other state — for example a
failed migration row in `_prisma_migrations` (including a baseline row left by
an interrupted first boot) — makes `migrate deploy` fail loudly with Prisma's
own error (P3009) instead of being auto-repaired; fix it with
`prisma migrate resolve` manually (see
[Prisma's troubleshooting guide](https://www.prisma.io/docs/orm/prisma-migrate/workflows/patching-and-hotfixing)).

Automatic baselining only applies to SQLite `file:` URLs. A pre-existing
non-SQLite database (e.g. PostgreSQL) must be baselined manually with
`prisma migrate resolve --applied 20260704000000_baseline` before its first
boot on this flow (note: the committed migrations are SQLite SQL — a
PostgreSQL deployment needs its own migration history anyway).

**Before the first deploy of this flow** (and before any risky schema
change), take a consistent snapshot of the database — pause first so the
SQLite WAL is checkpointed:

```bash
docker compose pause bies-server
docker compose cp bies-server:/app/data/bies.db ./pre-baseline-backup.db
docker compose unpause bies-server
```

**Escape hatch.** Setting `DB_BOOT_MODE=push` on the server container restores
the legacy `db push` boot behavior in an emergency. It bypasses migration
tracking — use it only to get a broken deploy back up. **Before removing it,
reconcile the migration state**, or the next migrate-mode boot fails again:

- If a migration had failed (P3009), its objects now exist via push — mark it
  `prisma migrate resolve --applied <migration_name>`.
- If push applied `schema.prisma` changes that have no migration file, codify
  them: `prisma migrate diff --from-migrations prisma/migrations
  --to-schema-datamodel prisma/schema.prisma --script` → save as a new
  migration directory, commit it, and `prisma migrate resolve --applied` it on
  the production DB (the objects already exist).

**Rollback.** Reverting a deploy to a pre-migrate-flow image (old `db push`
boot) after post-baseline migrations have been applied is destructive: push
syncs the DB to the reverted schema (dropping those migrations' tables and
columns) but leaves their `_prisma_migrations` rows marked applied. Before
returning to the migrate flow, delete those stale rows
(`DELETE FROM _prisma_migrations WHERE migration_name = '<rolled-back one>'`)
so `migrate deploy` re-applies them; otherwise the server boots cleanly but
crashes at runtime on the missing tables.

**Making schema changes.** `db push` alone is no longer enough for production —
every schema change must ship a migration file:

```bash
cd server
# Creates prisma/migrations/<timestamp>_<name>/migration.sql and applies it locally
npx prisma migrate dev --name my_change
```

Commit the generated migration directory together with the `schema.prisma`
change. The next deploy applies it automatically at boot.

The `prisma` CLI is a production dependency and is baked into the image, so
boot-time migrations work without network access to the npm registry (the old
setup fetched an unpinned `prisma` from npm on every container start).

## Relay Configuration

### Private Relay (strfry)

The strfry relay runs with a write policy that restricts publishing to whitelisted pubkeys. The whitelist is shared between the server, relay, and auth proxy via the `relay-whitelist` volume.

**The backend manages the whitelist automatically:**
- Pubkey added on successful signup
- Pubkey removed on ban

### Auth Proxy

The NIP-42 auth proxy sits between Nginx and strfry:

| Variable | Default | Description |
|----------|---------|-------------|
| `PROXY_PORT` | `7778` | Proxy listen port |
| `UPSTREAM_RELAY` | `ws://bies-relay:7777` | strfry address |
| `WHITELIST_PATH` | `/app/data/whitelist.txt` | Pubkey whitelist file |
| `RELAY_URL` | `wss://relay.buildinelsalvador.com` | Public relay URL (for NIP-42 challenge) |
| `AUTH_TIMEOUT_MS` | `60000` | Auth challenge timeout |

## File Storage

### Local (Default)

Files are stored in the `bies-uploads` Docker volume, served directly by Nginx at `/uploads/*`.

### S3-Compatible (Recommended for Production)

Set `S3_*` environment variables to use Cloudflare R2, DigitalOcean Spaces, or AWS S3:

```bash
S3_ENDPOINT="https://your-account.r2.cloudflarestorage.com"
S3_REGION="auto"
S3_ACCESS_KEY="your-access-key"
S3_SECRET_KEY="your-secret-key"
S3_BUCKET="bies-uploads"
S3_PUBLIC_URL="https://pub-xxxxx.r2.dev"
```

The `S3_PUBLIC_URL` is used for publicly accessible files (avatars, thumbnails). Private files (pitch decks) are served via presigned URLs.

## Monitoring

### Logs

```bash
# All services
docker compose logs -f

# Specific service
docker compose logs -f bies-server

# Last 100 lines
docker compose logs --tail=100 bies-server
```

### Health

```bash
# Service status
docker compose ps

# Backend health
curl http://localhost:8082/api/health
# Returns: { "status": "ok", "version": "0.3.0", "timestamp": "..." }

# Backend version
curl http://localhost:8082/api/version
```

### Resource Usage

```bash
docker stats
```

## Backup

### SQLite

```bash
# Stop writes temporarily
docker compose pause bies-server

# Copy the database
docker compose cp bies-server:/app/data/bies.db ./backup-$(date +%Y%m%d).db

# Resume
docker compose unpause bies-server
```

### PostgreSQL

```bash
pg_dump -h db-host -U bies -d bies > backup-$(date +%Y%m%d).sql
```

### Relay Data

```bash
docker compose cp bies-relay:/app/strfry-db ./relay-backup-$(date +%Y%m%d)
```

### Uploads

```bash
docker compose cp bies-nginx:/app/uploads ./uploads-backup-$(date +%Y%m%d)
```

## Updates

```bash
# Pull latest code
git pull

# Rebuild and restart
docker compose up -d --build

# Check logs for errors
docker compose logs -f bies-server
```

For zero-downtime deploys, use a blue-green strategy with the external reverse proxy.

## Scaling Notes

### Single Server (Current)

The current architecture handles 500+ concurrent WebSocket connections on a single Node.js process. For most communities (< 1000 active users), a single server with 2-4 GB RAM is sufficient.

### Beyond Single Server

When you need to scale:

1. **Database:** Move from SQLite to PostgreSQL with connection pooling (PgBouncer)
2. **Cache:** Enable Redis for shared state across multiple backend instances
3. **Storage:** Move uploads to S3-compatible storage
4. **Backend:** Run multiple `bies-server` instances behind a load balancer (WebSocket sticky sessions required)
5. **Relay:** strfry handles high throughput natively; scale horizontally by running multiple relays with shared storage

## Troubleshooting

### Backend Won't Start

```bash
docker compose logs bies-server
```

Common causes:
- Missing `JWT_SECRET` or `ENCRYPTION_SECRET` in `.env`
- Invalid `DATABASE_URL` (PostgreSQL not reachable)
- Port 3001 already in use

If the container crash-loops right after a deploy, check the logs for Prisma
migration errors first (`P3009` failed migration, `P3018` object already
exists). Recovery: `prisma migrate resolve --rolled-back <name>` for a
migration that died before applying, `--applied <name>` for one whose objects
already exist — see the Migrations section above. Note that while a deploy
fails, `deploy/auto-deploy.sh` retries the full `--no-cache` rebuild on every
cron tick until it succeeds (check `deploy/deploy.log`).

### Relay Auth Fails

```bash
docker compose logs bies-auth-proxy
```

Common causes:
- Whitelist file empty or missing
- `RELAY_URL` doesn't match the actual public URL
- Clock skew between client and server (NIP-42 challenges are time-bound)

### LibreTranslate Slow to Start

LibreTranslate downloads language models on first boot. The health check has a 60-second startup grace period. First cold start can take 2-5 minutes.

### WebSocket Connection Drops

- Check Nginx `proxy_read_timeout` is set to a high value (86400 for 24h)
- Check external reverse proxy WebSocket upgrade headers
- The backend sends heartbeats every 30 seconds to prevent proxy timeouts
