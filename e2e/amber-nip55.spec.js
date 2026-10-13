import { test, expect } from '@playwright/test';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';

/**
 * NIP-55 Amber intent flow — with stubbed navigation. Playwright can't
 * follow Android `nostrsigner:` intents, so `window.__TEST_NIP55_NAVIGATE`
 * captures the URIs the app would open and the test plays Amber's role:
 * it parses each request, signs with a Node-side key, and drives the
 * `/amber-callback` route exactly the way Amber's redirect would.
 */

const ANDROID_UA =
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

test.use({ userAgent: ANDROID_UA });

/** Stub nostrsigner: navigation, collecting URIs on window.__nip55Uris.
 *  Also disarms the not-installed watchdog — with stubbed navigation the
 *  page never loses visibility, which would falsely trip it. */
async function stubNip55Navigation(page) {
    await page.addInitScript(() => {
        window.__nip55Uris = [];
        window.__TEST_NIP55_NAVIGATE = (uri) => { window.__nip55Uris.push(uri); };
        window.__TEST_NIP55_DISABLE_WATCHDOG = true;
    });
}

async function waitForNip55Uri(page, index) {
    await expect
        .poll(() => page.evaluate(() => window.__nip55Uris?.length ?? 0), { timeout: 15_000 })
        .toBeGreaterThan(index);
    return page.evaluate((i) => window.__nip55Uris[i], index);
}

/** Parse a nostrsigner: URI into { payload, params }. */
function parseNip55Uri(uri) {
    expect(uri).toMatch(/^nostrsigner:/);
    const rest = uri.slice('nostrsigner:'.length);
    const qIdx = rest.indexOf('?');
    const payload = qIdx > 0 ? decodeURIComponent(rest.slice(0, qIdx)) : null;
    const params = new URLSearchParams(rest.slice(qIdx + 1));
    return { payload, params };
}

