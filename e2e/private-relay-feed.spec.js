/**
 * Playwright E2E test for BIES private relay feed.
 * Verifies that a user can post to the private relay and see their post appear.
 *
 * Requires:
 *   - Docker dev relay on port 7777
 *   - Backend server on port 3001
 *   - Vite dev server on port 5173
 */

import { test, expect } from '@playwright/test';

const API = 'http://localhost:3001/api';

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Generate a Nostr keypair using nostr-tools (server-side in Node).
 * Returns { sk (hex), pk (hex), nsec (bech32) }.
 */
async function generateKeypair() {
    const { generateSecretKey, getPublicKey } = await import('nostr-tools/pure');
    const { nip19 } = await import('nostr-tools');
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const nsec = nip19.nsecEncode(sk);
    const skHex = Buffer.from(sk).toString('hex');
    return { sk, skHex, pk, nsec };
}

/**
 * Sign a Nostr event with a secret key.
 */
async function signEvent(event, sk) {
    const { finalizeEvent } = await import('nostr-tools/pure');
    return finalizeEvent(event, sk);
}

/**
 * Do the full nostr challenge-response login via API.
 * Returns { token, user }.
 */
async function nostrLogin(request, sk, pk) {
    // Step 1: Get challenge (GET with query param)
    const challengeRes = await request.get(`${API}/auth/nostr-challenge?pubkey=${pk}`);
    expect(challengeRes.ok(), `Challenge request failed: ${challengeRes.status()}`).toBeTruthy();
    const { challenge } = await challengeRes.json();

    // Step 2: Sign the challenge
    const signed = await signEvent({
        kind: 27235,
        pubkey: pk,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['u', new URL(`${API}/auth/nostr-login`).href], ['method', 'POST']],
        content: challenge,
    }, sk);

    // Step 3: Login
    const loginRes = await request.post(`${API}/auth/nostr-login`, {
        data: { pubkey: pk, signedEvent: signed },
    });
    expect(loginRes.ok(), `Nostr login failed: ${loginRes.status()}`).toBeTruthy();
    const body = await loginRes.json();
    return { token: body.token, user: body.user };
}

/**
 * Inject auth state into the browser (token, user, nostr signer).
 * The nsecHex is a hex-encoded secret key (not bech32).
 */
async function injectAuth(page, token, user, nsecHex) {
    if (nsecHex) {
        await page.addInitScript(({ nsecHex }) => {
            window.__TEST_NSEC_HEX = nsecHex;
        }, { nsecHex });
    }
    await page.goto('/');
    await page.evaluate(({ token, user }) => {
        localStorage.setItem('bies_token', token);
        localStorage.setItem('bies_user', JSON.stringify(user));
        localStorage.setItem('bies_login_method', 'nsec');
    }, { token, user });
}

// ── Tests ────────────────────────────────────────────────────────────

