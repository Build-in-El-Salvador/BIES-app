import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'crypto';
import fs from 'fs';
import { verifyEvent } from 'nostr-tools/pure';

// ─── Configuration ───────────────────────────────────────────────────────────
const LISTEN_PORT    = parseInt(process.env.PROXY_PORT || '7778', 10);
const UPSTREAM_URL   = process.env.UPSTREAM_RELAY || 'ws://bies-relay:7777';
const WHITELIST_PATH = process.env.WHITELIST_PATH || '/app/data/whitelist.txt';
const RELAY_URL      = process.env.RELAY_URL || 'wss://relay.buildinelsalvador.com';
const AUTH_TIMEOUT   = parseInt(process.env.AUTH_TIMEOUT_MS || '30000', 10);
// The largest message a client may send (an event or a REQ), and how many it
// may send before signing in; past either, the connection closes.
const MAX_PAYLOAD    = 512 * 1024;
const MAX_PENDING    = 50;
// How often open connections are checked against the whitelist, so a
// member who is suspended or deletes their account stops reading.
const RECHECK_MS     = parseInt(process.env.RECHECK_MS || '60000', 10);

// ─── Whitelist check ─────────────────────────────────────────────────────────
function isWhitelisted(pubkey) {
    try {
        if (!fs.existsSync(WHITELIST_PATH)) return false;
        const content = fs.readFileSync(WHITELIST_PATH, 'utf8');
        return content.split('\n').map(l => l.trim()).filter(Boolean).includes(pubkey);
    } catch (err) {
        console.error('[Proxy] Whitelist read error:', err.message);
        return false;
    }
}

// ─── Derive the relay URL from the incoming HTTP upgrade request ─────────────
// Supports both production (TLS nginx sets X-Forwarded-Proto: https) and local
// access (no X-Forwarded-Proto → fall back to ws://).
function resolveRelayUrl(req) {
    const host = req.headers['host'] || new URL(RELAY_URL).host;
    const proto = req.headers['x-forwarded-proto'];
    let scheme;
    if (proto) {
        scheme = proto.trim().split(',')[0].trim() === 'https' ? 'wss' : 'ws';
    } else {
        // No forwarded proto: use wss only when the host matches the canonical URL
        const canonicalHost = new URL(RELAY_URL).host;
        scheme = host === canonicalHost ? new URL(RELAY_URL).protocol.replace(':', '') : 'ws';
    }
    return `${scheme}://${host}/relay`;
}

// ─── NIP-42 AUTH verification ────────────────────────────────────────────────
function verifyAuthEvent(event, challenge, expectedRelayUrl) {
    // A well-formed event first.
    if (!event || typeof event !== 'object' || Array.isArray(event)) return 'invalid event';
    if (typeof event.pubkey !== 'string' || !Array.isArray(event.tags)
        || !event.tags.every((t) => Array.isArray(t) && t.every((v) => typeof v === 'string'))) {
        return 'invalid event';
    }

    // Must be kind 22242
    if (event.kind !== 22242) return 'invalid event kind';

    // Verify signature
    let valid = false;
    try { valid = verifyEvent(event); } catch { valid = false; }
    if (!valid) return 'invalid signature';

    // Check challenge tag
    const challengeTag = event.tags.find(t => t[0] === 'challenge');
    if (!challengeTag || challengeTag[1] !== challenge) return 'challenge mismatch';

    // Check relay tag — normalise trailing slashes before comparing
    const relayTag = event.tags.find(t => t[0] === 'relay');
    const normalise = (u) => u.replace(/\/+$/, '');
    if (!relayTag || normalise(relayTag[1]) !== normalise(expectedRelayUrl)) return 'relay URL mismatch';

    // Check created_at is within 10 minutes
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - event.created_at) > 600) return 'timestamp too far off';

    // Check pubkey is whitelisted
    if (!isWhitelisted(event.pubkey)) return 'pubkey not whitelisted';

    return null; // success
}

// ─── NIP-01 REQ normalisation ────────────────────────────────────────────────
// nostr-tools v2 sometimes sends filters wrapped in an extra array:
//   ["REQ","sub:1",[{"kinds":[1,6],"limit":50}]]
// NIP-01 requires each filter as a separate element:
//   ["REQ","sub:1",{"kinds":[1,6],"limit":50}]
// Normalise before forwarding so strfry accepts the request.
function normalizeMessage(text) {
    let msg;
    try { msg = JSON.parse(text); } catch { return text; }
    if (!Array.isArray(msg) || msg[0] !== 'REQ' || msg.length < 3) return text;

    let changed = false;
    const normalized = [msg[0], msg[1]];
    for (let i = 2; i < msg.length; i++) {
        if (Array.isArray(msg[i])) {
            // Spread the nested filter array
            normalized.push(...msg[i]);
            changed = true;
        } else {
            normalized.push(msg[i]);
        }
    }
    return changed ? JSON.stringify(normalized) : text;
}

// ─── WebSocket proxy server ──────────────────────────────────────────────────
const wss = new WebSocketServer({ port: LISTEN_PORT, maxPayload: MAX_PAYLOAD });

// Signed-in connections and their pubkeys, for the whitelist recheck.
const authedSockets = new Map();
setInterval(() => {
    for (const [clientWs, pubkey] of authedSockets) {
        if (!isWhitelisted(pubkey)) {
            console.log(`[Proxy] No longer whitelisted, closing: ${pubkey.substring(0, 8)}...`);
            clientWs.close(4003, 'no longer a member');
        }
    }
}, RECHECK_MS).unref();

