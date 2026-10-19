/**
 * mockBunker — minimal NIP-46 remote signer for E2E tests.
 *
 * Plays the role of Amber/nsecBunker: listens for kind-24133 requests on a
 * relay, approves them (except kinds passed to denyKinds), and signs with an in-memory test key. Wire
 * format verified against nostr-tools/nip46 (nostr-tools 2.23.3):
 *   request:  kind 24133, author=clientPubkey, p-tag=bunkerPubkey,
 *             content = nip44(JSON{id, method, params}, conv(client, bunker))
 *   response: kind 24133, author=bunkerPubkey, p-tag=clientPubkey,
 *             content = nip44(JSON{id, result, error}, conv(bunker, client))
 *   nostrconnect approval: response with result = <secret from the URI>.
 */

import WebSocket from 'ws';
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools';
import * as nip44 from 'nostr-tools/nip44';

const NOSTR_CONNECT_KIND = 24133;

/**
 * Start a mock bunker connected to `relayUrl`.
 * The bunker key doubles as the user identity (like Amber's default).
 * Returns { pubkey, bunkerUri(secret), approveNostrConnect(uri), requests, close() }.
 */
export async function startMockBunker(relayUrl) {
    const bunkerSk = generateSecretKey();
    const bunkerPubkey = getPublicKey(bunkerSk);
    const requests = []; // { method, params, clientPubkey } — assertion log
    // Kinds sign_event refuses (like Bunker46's default permission seed,
    // which omits the 27235 login kind). Mutable via denyKinds().
    let deniedKinds = new Set();
    let ws;

    const send = (payload) => ws.send(JSON.stringify(payload));

    const respond = (clientPubkey, payload) => {
        const conv = nip44.v2.utils.getConversationKey(bunkerSk, clientPubkey);
        const event = finalizeEvent({
            kind: NOSTR_CONNECT_KIND,
            created_at: Math.floor(Date.now() / 1000),
            tags: [['p', clientPubkey]],
            content: nip44.v2.encrypt(JSON.stringify(payload), conv),
        }, bunkerSk);
        send(['EVENT', event]);
    };

    const handleRequest = (event) => {
        if (!verifyEvent(event)) return;
        const clientPubkey = event.pubkey;
        const conv = nip44.v2.utils.getConversationKey(bunkerSk, clientPubkey);
        let req;
        try { req = JSON.parse(nip44.v2.decrypt(event.content, conv)); } catch { return; }
        const { id, method, params = [] } = req;
        requests.push({ method, params, clientPubkey });

        switch (method) {
            case 'connect':
                respond(clientPubkey, { id, result: 'ack' });
                break;
            case 'ping':
                respond(clientPubkey, { id, result: 'pong' });
                break;
            case 'get_public_key':
                respond(clientPubkey, { id, result: bunkerPubkey });
                break;
            case 'sign_event': {
                try {
                    const template = JSON.parse(params[0]);
                    if (deniedKinds.has(template.kind)) {
                        respond(clientPubkey, { id, error: `Permission denied for sign_event kind:${template.kind}` });
                        break;
                    }
                    const signed = finalizeEvent({
                        kind: template.kind,
                        created_at: template.created_at ?? Math.floor(Date.now() / 1000),
                        tags: template.tags ?? [],
                        content: template.content ?? '',
                    }, bunkerSk);
                    respond(clientPubkey, { id, result: JSON.stringify(signed) });
                } catch (err) {
                    respond(clientPubkey, { id, error: `sign_event failed: ${err.message}` });
                }
                break;
            }
            case 'nip44_encrypt': {
                const [thirdParty, plaintext] = params;
                const ck = nip44.v2.utils.getConversationKey(bunkerSk, thirdParty);
                respond(clientPubkey, { id, result: nip44.v2.encrypt(plaintext, ck) });
                break;
            }
            case 'nip44_decrypt': {
                const [thirdParty, ciphertext] = params;
                const ck = nip44.v2.utils.getConversationKey(bunkerSk, thirdParty);
                respond(clientPubkey, { id, result: nip44.v2.decrypt(ciphertext, ck) });
                break;
            }
            default:
                respond(clientPubkey, { id, error: `unsupported method: ${method}` });
        }
    };

    await new Promise((resolve, reject) => {
        ws = new WebSocket(relayUrl);
        ws.on('open', () => {
            // Subscribe to requests addressed to the bunker
            send(['REQ', 'bunker-inbox', { kinds: [NOSTR_CONNECT_KIND], '#p': [bunkerPubkey] }]);
            resolve();
        });
        ws.on('error', reject);
        ws.on('message', (data) => {
            let msg;
            try { msg = JSON.parse(data.toString()); } catch { return; }
            if (msg[0] === 'EVENT' && msg[1] === 'bunker-inbox') {
                handleRequest(msg[2]);
            }
        });
    });

    return {
        pubkey: bunkerPubkey,
        requests,

        /** Refuse sign_event for these kinds (empty list = allow all). */
        denyKinds(kinds = []) {
            deniedKinds = new Set(kinds);
        },

        /** bunker:// URI for the paste-login flow. */
        bunkerUri(secret = 'e2e-secret') {
            return `bunker://${bunkerPubkey}?relay=${encodeURIComponent(relayUrl)}&secret=${secret}`;
        },

        /**
         * Approve a client-initiated nostrconnect:// URI: send the secret
         * back to the client pubkey (what Amber does after the user taps
         * "approve"). Subsequent requests are served automatically.
         */
        approveNostrConnect(uri) {
            const parsed = new URL(uri);
            const clientPubkey = parsed.hostname || parsed.pathname.replace(/^\/*/, '');
            const secret = parsed.searchParams.get('secret');
            respond(clientPubkey, { id: `connect-${Date.now()}`, result: secret });
        },

        close: () => new Promise((resolve) => {
            ws.once('close', resolve);
            ws.close();
        }),
    };
}
