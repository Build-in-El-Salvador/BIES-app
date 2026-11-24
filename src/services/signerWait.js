/**
 * signerWait — how long a login waits for a remote signer to sign.
 *
 * A signer that asks the person (Amber, or a bunker that holds the request
 * and sends an auth_url) answers sign_event when they tap approve, which can
 * take a while: the request must stay alive for that long, or an approval
 * that arrives a little late is thrown away and they have to start again.
 *
 *  - at SOFT the wait goes on, but the screen is told it is a slow one;
 *  - at HARD it gives up (`signer_no_response`) and a later answer is ignored.
 *
 * HARD must stay inside what the server accepts of the signed event: the
 * challenge lives 5 minutes (CHALLENGE_TTL_MS) and `created_at` may be 300 s
 * off the server's clock (auth.controller.ts), and the clock starts when the
 * request is sent. 240 s leaves about a minute for the relays, the POST and
 * a device clock that is a little slow.
 *
 * Pure module (no browser globals) so it runs under `node --test`.
 */

import { SIGNER_ERROR } from './signerError.js';

export const SIGNER_SIGN_SOFT_MS = 60_000;
export const SIGNER_SIGN_HARD_MS = 240_000;

function noResponse() {
    return Object.assign(new Error('The remote signer did not respond.'), { code: SIGNER_ERROR.NO_RESPONSE });
}

function aborted() {
    return Object.assign(new Error('Login cancelled.'), { name: 'AbortError' });
}

/**
 * The promise's answer, or a rejection: `signer_no_response` at `hardMs`, an
 * AbortError when `signal` aborts, or the promise's own rejection. `onSlow`
 * runs once at `softMs` if the wait is still going. The request itself is not
 * cancelled (nostr-tools has no way to), so an answer that arrives after a
 * rejection is simply dropped.
 */
export function awaitSignature(promise, { softMs = SIGNER_SIGN_SOFT_MS, hardMs = SIGNER_SIGN_HARD_MS, onSlow, signal } = {}) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let slowTimer = null;
        let hardTimer = null;

        const finish = (settle, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(slowTimer);
            clearTimeout(hardTimer);
            signal?.removeEventListener('abort', onAbort);
            settle(value);
        };
        function onAbort() { finish(reject, aborted()); }

        // Always watch the request, even if the login was cancelled already:
        // a rejection nobody handles would surface as an unhandled rejection.
        promise.then(
            (value) => finish(resolve, value),
            (error) => finish(reject, error),
        );

        if (signal?.aborted) { onAbort(); return; }
        signal?.addEventListener('abort', onAbort, { once: true });

        if (softMs < hardMs) {
            slowTimer = setTimeout(() => { if (!settled) onSlow?.(); }, softMs);
        }
        hardTimer = setTimeout(() => finish(reject, noResponse()), hardMs);
    });
}
