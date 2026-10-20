/**
 * signerError — turn a NIP-46 remote-signer failure into an Error the login
 * UI can explain.
 *
 * nostr-tools rejects a signer's error response with the bare string payload
 * (`handler.reject(error)`), not an Error, so `error.message` is undefined and
 * every refusal used to surface as the generic "Login failed". Known signer
 * replies get a `code` (and `kind` for permission denials) that maps to a
 * translated message; anything else keeps the signer's own text.
 *
 * Pure module (no browser globals) so it runs under `node --test`.
 */

// Signer text is attacker-controlled (any bunker can reply anything); it is
// only ever rendered as React text, but cap it so it can't flood the page.
export const MAX_SIGNER_MESSAGE = 200;

export const SIGNER_ERROR = Object.freeze({
    PERMISSION_DENIED: 'signer_permission_denied',
    LINK_USED: 'signer_link_used',
    REVOKED: 'signer_revoked',
    NO_RESPONSE: 'signer_no_response',
});

/** Normalise any rejection from a BunkerSigner call into an Error. */
export function toSignerError(err) {
    if (err instanceof Error) return err;

    const raw = typeof err === 'string' ? err : String(err?.message ?? err ?? '');
    const message = raw.trim().slice(0, MAX_SIGNER_MESSAGE) || 'The remote signer returned an error.';
    const error = new Error(message);
    error.signerMessage = message;

    // Bunker46: "Permission denied for sign_event kind:27235"
    const denied = /permission denied for sign_event kind:\s*(\d+)/i.exec(message);
    if (denied) {
        error.code = SIGNER_ERROR.PERMISSION_DENIED;
        error.kind = Number(denied[1]);
    } else if (/permission denied|not authori[sz]ed|rejected by user|user rejected/i.test(message)) {
        error.code = SIGNER_ERROR.PERMISSION_DENIED;
    } else if (/unknown client|no matching pending secret|invalid secret|secret.*(used|expired)/i.test(message)) {
        // bunker:// secrets are single-use: the link was already consumed,
        // expired, or the signer restarted and forgot it.
        error.code = SIGNER_ERROR.LINK_USED;
    } else if (/revoked/i.test(message)) {
        error.code = SIGNER_ERROR.REVOKED;
    }
    return error;
}

/** The paired session is dead on the signer side — re-pairing is required. */
export function isDeadSessionError(err) {
    return err?.code === SIGNER_ERROR.LINK_USED || err?.code === SIGNER_ERROR.REVOKED;
}

/**
 * i18n key + interpolation params for a normalised signer error, or null
 * when the error has no known code (show its message as-is).
 */
export function signerErrorKey(err) {
    switch (err?.code) {
        case SIGNER_ERROR.PERMISSION_DENIED:
            return err.kind != null
                ? { key: 'login.signerPermissionDeniedKind', params: { kind: err.kind } }
                : { key: 'login.signerPermissionDenied', params: {} };
        case SIGNER_ERROR.LINK_USED:
            return { key: 'login.signerLinkUsed', params: {} };
        case SIGNER_ERROR.REVOKED:
            return { key: 'login.signerRevoked', params: {} };
        case SIGNER_ERROR.NO_RESPONSE:
            return { key: 'login.signerNoResponse', params: {} };
        default:
            return null;
    }
}
