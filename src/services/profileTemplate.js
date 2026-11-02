/**
 * What the app agrees to sign when BIES hands it a public Nostr profile to
 * publish (Settings → Nostr, services/publicNostrProfile.js): a profile
 * (kind 0) with no tags and a JSON object as its text, nothing else. Pure.
 */

/** Whether BIES's template is a plain profile, fit to sign. */
export function isProfileTemplate(template) {
    if (!template || typeof template !== 'object') return false;
    if (template.kind !== 0 || !Array.isArray(template.tags) || template.tags.length !== 0) return false;
    if (typeof template.content !== 'string' || !Number.isInteger(template.created_at)) return false;
    try {
        const content = JSON.parse(template.content);
        return !!content && typeof content === 'object' && !Array.isArray(content);
    } catch {
        return false;
    }
}

/** The template as the event to sign: only its own fields, so nothing else rides along. */
export function profileToSign(template) {
    return { kind: 0, created_at: template.created_at, tags: [], content: template.content };
}
