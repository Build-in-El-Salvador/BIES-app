/**
 * Playwright E2E tests for media upload in the Feed compose box: file
 * attachment UI, preview, removal, and the upload+post flow. Photos go to
 * BIES's own storage (POST /api/upload/media, services/mediaService.js).
 */

import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';

const API = 'http://localhost:3001/api';

// ── Helpers ──────────────────────────────────────────────────────────

async function generateKeypair() {
    const { generateSecretKey, getPublicKey } = await import('nostr-tools/pure');
    const { nip19 } = await import('nostr-tools');
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const nsec = nip19.nsecEncode(sk);
    const skHex = Buffer.from(sk).toString('hex');
    return { sk, skHex, pk, nsec };
}

async function signEvent(event, sk) {
    const { finalizeEvent } = await import('nostr-tools/pure');
    return finalizeEvent(event, sk);
}

async function nostrLogin(request, sk, pk) {
    const challengeRes = await request.get(`${API}/auth/nostr-challenge?pubkey=${pk}`);
    expect(challengeRes.ok(), `Challenge request failed: ${challengeRes.status()}`).toBeTruthy();
    const { challenge } = await challengeRes.json();

    const signed = await signEvent({
        kind: 27235,
        pubkey: pk,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: challenge,
    }, sk);

    const loginRes = await request.post(`${API}/auth/nostr-login`, {
        data: { pubkey: pk, signedEvent: signed },
    });
    expect(loginRes.ok(), `Nostr login failed: ${loginRes.status()}`).toBeTruthy();
    const body = await loginRes.json();
    return { token: body.token, user: body.user };
}

/**
 * Inject auth and signer key. Uses addInitScript to set window.__TEST_NSEC_HEX
 * BEFORE any page JS loads, so nostrSigner picks up the key at module load time.
 */
async function injectAuthAndSigner(page, token, user, skHex) {
    await page.addInitScript(({ skHex }) => {
        window.__TEST_NSEC_HEX = skHex;
    }, { skHex });

    await page.goto('/');
    await page.evaluate(({ token, user }) => {
        localStorage.setItem('bies_token', token);
        localStorage.setItem('bies_user', JSON.stringify(user));
        localStorage.setItem('bies_login_method', 'nsec');
    }, { token, user });
}

/** Inject auth WITHOUT signer (for UI-only tests that don't need signing) */
async function injectAuth(page, token, user) {
    await page.goto('/');
    await page.evaluate(({ token, user }) => {
        localStorage.setItem('bies_token', token);
        localStorage.setItem('bies_user', JSON.stringify(user));
        localStorage.setItem('bies_login_method', 'nsec');
    }, { token, user });
}

/** Create a small test PNG file (1x1 red pixel) */
function createTestPng() {
    const png = Buffer.from(
        '89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de' +
        '0000000c4944415408d76360f8cf0000000201014898669d0000000049454e44ae426082',
        'hex'
    );
    const tmpPath = path.join('/tmp', `test-image-${Date.now()}.png`);
    fs.writeFileSync(tmpPath, png);
    return tmpPath;
}

/** Create a second test PNG */
function createTestPng2() {
    const png = Buffer.from(
        '89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de' +
        '0000000c4944415408d76360f80f0000000201014898669d0000000049454e44ae426082',
        'hex'
    );
    const tmpPath = path.join('/tmp', `test-image2-${Date.now()}.png`);
    fs.writeFileSync(tmpPath, png);
    return tmpPath;
}

// ── Tests ────────────────────────────────────────────────────────────

