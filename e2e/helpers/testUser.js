/**
 * Create a test account the way Nostr users sign in: a fresh key answers the
 * server's challenge. (Email sign-in needs a code from an inbox, so tests
 * don't use it.) Optionally sets the profile name.
 *
 * Returns { token, user, skHex } — skHex is the account's own key, for specs
 * that inject it as the in-browser signer.
 */
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';

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

    if (name) {
        const update = await request.put(`${api}/profiles/me`, {
            headers: { Authorization: `Bearer ${token}` },
            data: { name },
        });
        if (!update.ok()) throw new Error(`Setting the test user's name failed: ${update.status()}`);
        user = { ...user, profile: await update.json() };
    }

    return { token, user, skHex: Buffer.from(sk).toString('hex') };
}
