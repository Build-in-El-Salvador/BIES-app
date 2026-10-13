import { test, expect } from '@playwright/test';
import { startMockRelay } from './helpers/mockRelay.js';
import { startMockBunker } from './helpers/mockBunker.js';

/**
 * NIP-46 nostrconnect:// client-initiated pairing (the Amber QR flow).
 *
 * The app renders a nostrconnect:// URI; the mock bunker "scans" it by
 * sending the secret back to the client pubkey over the mock relay, then
 * serves the signing requests for the BIES challenge login.
 */

let relay;
let bunker;

test.beforeAll(async () => {
    relay = startMockRelay(7798);
    bunker = await startMockBunker(relay.url);
});

test.afterAll(async () => {
    await bunker?.close();
    await relay?.close();
});

test.describe('NIP-46 nostrconnect QR login', () => {
    test.beforeEach(async ({ page }) => {
        // Point the QR flow's rendezvous relays at the mock relay
        await page.addInitScript((relayUrl) => {
            window.__TEST_NIP46_RELAYS = [relayUrl];
        }, relay.url);
    });

    test('QR pairing → signer approves → logged in', async ({ page }) => {
        test.setTimeout(120_000);

        await page.goto('/login');
        await page.click('.mode-tab:has-text("Remote")');
        await page.click('.mode-tab:has-text("Scan / Amber")');

        // The connect URI doubles as the E2E hook
        const uriField = page.locator('[data-testid="nostrconnect-uri"]');
        await expect(uriField).toBeAttached({ timeout: 10_000 });
        const uri = await uriField.inputValue();
        expect(uri).toMatch(/^nostrconnect:\/\//);
        expect(uri).toContain('secret=');
        expect(decodeURIComponent(uri)).toContain(relay.url);

        await expect(page.locator('text=Waiting for approval')).toBeVisible();

        // The signer approves the pairing
        bunker.approveNostrConnect(uri);

        // Pairing → challenge login → app
        await page.waitForURL(/\/(home|feed|dashboard)/, { timeout: 60_000 });

        const methods = bunker.requests.map(r => r.method);
        expect(methods).toContain('get_public_key');
        expect(methods).toContain('sign_event');

        // Session persisted for restart reconnects
        const stored = await page.evaluate(() => ({
            bunkerPointer: localStorage.getItem('bies_nip46_bunker'),
            method: localStorage.getItem('bies_login_method'),
        }));
        expect(stored.bunkerPointer).toContain(bunker.pubkey);
        expect(stored.method).toBe('bunker');
    });

    test('cancel tears the session down; regenerate makes a fresh URI', async ({ page }) => {
        await page.goto('/login');
        await page.click('.mode-tab:has-text("Remote")');
        await page.click('.mode-tab:has-text("Scan / Amber")');

        const uriField = page.locator('[data-testid="nostrconnect-uri"]');
        await expect(uriField).toBeAttached({ timeout: 10_000 });
        const firstUri = await uriField.inputValue();

        // Cancelling must not persist anything
        await page.click('button:has-text("Cancel")');
        await expect(page.locator('text=Cancelled')).toBeVisible();
        const stored = await page.evaluate(() => localStorage.getItem('bies_nip46_bunker'));
        expect(stored).toBeNull();

        // Regenerate → a brand new secret/URI
        await page.click('button:has-text("Generate new QR")');
        await expect(uriField).toBeAttached({ timeout: 10_000 });
        const secondUri = await uriField.inputValue();
        expect(secondUri).toMatch(/^nostrconnect:\/\//);
        expect(secondUri).not.toBe(firstUri);
    });
});