test.describe('NIP-55 Amber login', () => {
    test('full 2-round-trip login via /amber-callback', async ({ page }) => {
        test.setTimeout(120_000);
        await stubNip55Navigation(page);

        // Amber's identity, played by the test
        const amberSk = generateSecretKey();
        const amberPubkey = getPublicKey(amberSk);
        const npub = nip19.npubEncode(amberPubkey);

        await page.goto('/login');

        // Android UA + flag → the Amber button is shown
        const amberBtn = page.locator('button:has-text("Sign in with Amber (app)")');
        await expect(amberBtn).toBeVisible();
        await amberBtn.click();

        // ── Round trip 1: get_public_key ──
        const uri1 = await waitForNip55Uri(page, 0);
        const { params: p1 } = parseNip55Uri(uri1);
        expect(p1.get('type')).toBe('get_public_key');
        expect(p1.get('compressionType')).toBe('none');
        const callback1 = p1.get('callbackUrl');
        expect(callback1).toContain('/amber-callback?op=');
        expect(callback1).toMatch(/&result=$/);
        // Permissions pre-authorize the kinds BIES signs (login + relay auth included)
        const perms = JSON.parse(decodeURIComponent(p1.get('permissions')));
        expect(perms).toContainEqual({ type: 'sign_event', kind: 27235 });
        expect(perms).toContainEqual({ type: 'sign_event', kind: 22242 });
        expect(perms).toContainEqual({ type: 'nip44_encrypt' });

        // Amber redirects back with the npub appended
        await page.goto(`${callback1}${npub}`);

        // ── Round trip 2: sign_event(27235 challenge) ──
        // The callback page fetches the challenge and issues the second URI
        const uri2 = await waitForNip55Uri(page, 0); // fresh page → fresh array
        const { payload: eventPayload, params: p2 } = parseNip55Uri(uri2);
        expect(p2.get('type')).toBe('sign_event');
        expect(p2.get('returnType')).toBe('event');
        const callback2 = p2.get('callbackUrl');
        expect(callback2).toContain('/amber-callback?op=');

        const template = JSON.parse(eventPayload);
        expect(template.kind).toBe(27235);
        expect(template.pubkey).toBe(amberPubkey);
        expect(template.content).toMatch(/^[0-9a-f]{64}$/); // backend challenge

        // The manual fallback button is rendered (gesture-less nav may be blocked)
        await expect(page.locator('button:has-text("Continue in Amber")')).toBeVisible();

        // Amber signs and redirects back with the full event JSON
        const signed = finalizeEvent({
            kind: template.kind,
            created_at: template.created_at,
            tags: template.tags,
            content: template.content,
        }, amberSk);
        await page.goto(`${callback2}${encodeURIComponent(JSON.stringify(signed))}`);

        // ── JWT established, amber mode active ──
        await page.waitForURL(/\/(home|feed|dashboard)/, { timeout: 30_000 });
        const stored = await page.evaluate(() => ({
            token: localStorage.getItem('bies_token'),
            method: localStorage.getItem('bies_login_method'),
            amberPubkey: localStorage.getItem('bies_amber_pubkey'),
            loginState: localStorage.getItem('bies_amber_login'),
        }));
        expect(stored.token).toBeTruthy();
        expect(stored.method).toBe('amber');
        expect(stored.amberPubkey).toBe(amberPubkey);
        expect(stored.loginState).toBeNull(); // cleared after finish
    });

    test('Amber not installed → watchdog error + steer to QR view', async ({ page }) => {
        // Navigation stub that does nothing = page never loses visibility
        await page.addInitScript(() => {
            window.__TEST_NIP55_NAVIGATE = () => {};
        });

        await page.goto('/login');
        await page.click('button:has-text("Sign in with Amber (app)")');

        // 3s visibility watchdog fires with the friendly hint
        await expect(page.locator('text=Amber app not found')).toBeVisible({ timeout: 10_000 });
        // …and the UI steered to the remote-signer QR view
        await expect(page.locator('.mode-tab.active:has-text("Scan / Amber")')).toBeVisible();
    });

    test('stale/unknown op on callback shows expired screen', async ({ page }) => {
        await page.goto('/amber-callback?op=00000000-dead-beef-0000-000000000000&result=xyz');
        await expect(page.locator('text=This signing request expired')).toBeVisible({ timeout: 10_000 });
        await expect(page.locator('text=Back to login')).toBeVisible();
    });

    test('generic op: callback in a second tab resolves the initiating tab via storage event', async ({ page, context }) => {
        test.setTimeout(60_000);
        await stubNip55Navigation(page);

        // Seed an amber session (no backend needed for this mechanics test)
        const amberSk = generateSecretKey();
        const amberPubkey = getPublicKey(amberSk);
        await page.goto('/login');
        await page.evaluate((pk) => {
            localStorage.setItem('bies_login_method', 'amber');
            localStorage.setItem('bies_amber_pubkey', pk);
        }, amberPubkey);

        // Dispatch a generic signing op from tab 1 via the signer abstraction
        const resultPromise = page.evaluate(async () => {
            const { nostrSigner } = await import('/src/services/nostrSigner.js');
            const signed = await nostrSigner.signEvent({
                kind: 1,
                created_at: Math.floor(Date.now() / 1000),
                tags: [],
                content: 'hello from nip55 e2e',
            });
            return signed;
        });

        const uri = await waitForNip55Uri(page, 0);
        const { payload, params } = parseNip55Uri(uri);
        expect(params.get('type')).toBe('sign_event');
        const callbackUrl = params.get('callbackUrl');
        const template = JSON.parse(payload);

        const signed = finalizeEvent({
            kind: template.kind,
            created_at: template.created_at,
            tags: template.tags,
            content: template.content,
        }, amberSk);

        // Amber opens the callback in a NEW tab (original stays alive)
        const page2 = await context.newPage();
        await page2.goto(`${callbackUrl}${encodeURIComponent(JSON.stringify(signed))}`);

        // The new tab tells the user to go back…
        await expect(page2.locator('text=You can return to your previous tab')).toBeVisible({ timeout: 10_000 });

        // …while tab 1's promise resolves through the storage event
        const signedFromTab1 = await resultPromise;
        expect(signedFromTab1.sig).toBe(signed.sig);
        expect(signedFromTab1.content).toBe('hello from nip55 e2e');

        await page2.close();
    });
});
