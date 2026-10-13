/**
 * Create a test account the way Nostr users sign in: a fresh key answers the
 * server's challenge. (Email sign-in needs a code from an inbox, so tests
 * don't use it.) Accepts the current terms, and optionally sets the profile
 * name, with a photo: a finished profile, so the app's name-and-photo step
 * (ProfileGate) doesn't cover the page.
 *
 * Returns { token, user, skHex } — skHex is the account's own key, for specs
 * that inject it as the in-browser signer.
 */
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';

const TEST_PHOTO = 'data:image/svg+xml,' + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'><rect width='10' height='10' fill='#64748b'/></svg>");

export async function createTestUser(request, api, name) {
    const sk = generateSecretKey();
    const pubkey = getPublicKey(sk);

    const challengeRes = await request.get(`${api}/auth/nostr-challenge`, { params: { pubkey } });
    if (!challengeRes.ok()) throw new Error(`Test sign-in challenge failed: ${challengeRes.status()}`);
    const { challenge } = await challengeRes.json();

    const signedEvent = finalizeEvent({
        kind: 27235,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: challenge,
    }, sk);
    const res = await request.post(`${api}/auth/nostr-login`, { data: { pubkey, signedEvent } });
    if (!res.ok()) throw new Error(`Test sign-in failed: ${res.status()}`);
    let { token, user } = await res.json();

    // Accept the current terms first: the server refuses posts and profile
    // edits until they are (the app's terms gate).
    if (user.termsAccepted === false && user.termsVersion) {
        const terms = await request.post(`${api}/account/terms`, {
            headers: { Authorization: `Bearer ${token}` },
            data: { version: user.termsVersion },
        });
        if (!terms.ok()) throw new Error(`Accepting the terms failed: ${terms.status()}`);
        user = { ...user, termsAccepted: true };
    }

    if (name) {
        const update = await request.put(`${api}/profiles/me`, {
            headers: { Authorization: `Bearer ${token}` },
            data: { name, avatar: TEST_PHOTO },
        });
        if (!update.ok()) throw new Error(`Setting the test user's name failed: ${update.status()}`);
        user = { ...user, profile: await update.json() };
    }

    return { token, user, skHex: Buffer.from(sk).toString('hex') };
}
