# Runtime Feature Toggles

Admin-controlled feature flags: true admins flip features on/off from
**Admin → Features** and — without a redeploy — disabled features disappear
from the UI (nav + routes), are blocked at the API, and background work for
them pauses.

## Slugs

| Slug | Covers | Server gate |
|---|---|---|
| `directories` | Farm + certified provider directories | `/api/directory` |
| `talent` | BIES Talents: members' skills and services with their proof of work (`/talents`, the profile's Talents tab) | `/api/talent` |
| `points` | Leaderboard, profile points/badges UI, gamification toasts, scorer, NIP-58 publishing | `/api/points` + scorer/maintenance/badge boot |
| `events` | Events pages | `/api/events` |
| `media` | Media page | `/api/media` |
| `news` | News page content, Twitter/news refresh loop | per-endpoint inside `/api/news` (see below) |
| `messages` | Direct messages | `/api/messages` |
| `zaps` | Zap buttons, Coinos wallet | `/api/wallet` |
| `feedback` | Bug/feedback tracker | `/api/feedback` |
| `investors` | Investor features + vetting | `/api/investors`, `/api/investments` |
| `projects` | Project listings/pages | `/api/projects` |
| `cowork` | Cowork check-in page | none — pure client-side Nostr (kind 31980 on the private relay); UI gate only |
| `marketplace` | Shopstr-compatible NIP-99 marketplace + moderation blocklist | `/api/marketplace` |
| `bounties` | Bounty board, submissions, escrow/payout + maintenance loop | `/api/bounties` |

Feed, Discover, profiles, auth, courses and admin are core and **not**
toggleable.

`marketplace` and `bounties` are **additionally** guarded by the build-time
constants `MARKETPLACE_ENABLED` / `BOUNTIES_ENABLED` in
`src/config/featureFlags.js` — a feature is visible only when its build
constant is `true` **and** its runtime flag is on. The build constants are a
frontend-only hard kill-switch (a rebuild); the runtime flag is the live admin
toggle. The bounties maintenance loop pauses while the flag is off, but the
zap-settlement matcher (`matchBountyPayout`) stays live so an already-awarded
bounty's incoming zap still settles.

## Semantics

- **Default enabled.** Every flag defaults to `true`. Missing slugs in
  storage read as enabled, so new features ship on and old DB rows never
  break. Unknown slugs in storage are ignored.
- **Fail-open everywhere.** A DB/cache error on the server yields
  all-enabled (uncached). On the client, flags default to all-enabled while
  loading and keep the last known values on fetch errors — a flaky API can
  never hide the app.
- **Storage.** JSON map in `site_settings.feature_flags` (SiteSettings
  singleton, `id = "default"`).
- **Cache.** Server reads are cached (`feature_flags:default`,
  `TTL.FEATURE_FLAGS` = 300 s) and invalidated on write, so the toggling
  admin sees changes immediately; other instances/users converge within
  ~5 minutes (or on their next window-focus refetch).
- **API.** `GET /api/flags` (public, tiny payload, never gated) and
  `PUT /api/admin/flags` (authenticate + `requireRole('ADMIN')` — true
  admins only, MODs rejected; strict Zod partial `{ slug: boolean }`;
  audit-logged as `ADMIN_ACTION`).
- **Server gate.** `featureGate(slug)` middleware returns
  `404 { "error": "Feature disabled" }` for a disabled prefix. Admin routes
  and the flags endpoints are never gated (admins must always be able to
  re-enable). `/api/news/settings` stays reachable while `news` is off
  because the Media page (livestream) and the admin news panel depend on it;
  only the news-content endpoints (`/stories`, `/bies-updates`,
  `/twitter-feed`, `/live-feed`) are gated.
- **Background services.** The points scorer checks `points` at boot
  (deferred start when off), inside the live `onevent` handler and on every
  maintenance tick — turning points off stops scoring within the cache TTL,
  and re-enabling starts a deferred scorer without a restart. The
  Twitter/news refresh loop no-ops while `news` is off; NIP-58 badge
  definition publishing skips while `points` is off. Skips are logged once
  per off→on cycle. Note: while `points` is off, the pending NIP-58 award
  sweep also pauses (it runs on the points maintenance tick).
- **Client.** `FeatureFlagsContext` fetches `GET /api/flags` at boot
  (pre-auth) and refetches on window focus. `useFeature(slug)` treats only
  an explicit `false` as disabled. `FeatureRoute` renders the standard 404
  page for disabled routes; nav lists (`Navbar`, `MobileBottomNav`,
  `CustomizeNavbar`, `Dashboard`) carry `flag:` keys and filter disabled
  entries — including from user-customized bottom-nav tab sets (the stored
  preference is untouched, so re-enabling restores the user's tabs).

## Adding a new flag

1. Add the slug to `FEATURE_SLUGS` in
   `server/src/services/featureFlags.service.ts` **and** its mirror in
   `src/config/featureSlugs.js` (keep the two lists in sync).
2. Mount `featureGate('<slug>')` on the feature's `/api` prefix in
   `server/src/index.ts` (or per-endpoint inside the router if the prefix
   hosts shared endpoints). Gate any background loops with
   `isEnabled('<slug>')`.
3. Gate the UI: wrap routes in `<FeatureRoute flag="<slug>">`, add `flag:`
   keys to the nav entries in `src/components/Navbar.jsx`,
   `src/config/navPages.js` and `src/pages/Dashboard.jsx`, and hide inline
   entry points with `useFeature('<slug>')`.
4. Add `features.slugs.<slug>.{name,description}` to
   `src/i18n/locales/en.json` and `es.json` (both in the same commit).
5. Nothing else: the flag defaults to enabled, storage needs no backfill,
   and the admin page lists it automatically from `FEATURE_SLUGS`.
