// What the store app (iOS and Android) offers. Runtime flags can switch a
// feature off anywhere, but in the app they can't switch on anything outside
// this list: features ship to the app with an app update, which goes through
// App Review. The website keeps every feature its flags allow.
//
// v1.0 (Oct 2026): the Feed (the BIES private relay only), Members, the Farm
// Directory and BIES Trusted, BIES Talents, Opportunities, Profile, Settings,
// notifications, and Report / Feedback for testers and members (Mike,
// 2026-10-22). Features without a slug (Feed, Members, Profile, Settings)
// are always on.
import { FEATURE_SLUGS } from './featureSlugs.js';

export const APP_FEATURES = ['directories', 'talent', 'projects', 'feedback'];

// Opportunities the app leaves out (the website shows them; the app never asks
// for them, links to one show "not found", and it can't post one). None since
// 2026-10-19: the `investment` type became Projects, a member's project and
// who they'd like to meet, with no raise, terms or amounts. Investment offers
// would come back here (Apple 3.2.1(viii) and 5.1.1(ix) want those from a
// licensed company's developer account, and BIES's is a person's).
export const APP_HIDDEN_OPPORTUNITY_TYPES = [];

/**
 * The flags the app runs with: the runtime flags, with everything outside
 * APP_FEATURES off when running as the native app. Pure.
 * @param {Record<string, boolean>} flags - runtime flags (missing ⇒ on)
 * @param {boolean} native - running inside the iOS/Android app
 */
export function scopeFlags(flags, native) {
    if (!native) return flags;
    const scoped = { ...flags };
    for (const slug of FEATURE_SLUGS) {
        if (!APP_FEATURES.includes(slug)) scoped[slug] = false;
    }
    return scoped;
}
