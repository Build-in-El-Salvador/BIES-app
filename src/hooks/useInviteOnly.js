import { useEffect, useState } from 'react';
import { inviteApi } from '../services/api';

/**
 * Whether new accounts need an invite code (Admin Panel → Invites): true,
 * false, or null while it's being asked. Asked again after 30 seconds.
 *
 * If the server can't be reached the answer is false, so the app shows the
 * usual sign-in screen. That decides only what the app shows: the server
 * refuses a new account without a code either way.
 */
const TTL_MS = 30_000;
let known = null; // { value, at }
let asking = null;

export function loadInviteOnly() {
    if (known && Date.now() - known.at < TTL_MS) return Promise.resolve(known.value);
    asking ??= inviteApi.status()
        .then((res) => {
            known = { value: res?.inviteOnly === true, at: Date.now() };
            return known.value;
        })
        .catch(() => known?.value ?? false)
        .finally(() => { asking = null; });
    return asking;
}

export function useInviteOnly() {
    const [inviteOnly, setInviteOnly] = useState(() => known?.value ?? null);
    useEffect(() => {
        let live = true;
        loadInviteOnly().then((value) => { if (live) setInviteOnly(value); });
        return () => { live = false; };
    }, []);
    return inviteOnly;
}

/** After an admin flips the switch: ask again next time. */
export function forgetInviteOnly() {
    known = null;
}
