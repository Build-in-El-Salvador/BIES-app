import { test, expect } from '@playwright/test';
import { startMockRelay } from './helpers/mockRelay.js';
import { startMockBunker } from './helpers/mockBunker.js';

/**
 * NIP-46 bunker:// paste login + session persistence.
 *
 * A mock relay (in-process, no whitelist) carries the kind-24133 traffic and
 * a mock bunker plays Amber/nsecBunker. The persistence test proves the
 * hardening work: the NIP-46 session now lives in localStorage, so a brand
 * new browser context restored from storageState can still reach the signer
 * (the AuthContext warm-up pings the bunker through reconnect()).
 */

let relay;
let bunker;

test.beforeAll(async () => {
    relay = startMockRelay(7799);
    bunker = await startMockBunker(relay.url);
});

test.afterAll(async () => {
    await bunker?.close();
    await relay?.close();
});

test.describe('NIP-46 bunker login', () => {
    test('paste bunker:// URI → login → session survives a fresh context', async ({ page, browser }) => {
        test.setTimeout(120_000);

        await page.goto('/login');
        await page.click('.mode-tab:has-text("Remote")');
        // Desktop defaults to the paste view; make sure it's active
        await page.click('.mode-tab:has-text("Paste bunker URI")');

        await page.fill('input[placeholder="bunker://... or name@domain.com"]', bunker.bunkerUri());
        await page.click('button:has-text("Login with Remote Signer")');

        // Backend challenge is signed by the mock bunker → JWT → app
        await page.waitForURL(/\/(home|feed|dashboard)/, { timeout: 60_000 });

        // The bunker served connect + get_public_key + sign_event(27235)
        const methods = bunker.requests.map(r => r.method);
        expect(methods).toContain('connect');
        expect(methods).toContain('get_public_key');
        expect(methods).toContain('sign_event');

        // Session persisted to localStorage (the hardening under test)
        const stored = await page.evaluate(() => ({
            clientSk: localStorage.getItem('bies_nip46_client_sk'),
            bunkerPointer: localStorage.getItem('bies_nip46_bunker'),
            method: localStorage.getItem('bies_login_method'),
        }));
        expect(stored.clientSk).toBeTruthy();
        expect(stored.bunkerPointer).toContain(bunker.pubkey);
        expect(stored.method).toBe('bunker');

        // ── Fresh context from storageState (simulates browser restart) ──
        const state = await page.context().storageState();
        const requestCountBefore = bunker.requests.length;

        const context2 = await browser.newContext({ storageState: state });
        const page2 = await context2.newPage();
        await page2.goto('/feed');

        // Still authenticated (JWT) …
        await expect(page2).toHaveURL(/\/feed/);
        // …and the AuthContext bunker warm-up reconnects: the mock bunker
        // receives a ping (or connect fallback) from the NEW context.
        await expect
            .poll(() => bunker.requests.slice(requestCountBefore).map(r => r.method), { timeout: 45_000 })
            .toContain('ping');

        // No terminal-disconnect toast
        await expect(page2.locator('text=Remote signer disconnected')).not.toBeVisible();

        await context2.close();
    });
});