test.describe('Media Upload - Compose Box UI', () => {
    let sk, skHex, pk, token, user;

    test.beforeAll(async ({ request }) => {
        const keys = await generateKeypair();
        sk = keys.sk;
        skHex = keys.skHex;
        pk = keys.pk;

        const auth = await nostrLogin(request, sk, pk);
        token = auth.token;
        user = auth.user;

        // A new account is asked for the terms and a name first (TermsGate,
        // ProfileGate); answer both here, so the Feed is what's on screen.
        const headers = { Authorization: `Bearer ${token}` };
        const terms = await request.post(`${API}/account/terms`, { headers, data: { version: user.termsVersion } });
        expect(terms.ok(), `Accepting the terms failed: ${terms.status()}`).toBeTruthy();
        const named = await request.put(`${API}/profiles/me`, { headers, data: { name: 'Media Tester' } });
        expect(named.ok(), `Naming the profile failed: ${named.status()}`).toBeTruthy();
        user = { ...user, termsAccepted: true, profile: { ...(user.profile || {}), name: 'Media Tester' } };
    });

    test('media attach button is visible in compose box', async ({ page }) => {
        const jsErrors = [];
        page.on('pageerror', err => jsErrors.push(err.message));

        await injectAuth(page, token, user);
        await page.goto('/feed');

        const composeInput = page.locator('[data-testid="compose-input"]');
        await expect(composeInput).toBeVisible({ timeout: 10000 });

        const attachBtn = page.locator('button[title="Attach image or video"]');
        await expect(attachBtn).toBeVisible();
        await expect(attachBtn).toBeEnabled();

        const relevantErrors = jsErrors.filter(e =>
            !e.includes('ResizeObserver') && !e.includes('Non-Error promise rejection')
        );
        expect(relevantErrors, `JS errors: ${relevantErrors.join('; ')}`).toHaveLength(0);
    });

    test('attaching an image shows preview thumbnail', async ({ page }) => {
        await injectAuth(page, token, user);
        await page.goto('/feed');

        await expect(page.locator('[data-testid="compose-input"]')).toBeVisible({ timeout: 10000 });

        const testPng = createTestPng();
        const fileInput = page.locator('input[type="file"][accept="image/*,video/*"]');
        await fileInput.setInputFiles(testPng);

        const previewContainer = page.locator('.primal-compose-media-preview');
        await expect(previewContainer).toBeVisible({ timeout: 5000 });

        const previewItem = page.locator('.primal-compose-media-item');
        await expect(previewItem).toBeVisible();
        await expect(previewItem.locator('img')).toBeVisible();
        await expect(page.locator('.primal-compose-media-remove')).toBeVisible();

        fs.unlinkSync(testPng);
    });

    test('removing an attachment clears the preview', async ({ page }) => {
        await injectAuth(page, token, user);
        await page.goto('/feed');

        await expect(page.locator('[data-testid="compose-input"]')).toBeVisible({ timeout: 10000 });

        const testPng = createTestPng();
        await page.locator('input[type="file"][accept="image/*,video/*"]').setInputFiles(testPng);

        const previewItem = page.locator('.primal-compose-media-item');
        await expect(previewItem).toBeVisible({ timeout: 5000 });

        await page.locator('.primal-compose-media-remove').click();
        await expect(previewItem).not.toBeVisible();
        await expect(page.locator('.primal-compose-media-preview')).not.toBeVisible();

        fs.unlinkSync(testPng);
    });

    test('can attach multiple images and see multiple previews', async ({ page }) => {
        await injectAuth(page, token, user);
        await page.goto('/feed');

        await expect(page.locator('[data-testid="compose-input"]')).toBeVisible({ timeout: 10000 });

        const testPng1 = createTestPng();
        const testPng2 = createTestPng2();

        await page.locator('input[type="file"][accept="image/*,video/*"]').setInputFiles([testPng1, testPng2]);

        const previewItems = page.locator('.primal-compose-media-item');
        await expect(previewItems).toHaveCount(2, { timeout: 5000 });

        await page.locator('.primal-compose-media-remove').first().click();
        await expect(previewItems).toHaveCount(1);

        fs.unlinkSync(testPng1);
        fs.unlinkSync(testPng2);
    });

    test('post button enabled with media only (no text)', async ({ page }) => {
        await injectAuth(page, token, user);
        await page.goto('/feed');

        await expect(page.locator('[data-testid="compose-input"]')).toBeVisible({ timeout: 10000 });

        const postBtn = page.locator('[data-testid="post-btn"]');
        await expect(postBtn).toBeDisabled();

        const testPng = createTestPng();
        await page.locator('input[type="file"][accept="image/*,video/*"]').setInputFiles(testPng);
        await expect(page.locator('.primal-compose-media-item')).toBeVisible({ timeout: 5000 });

        await expect(postBtn).toBeEnabled();

        fs.unlinkSync(testPng);
    });

    test('post with media uploads to BIES and publishes', async ({ page }) => {
        // Mock the BIES upload BEFORE navigating
        await page.route('**/api/upload/media', async (route) => {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ url: '/uploads/public/fake-abc123.png' }),
            });
        });

        // Use addInitScript to inject signer key before page JS loads
        await injectAuthAndSigner(page, token, user, skHex);
        await page.goto('/feed');

        const composeInput = page.locator('[data-testid="compose-input"]');
        await expect(composeInput).toBeVisible({ timeout: 10000 });

        // Attach a test image
        const testPng = createTestPng();
        await page.locator('input[type="file"][accept="image/*,video/*"]').setInputFiles(testPng);
        await expect(page.locator('.primal-compose-media-item')).toBeVisible({ timeout: 5000 });

        const uniqueMsg = `Media test ${Date.now()}`;
        await composeInput.fill(uniqueMsg);

        const postBtn = page.locator('[data-testid="post-btn"]');
        await expect(postBtn).toBeEnabled();
        await postBtn.click();

        // Wait for compose box to clear (post completed)
        await expect(composeInput).toHaveValue('', { timeout: 20000 });
        await expect(page.locator('.primal-compose-media-preview')).not.toBeVisible();

        // Post should appear in feed
        const feedList = page.locator('[data-testid="feed-list"]');
        await expect(feedList).toBeVisible({ timeout: 20000 });
        await expect(page.locator('[data-post-id]', { hasText: uniqueMsg })).toBeVisible({ timeout: 20000 });

        fs.unlinkSync(testPng);
    });

    test('post button shows uploading state during upload', async ({ page }) => {
        // Mock the BIES upload with a delay
        await page.route('**/api/upload/media', async (route) => {
            await new Promise(r => setTimeout(r, 2000));
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ url: '/uploads/public/test.png' }),
            });
        });

        await injectAuthAndSigner(page, token, user, skHex);
        await page.goto('/feed');

        const composeInput = page.locator('[data-testid="compose-input"]');
        await expect(composeInput).toBeVisible({ timeout: 10000 });

        const testPng = createTestPng();
        await page.locator('input[type="file"][accept="image/*,video/*"]').setInputFiles(testPng);
        await expect(page.locator('.primal-compose-media-item')).toBeVisible({ timeout: 5000 });

        await composeInput.fill('Upload state test');

        const postBtn = page.locator('[data-testid="post-btn"]');
        await postBtn.click();

        // Button should show "Uploading..." text
        await expect(postBtn).toContainText('Uploading', { timeout: 5000 });

        // Wait for completion
        await expect(composeInput).toHaveValue('', { timeout: 25000 });

        fs.unlinkSync(testPng);
    });

    test('upload failure shows error and preserves attachments', async ({ page }) => {
        // Mock the BIES upload to fail
        await page.route('**/api/upload/media', async (route) => {
            await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Failed to upload media' }) });
        });

        await injectAuthAndSigner(page, token, user, skHex);
        await page.goto('/feed');

        const composeInput = page.locator('[data-testid="compose-input"]');
        await expect(composeInput).toBeVisible({ timeout: 10000 });

        const testPng = createTestPng();
        await page.locator('input[type="file"][accept="image/*,video/*"]').setInputFiles(testPng);
        await expect(page.locator('.primal-compose-media-item')).toBeVisible({ timeout: 5000 });

        await composeInput.fill('This should fail');

        await page.locator('[data-testid="post-btn"]').click();

        // Error message should appear
        const errorEl = page.locator('.primal-compose-error');
        await expect(errorEl).toBeVisible({ timeout: 15000 });
        await expect(errorEl).toContainText('failed', { ignoreCase: true });

        // Attachments should be preserved for retry
        await expect(page.locator('.primal-compose-media-item')).toBeVisible();
        await expect(composeInput).toHaveValue('This should fail');

        fs.unlinkSync(testPng);
    });
});
