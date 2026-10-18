// Runtime feature-toggle slugs — client-side mirror of the canonical list in
// server/src/services/featureFlags.service.ts (keep both in sync; see
// docs/feature-toggles.md). Distinct from src/config/featureFlags.js, which
// holds BUILD-TIME dev flags — these are flipped by admins at runtime.
export const FEATURE_SLUGS = [
    'directories', // farm + certified provider directories
    'talent',      // BIES Talents: members' skills and services, with proof of work
    'points',      // leaderboard, profile points UI, gamification toasts
    'events',      // ecosystem events
    'media',       // media page
    'news',        // news page
    'messages',    // direct messages
    'zaps',        // zap buttons + wallet
    'feedback',    // bug/feedback tracker
    'investors',   // investor features + vetting
    'projects',    // Opportunities: investments, businesses for sale, jobs, partnerships, programs
    'cowork',      // Cowork check-in page
    'marketplace', // Shopstr-compatible NIP-99 marketplace
    'bounties',    // bounty board (sats/points escrow)
    'dashboard',   // personal dashboard (UI gate only)
    'courses',     // courses catalog and player (UI gate only)
];

// Fail-open default: every feature enabled. Used while the flags fetch is in
// flight and whenever it errors, so a flaky API can never hide the app.
export const DEFAULT_FLAGS = Object.freeze(
    Object.fromEntries(FEATURE_SLUGS.map((slug) => [slug, true]))
);