console.log(`[Proxy] NIP-42 auth proxy listening on :${LISTEN_PORT}`);
console.log(`[Proxy] Upstream relay: ${UPSTREAM_URL}`);
console.log(`[Proxy] Relay URL for auth: ${RELAY_URL}`);

wss.on('connection', (clientWs, req) => {
    // Derive the relay URL this connection is arriving on (handles prod TLS + local access)
    const connectionRelayUrl = resolveRelayUrl(req);

    let authenticated = false;
    let upstream = null;
    let authTimer = null;
    const pendingMessages = [];      // Buffer client messages before auth completes
    const pendingUpstream = [];      // Buffer upstream messages before auth completes

    // Generate random challenge
    const challenge = crypto.randomBytes(32).toString('hex');

    // Open upstream connection to strfry
    upstream = new WebSocket(UPSTREAM_URL);

    upstream.on('error', (err) => {
        console.error('[Proxy] Upstream error:', err.message);
        clientWs.close(1011, 'upstream error');
    });

    upstream.on('close', () => {
        clientWs.close();
    });

    upstream.on('open', () => {
        // Send NIP-42 AUTH challenge to client
        clientWs.send(JSON.stringify(['AUTH', challenge]));
    });

    upstream.on('message', (data, isBinary) => {
        // Convert Buffers to strings so the browser receives text frames
        // (nostr-tools expects JSON text, not binary).
        const payload = isBinary ? data : data.toString();
        if (authenticated && clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(payload);
        } else if (!authenticated && pendingUpstream.length < MAX_PENDING) {
            // Buffer upstream responses so they aren't lost during auth
            pendingUpstream.push(payload);
        }
    });

    // Set auth timeout
    authTimer = setTimeout(() => {
        if (!authenticated) {
            clientWs.send(JSON.stringify([
                'NOTICE',
                'auth-required: authentication timeout',
            ]));
            clientWs.close(4001, 'auth timeout');
            if (upstream && upstream.readyState === WebSocket.OPEN) {
                upstream.close();
            }
        }
    }, AUTH_TIMEOUT);

    // Flush buffered messages after successful auth
    function flushPending() {
        // Send buffered client messages to upstream
        while (pendingMessages.length > 0) {
            const buffered = pendingMessages.shift();
            if (upstream && upstream.readyState === WebSocket.OPEN) {
                const str = typeof buffered !== 'string' ? buffered.toString() : buffered;
                upstream.send(normalizeMessage(str));
            }
        }
        // Send buffered upstream responses to client
        while (pendingUpstream.length > 0) {
            const buffered = pendingUpstream.shift();
            if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(buffered);
            }
        }
    }

    clientWs.on('message', (data) => {
        // An error in one connection closes that connection only.
        try {
            handleMessage(data);
        } catch (err) {
            console.error('[Proxy] Message error:', err.message);
            clientWs.close(1011, 'error');
        }
    });

    function handleMessage(data) {
        // Ensure we work with a string (ws delivers Buffers by default)
        const text = typeof data !== 'string' ? data.toString() : data;

        let msg;
        try {
            msg = JSON.parse(text);
        } catch {
            return; // ignore malformed messages
        }

        if (!Array.isArray(msg) || msg.length < 2) return;

        // Handle AUTH response
        if (msg[0] === 'AUTH' && !authenticated) {
            const event = msg[1];
            const error = verifyAuthEvent(event, challenge, connectionRelayUrl);

            if (error) {
                const who = typeof event?.pubkey === 'string' ? event.pubkey.substring(0, 8) : '?';
                console.log(`[Proxy] Auth failed: ${error} (pubkey: ${who}...)`);
                clientWs.send(JSON.stringify([
                    'OK', typeof event?.id === 'string' ? event.id : '', false, `auth-required: ${error}`,
                ]));
                clientWs.close(4001, 'auth failed');
                if (upstream && upstream.readyState === WebSocket.OPEN) {
                    upstream.close();
                }
                return;
            }

            // Auth success
            authenticated = true;
            authedSockets.set(clientWs, event.pubkey);
            clearTimeout(authTimer);
            console.log(`[Proxy] Authenticated: ${event.pubkey.substring(0, 8)}...`);
            clientWs.send(JSON.stringify(['OK', event.id, true, '']));

            // Forward any messages that arrived during the auth handshake
            flushPending();
            return;
        }

        // Before auth, buffer messages instead of dropping them (a few)
        if (!authenticated) {
            if (pendingMessages.length >= MAX_PENDING) {
                clientWs.close(4001, 'auth-required');
                return;
            }
            pendingMessages.push(text);
            return;
        }

        // After auth: transparent forwarding to upstream
        if (upstream && upstream.readyState === WebSocket.OPEN) {
            upstream.send(normalizeMessage(text));
        }
    }

    clientWs.on('close', () => {
        authedSockets.delete(clientWs);
        clearTimeout(authTimer);
        if (upstream && upstream.readyState === WebSocket.OPEN) {
            upstream.close();
        }
    });

    clientWs.on('error', (err) => {
        console.error('[Proxy] Client error:', err.message);
        clearTimeout(authTimer);
        if (upstream && upstream.readyState === WebSocket.OPEN) {
            upstream.close();
        }
    });
});
