# Invite-only sign-up

A switch in the phone app's **Admin Panel → Invites** decides whether new
accounts need an invite code. It ships **off**. Members who already have an
account always sign in as before; only creating an account is affected.

## How it works

- **Making a code.** Admins only (`isAdmin`; never moderators), in the phone
  app's Admin Panel. One tap makes a code like `BIES-K7M4-Q9TX`; Share sends a
  ready-made message with a link and the code. Nothing about the person is
  asked for; an optional note ("Juan, Nov meetup") is seen only by admins.
- **Using a code.** While the switch is on, a signed-out person sees the
  invite screen first (`/invite`). The code is checked there, then sent with
  sign-up, by email or with a Nostr key. A new person who picks Sign in
  instead is asked for a code after the email code, with no second email code.
- **Links** carry the code after `#`: `https://app.buildinelsalvador.com/invite#BIES-K7M4-Q9TX`.
  They open the app if it's installed (iOS universal links, Android app links
  once `assetlinks.json` is in place) and the invite page otherwise.
- **While the switch is off**, sign-up is open, and a code that's used still
  records who invited whom.

## The codes

- 8 characters from `crypto.randomInt` over 31 letters and digits without
  look-alikes (no 0/O, 1/I/L). Case, spaces and dashes don't matter.
- Work once, for 7 days (`INVITE_CODE_DAYS`, 1–30), until revoked, and only
  while the admin who made them still is one. At most 100 open at once.
- **Never stored as they are.** The database holds an HMAC-SHA256 of each
  code under a key derived from `ENCRYPTION_SECRET` (so a copy of the table
  can't be turned back into codes), plus an AES-256-GCM copy for admins to
  share an open code again, wiped once it's used, revoked or expired.
- Used up in the same transaction that creates the account: one code, one
  account, even when two people try it at once.
- Guessing is capped at 20 tries an hour per address (IPv6 by /64), counted
  before the code is looked at, so tries sent at once all count; a right
  code is given back. Past 1,000 wrong codes an hour in all, addresses that
  already got one wrong wait, while others can still use a real code, so a
  flood can't lock invitees out. Every wrong code gets the same answer.
- Kept out of logs: never in a URL path the server sees, and never in the
  audit log, which records `INVITE_CREATE`, `INVITE_REVOKE`, `INVITE_NOTE` and
  `INVITE_ONLY_CHANGED` with ids only.

The admins listed in `ADMIN_PUBKEYS` never need a code when they sign in with
that Nostr key, and neither does App Review's address (`REVIEW_LOGIN_EMAIL`).
Codes of someone no longer an admin stop working at once and show as revoked.

On the device, a checked code is kept for the session only (`sessionStorage`),
and forgotten at sign-in and sign-out. Opening a link while signed in keeps
nothing.

## Code

- Server: `server/src/services/invite.service.ts` (codes, limits, the
  transaction), `controllers/invite.controller.ts`, and the two places that
  make accounts in `controllers/auth.controller.ts`.
- App: `src/pages/Invite.jsx`, `src/pages/admin/AdminInvites.jsx`,
  `src/utils/inviteCode.js`, `src/components/EmailSignIn.jsx` (the
  no-second-code step), `src/services/api.js` (the code goes with sign-up).
- Store links on the web invite page: `VITE_APP_STORE_URL` and
  `VITE_PLAY_STORE_URL` at build time. Until they're set, the page says to
  search the stores.
- Tests: `server/src/__tests__/inviteSignup.api.test.ts`, `tests/unit/inviteCode.test.js`.
