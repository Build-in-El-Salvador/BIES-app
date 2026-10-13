import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { nip19 } from 'nostr-tools';

/**
 * keytr 0.8.0 passkey E2E — PRF registration + discoverable login using
 * Chrome's CDP virtual authenticator (hasPrf). Runs against the localhost
 * rpId override in keytrService (production uses the gateway rpIds, which
 * a localhost origin can't register against).
 *
 * Requires the dev strfry relay (docker-compose.dev.yml, port 7777) — the
 * vite proxy maps /relay onto it. The relay's write policy only accepts
 * whitelisted pubkeys, so tests append the generated identity to
 * relay/dev-whitelist/whitelist.txt before publishing the kind:31777 event.
 *
 * NOTE: publish/fetch of the kind:31777 event and the challenge login go
 * through NOSTR_RELAYS, which includes LIVE public relays — so this spec is
 * timing-sensitive under parallel load. Run it with `--workers=1` (or in
 * isolation) for a deterministic pass; it flakes only when many specs hammer
 * the relays and the shared dev server at once.
 */

test.describe.configure({ mode: 'serial' });

const WHITELIST_PATH = path.join(process.cwd(), 'relay', 'dev-whitelist', 'whitelist.txt');

/** Attach a CTAP2.1 virtual authenticator; hasPrf controls PRF support. */
async function addVirtualAuthenticator(page, { hasPrf = true } = {}) {
    const client = await page.context().newCDPSession(page);
    await client.send('WebAuthn.enable');
    const { authenticatorId } = await client.send('WebAuthn.addVirtualAuthenticator', {
        options: {
            protocol: 'ctap2',
            ctap2Version: 'ctap2_1',
            transport: 'internal',
            hasResidentKey: true,
            hasUserVerification: true,
            isUserVerified: true,
            hasPrf,
            automaticPresenceSimulation: true,
        },
    });
    return { client, authenticatorId };
}

/** Drive signup to the key-backup step and return the hex pubkey. */
async function signupToBackupStep(page, context) {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/signup');
    await expect(page.locator('text=Create Your Identity')).toBeVisible();
    await page.click('text=Generate My Keys');
    await expect(page.locator('text=Save Your Secret Key!')).toBeVisible({ timeout: 5000 });

    // Grab the npub via the copy button (keys live only in React state)
    await page.locator('button:has-text("Copy")').first().click();
    const npub = await page.evaluate(() => navigator.clipboard.readText());
    expect(npub).toMatch(/^npub1/);
    const { data: pubkey } = nip19.decode(npub);
    return pubkey;
}

function whitelistPubkey(pubkey) {
    // The strfry write policy greps this file live — no restart needed.
    fs.appendFileSync(WHITELIST_PATH, `${pubkey}\n`);
}

test.describe('keytr PRF passkey', () => {
    test('signup → save passkey → fresh session → passkey login round-trip', async ({ page, context }) => {
        test.setTimeout(120_000);
        await addVirtualAuthenticator(page, { hasPrf: true });

        const pubkey = await signupToBackupStep(page, context);
        whitelistPubkey(pubkey);

        // Register the PRF passkey (publishes the kind:31777 v=1 event)
        const saveBtn = page.locator('button:has-text("Save to Passkey")');
        await expect(saveBtn).toBeVisible();
        await saveBtn.click();
        await expect(page.locator('text=Passkey Saved')).toBeVisible({ timeout: 30_000 });

        // Finish signup (logs in with the generated nsec)
        await page.click('button:has-text("Continue")');
        await expect(page.locator('text=Complete Profile')).toBeVisible({ timeout: 5000 });
        await page.fill('input[placeholder="e.g. Satoshi Nakamoto"]', 'Keytr E2E User');
        await page.click('button[type="submit"]');
        await page.waitForURL('**/dashboard', { timeout: 30_000 });

        // Simulate a fresh session: drop auth + in-memory key, KEEP the
        // keytr credential index (tier-1 login) and the virtual authenticator
        // (same page = same CDP session).
        await page.evaluate(() => {
            localStorage.removeItem('bies_token');
            localStorage.removeItem('bies_user');
            localStorage.removeItem('bies_login_method');
            sessionStorage.removeItem('bies_sk_session');
        });

        await page.goto('/login');
        await page.click('text=Login with Passkey (NIP-K1)');

        // Tier-1 login: fetch events by indexed pubkey → PRF assertion → JWT
        await page.waitForURL(/\/(home|feed|dashboard)/, { timeout: 30_000 });

        // v=1 (PRF) credential — the KiH migration prompt must NOT appear
        await expect(page.locator('text=Upgrade your passkey security')).not.toBeVisible();

        // Sanity: we are authenticated
        const token = await page.evaluate(() => localStorage.getItem('bies_token'));
        expect(token).toBeTruthy();
    });

    test('registration without PRF support fails with friendly message (or is gated off)', async ({ page, context }) => {
        test.setTimeout(60_000);
        await addVirtualAuthenticator(page, { hasPrf: false });

        await signupToBackupStep(page, context);
        // No whitelist needed — publish should never be reached.

        const saveBtn = page.locator('button:has-text("Save to Passkey")');
        // Two correct outcomes:
        //  - getClientCapabilities reported no PRF → button gated off, or
        //  - capabilities were optimistic → registration throws
        //    PrfNotSupportedError → friendly i18n error.
        if (await saveBtn.isVisible()) {
            await saveBtn.click();
            await expect(
                page.locator("text=doesn't support the security feature (PRF)")
            ).toBeVisible({ timeout: 30_000 });
            // No credential index entry may be left behind
            const creds = await page.evaluate(() => localStorage.getItem('bies_keytr_credentials'));
            expect(creds || '[]').not.toContain('pubkey');
        } else {
            await expect(saveBtn).not.toBeVisible();
        }
    });
});