test.describe('Private Relay Feed - Post and Read', () => {
    let sk, skHex, pk, nsec, token, user;

    test.beforeAll(async ({ request }) => {
        const keys = await generateKeypair();
        sk = keys.sk;
        skHex = keys.skHex;
        pk = keys.pk;
        nsec = keys.nsec;

        // Login via nostr challenge-response (auto-creates user + whitelists pubkey)
        const auth = await nostrLogin(request, sk, pk);
        token = auth.token;
        user = auth.user;
    });

    test('can post to private relay and see the post in feed', async ({ page }) => {
        const jsErrors = [];
        page.on('pageerror', err => jsErrors.push(err.message));

        // Listen for console messages to debug relay issues
        const consoleLogs = [];
        page.on('console', msg => {
            if (msg.type() === 'error' || msg.text().includes('[Feed]') || msg.text().includes('[Nostr]')) {
                consoleLogs.push(`[${msg.type()}] ${msg.text()}`);
            }
        });

        // Inject auth
        await injectAuth(page, token, user, skHex);

        // Navigate to feed
        await page.goto('/feed');

        // Wait for feed page to load
        const tabs = page.locator('[data-testid="feed-tabs"]');
        await expect(tabs).toBeVisible({ timeout: 15000 });

        // Verify private tab is active
        const privateTab = page.locator('[data-testid="tab-private"]');
        await expect(privateTab).toHaveClass(/active/);

        // Set the nsec on the signer (it may have been cleared by page navigation)
        await page.evaluate(async ({ skHex }) => {
            const skBytes = new Uint8Array(skHex.match(/.{1,2}/g).map(b => parseInt(b, 16)));
            const signerModule = await import('/src/services/nostrSigner.js');
            signerModule.nostrSigner.setNsec(skBytes);
        }, { skHex });

        // Wait for feed to finish loading (either shows posts, empty state, or loading resolves)
        const loadingEl = page.locator('[data-testid="feed-loading"]');
        const emptyEl = page.locator('[data-testid="feed-empty"]');
        const listEl = page.locator('[data-testid="feed-list"]');
        await expect(loadingEl.or(emptyEl).or(listEl)).toBeVisible({ timeout: 20000 });

        // Compose and post a unique message
        const uniqueMsg = `E2E test post ${Date.now()} - private relay works!`;
        const composeInput = page.locator('[data-testid="compose-input"]');
        await expect(composeInput).toBeVisible({ timeout: 5000 });
        await composeInput.fill(uniqueMsg);

        // Post button should be enabled
        const postBtn = page.locator('[data-testid="post-btn"]');
        await expect(postBtn).toBeEnabled();

        // Click post
        await postBtn.click();

        // Wait for posting to complete (button re-enables, input clears)
        await expect(composeInput).toHaveValue('', { timeout: 15000 });

        // The post should now appear in the feed
        // Wait for the feed list to become visible (may have been empty before)
        await expect(listEl).toBeVisible({ timeout: 20000 });

        // Look for our specific post content
        const postLocator = page.locator('[data-testid="feed-note"]', { hasText: uniqueMsg });
        await expect(postLocator).toBeVisible({ timeout: 20000 });

        // Verify no JS errors
        const relevantErrors = jsErrors.filter(e =>
            !e.includes('ResizeObserver') && !e.includes('Non-Error promise rejection')
        );
        if (relevantErrors.length > 0) {
            console.log('Console logs:', consoleLogs.join('\n'));
        }
        expect(relevantErrors, `JS errors: ${relevantErrors.join('; ')}`).toHaveLength(0);
    });

    test('posted message persists after tab switch', async ({ page }) => {
        // Inject auth and set signer
        await injectAuth(page, token, user, skHex);

        await page.goto('/feed');

        // Set the signer key
        await page.evaluate(async ({ skHex }) => {
            const skBytes = new Uint8Array(skHex.match(/.{1,2}/g).map(b => parseInt(b, 16)));
            const signerModule = await import('/src/services/nostrSigner.js');
            signerModule.nostrSigner.setNsec(skBytes);
        }, { skHex });

        // Wait for tabs
        const privateTab = page.locator('[data-testid="tab-private"]');
        const publicTab = page.locator('[data-testid="tab-explore"]');
        await expect(privateTab).toBeVisible({ timeout: 15000 });

        // Post a unique message
        const uniqueMsg = `Persist test ${Date.now()}`;
        const composeInput = page.locator('[data-testid="compose-input"]');
        await expect(composeInput).toBeVisible({ timeout: 5000 });
        await composeInput.fill(uniqueMsg);
        await page.locator('[data-testid="post-btn"]').click();
        await expect(composeInput).toHaveValue('', { timeout: 15000 });

        // Switch to public tab
        await publicTab.click();
        await expect(publicTab).toHaveClass(/active/);

        // Wait a moment for public feed to start loading
        await page.waitForTimeout(2000);

        // Switch back to private tab
        await privateTab.click();
        await expect(privateTab).toHaveClass(/active/);

        // The post should still be there after switching back
        const feedList = page.locator('[data-testid="feed-list"]');
        await expect(feedList).toBeVisible({ timeout: 20000 });

        const postLocator = page.locator('[data-testid="feed-note"]', { hasText: uniqueMsg });
        await expect(postLocator).toBeVisible({ timeout: 20000 });
    });
});
