import { test, expect } from '@playwright/test';
import { startMockRelay } from './helpers/mockRelay.js';
import { startMockBunker } from './helpers/mockBunker.js';

/**
 * NIP-46 nostrconnect:// client-initiated pairing (the Amber QR flow).
 *
 * The app renders a nostrconnect:// URI; the mock bunker "scans" it by
 * sending the secret back to the client pubkey over the mock relay, then
 * serves the signing requests for the BIES challenge login.
 *
 * The login kind (27235) is never pre-authorized in the URI, so a signer has
 * to ask the person: the later tests play a signer that refuses it, one that
 * holds the request with an auth_url until the person approves (also after
 * the screen's slow-wait notice, and after its give-up), and a Cancel while
 * it waits. BIES shortens its waits for these through window.__TEST_SIGNER_WAIT.
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

test.afterEach(() => {
    // Nothing a test configured leaks into the next one.
    bunker.holdSign(null);
    bunker.releaseHeld();
    bunker.denyKinds([]);
});

const LOGGED_IN = /\/(home|feed|dashboard)/;
const AWAITING = '[data-testid="nostrconnect-awaiting-approval"]';

/** Open the scan view and return the nostrconnect:// URI it shows. */
async function openScan(page) {
    await page.goto('/login');
    await page.click('.mode-tab:has-text("Remote")');
    await page.click('.mode-tab:has-text("Scan / Amber")');
    const uriField = page.locator('[data-testid="nostrconnect-uri"]');
    await expect(uriField).toBeAttached({ timeout: 10_000 });
    return uriField.inputValue();
}

/** Shorter waits than the real 60 s / 240 s, so a test doesn't sit through them. */
async function shortWaits(page, softMs, hardMs) {
    await page.addInitScript(([soft, hard]) => {
        window.__TEST_SIGNER_WAIT = { softMs: soft, hardMs: hard };
    }, [softMs, hardMs]);
}

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
        // The login kind is asked for each time, never pre-authorized (it also
        // confirms account deletion); other kinds are.
        expect(decodeURIComponent(uri)).toContain('sign_event:1,');
        expect(decodeURIComponent(uri)).not.toContain('sign_event:27235');

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

    test('signer refuses the login kind → message → Try Again signs in on the same pairing', async ({ page }) => {
        test.setTimeout(120_000);
        bunker.denyKinds([27235]);
        const before = bunker.requests.length;

        const uri = await openScan(page);
        bunker.approveNostrConnect(uri);

        // The refusal is explained.
        await expect(page.locator('text=event kind 27235')).toBeVisible({ timeout: 60_000 });

        // The person allows it; the next attempt waits on them (held), and the
        // old message is gone while it does.
        bunker.denyKinds([]);
        bunker.holdSign({ delayMs: 60_000 });
        await page.click('button:has-text("Try Again")');
        await expect(page.locator(AWAITING)).toBeVisible({ timeout: 10_000 });
        await expect(page.locator('text=event kind 27235')).toHaveCount(0);

        bunker.releaseHeld();
        await page.waitForURL(LOGGED_IN, { timeout: 60_000 });

        const methods = bunker.requests.slice(before).map(r => r.method);
        expect(methods.filter(m => m === 'sign_event').length).toBeGreaterThanOrEqual(2);
        // Same pairing: the QR was not shown again.
        await expect(page.locator('[data-testid="nostrconnect-uri"]')).toHaveCount(0);
    });

    test('signer holds the login with an auth_url → waiting notice → late approval still logs in', async ({ page }) => {
        test.setTimeout(120_000);
        await shortWaits(page, 1_500, 20_000);
        const authUrl = 'http://localhost:5173/signer-approval-test';
        bunker.holdSign({ authUrl, delayMs: 5_000 });
        const before = bunker.requests.length;

        const uri = await openScan(page);
        bunker.approveNostrConnect(uri);

        // Waiting on the person, with the signer's approval page linked inline.
        await expect(page.locator(AWAITING)).toBeVisible({ timeout: 30_000 });
        await expect(page.locator('[data-testid="nostrconnect-approval-link"]')).toHaveAttribute('href', authUrl);
        // Past the soft limit the wait goes on and says so.
        await expect(page.locator('[data-testid="nostrconnect-still-waiting"]')).toBeVisible({ timeout: 10_000 });

        // The approval arrives after that notice: it is used, not thrown away.
        await page.waitForURL(LOGGED_IN, { timeout: 60_000 });
        const signs = bunker.requests.slice(before).filter(r => r.method === 'sign_event');
        expect(signs).toHaveLength(1);
    });

    test('approval after the give-up is ignored and Try Again starts a fresh request', async ({ page }) => {
        test.setTimeout(120_000);
        await shortWaits(page, 500, 2_500);
        // Answers 6 s after the request: well past the 2.5 s give-up.
        bunker.holdSign({ delayMs: 6_000 });
        const before = bunker.requests.length;

        const uri = await openScan(page);
        bunker.approveNostrConnect(uri);

        await expect(page.locator(AWAITING)).toBeVisible({ timeout: 30_000 });
        await expect(page.locator('text=Your signer did not respond')).toBeVisible({ timeout: 15_000 });
        await expect(page.locator('button:has-text("Try Again")')).toBeVisible();

        // The late signature lands now; it must not log anyone in.
        await page.waitForTimeout(6_000);
        await expect(page).toHaveURL(/\/login/);
        expect(await page.evaluate(() => localStorage.getItem('bies_login_method'))).not.toBe('bunker');

        // Try Again asks afresh (a new challenge) and this time it is answered at once.
        bunker.holdSign(null);
        await page.click('button:has-text("Try Again")');
        await page.waitForURL(LOGGED_IN, { timeout: 60_000 });
        const signs = bunker.requests.slice(before).filter(r => r.method === 'sign_event');
        expect(signs.length).toBeGreaterThanOrEqual(2);
    });

    test('Cancel while waiting for approval stops the login for good', async ({ page }) => {
        test.setTimeout(120_000);
        bunker.holdSign({ authUrl: 'http://localhost:5173/signer-approval-test', delayMs: 60_000 });

        const uri = await openScan(page);
        bunker.approveNostrConnect(uri);

        await expect(page.locator(AWAITING)).toBeVisible({ timeout: 30_000 });
        await page.click(`${AWAITING} button:has-text("Cancel")`);
        await expect(page.locator('text=Connection cancelled')).toBeVisible();

        // The signer answers afterwards: nobody is logged in, nothing is kept.
        bunker.releaseHeld();
        await page.waitForTimeout(2_000);
        await expect(page).toHaveURL(/\/login/);
        const stored = await page.evaluate(() => ({
            pairing: localStorage.getItem('bies_nip46_bunker'),
            method: localStorage.getItem('bies_login_method'),
        }));
        expect(stored.pairing).toBeNull();
        expect(stored.method).not.toBe('bunker');
    });
});
