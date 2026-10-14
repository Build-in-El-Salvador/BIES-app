import { test, expect } from '@playwright/test';

const BASE_URL = process.env.BIES_BASE_URL || 'http://localhost:5173';
const API_BASE = process.env.BIES_API_URL || 'http://localhost:3002';
const API = `${API_BASE}/api`;

async function generateKeypair() {
    const { generateSecretKey, getPublicKey } = await import('nostr-tools/pure');
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const skHex = Buffer.from(sk).toString('hex');
    return { sk, skHex, pk };
}

async function nostrLogin(request, sk, pk) {
    const challengeRes = await request.get(`${API}/auth/nostr-challenge?pubkey=${pk}`);
    expect(challengeRes.ok(), `Challenge request failed: ${challengeRes.status()}`).toBeTruthy();
    const { challenge } = await challengeRes.json();

    const { finalizeEvent } = await import('nostr-tools/pure');
    const signed = finalizeEvent({
        kind: 27235,
        pubkey: pk,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['u', new URL(`${API}/auth/nostr-login`).href], ['method', 'POST']],
        content: challenge,
    }, sk);

    const loginRes = await request.post(`${API}/auth/nostr-login`, {
        data: { pubkey: pk, signedEvent: signed },
    });
    expect(loginRes.ok(), `Nostr login failed: ${loginRes.status()}`).toBeTruthy();
    const body = await loginRes.json();
    return { token: body.token, user: body.user };
}

test.describe('Zap Flow - Production Docker', () => {
    let sk, skHex, pk, token, user;

    test.beforeAll(async ({ request }) => {
        const keys = await generateKeypair();
        sk = keys.sk; skHex = keys.skHex; pk = keys.pk;
        const auth = await nostrLogin(request, sk, pk);
        token = auth.token; user = auth.user;
    });

    async function setupPage(page) {
        await page.addInitScript(({ nsecHex }) => { window.__TEST_NSEC_HEX = nsecHex; }, { nsecHex: skHex });
        await page.goto(BASE_URL);
        await page.evaluate(({ token, user }) => {
            localStorage.setItem('bies_token', token);
            localStorage.setItem('bies_user', JSON.stringify(user));
            localStorage.setItem('bies_login_method', 'nsec');
        }, { token, user });
    }

    async function waitForFeed(page) {
        await page.goto(`${BASE_URL}/feed`);
        await expect(page.locator('[data-testid="feed-tabs"]')).toBeVisible({ timeout: 15000 });

        // Use explore tab — private relay is empty for test users.
        // Tab switch briefly shows empty state while explore data loads,
        // so we wait specifically for at least one feed-note to render.
        const exploreTab = page.locator('[data-testid="tab-explore"]');
        if (await exploreTab.isVisible()) await exploreTab.click();

        const emptyEl = page.locator('[data-testid="feed-empty"]');
        const listEl = page.locator('[data-testid="feed-list"]');
        const firstNote = listEl.locator('[data-testid="feed-note"]').first();

        // Wait for notes from public relays — give extra time since
        // the tab switch resets the feed and reloads from relay
        try {
            await expect(firstNote).toBeVisible({ timeout: 30000 });
        } catch {
            // If notes never appeared, check if truly empty
        }

        return { emptyEl, listEl };
    }

    test('zap button is visible on feed posts', async ({ page }) => {
        page.on('pageerror', err => console.error('[Page error]', err.message));
        await setupPage(page);
        const { emptyEl, listEl } = await waitForFeed(page);
        if (await emptyEl.isVisible()) { test.skip(true, 'No posts in relay'); return; }

        const firstNote = listEl.locator('[data-testid="feed-note"]').first();
        const zapBtn = firstNote.locator('[data-testid="zap-btn"]');
        await expect(zapBtn).toBeVisible({ timeout: 10000 });
    });

    test('clicking zap button opens modal with resolving state', async ({ page }) => {
        page.on('pageerror', err => console.error('[Page error]', err.message));
        await setupPage(page);
        const { emptyEl, listEl } = await waitForFeed(page);
        if (await emptyEl.isVisible()) { test.skip(true, 'No posts in relay'); return; }

        const firstNote = listEl.locator('[data-testid="feed-note"]').first();
        const zapBtn = firstNote.locator('[data-testid="zap-btn"]');
        await expect(zapBtn).toBeVisible({ timeout: 10000 });
        await zapBtn.click();

        // Modal should appear
        const modal = page.locator('[data-testid="zap-modal"]');
        await expect(modal).toBeVisible({ timeout: 5000 });

        // Should show resolving or ready state (resolving may be very fast)
        const resolving = modal.locator('[data-testid="zap-resolving"]');
        const sendBtn = modal.locator('[data-testid="zap-send-btn"]');
        const error = modal.locator('[data-testid="zap-error"]');
        await expect(resolving.or(sendBtn).or(error)).toBeVisible({ timeout: 15000 });
    });

    test('zap modal shows amount presets and send button when recipient has lud16', async ({ page }) => {
        page.on('pageerror', err => console.error('[Page error]', err.message));
        await setupPage(page);
        const { emptyEl, listEl } = await waitForFeed(page);
        if (await emptyEl.isVisible()) { test.skip(true, 'No posts in relay'); return; }

        // Try each post until we find one whose author has a lud16
        const notes = listEl.locator('[data-testid="feed-note"]');
        const count = await notes.count();
        let foundReady = false;

        for (let i = 0; i < Math.min(count, 5); i++) {
            const zapBtn = notes.nth(i).locator('[data-testid="zap-btn"]');
            if (!(await zapBtn.isVisible())) continue;

            await zapBtn.click();
            const modal = page.locator('[data-testid="zap-modal"]');
            await expect(modal).toBeVisible({ timeout: 5000 });

            // Wait for resolving to finish
            const sendBtn = modal.locator('[data-testid="zap-send-btn"]');
            const error = modal.locator('[data-testid="zap-error"]');
            await expect(sendBtn.or(error)).toBeVisible({ timeout: 15000 });

            if (await sendBtn.isVisible()) {
                foundReady = true;
                // Verify amount presets exist
                await expect(modal.locator('[data-testid="zap-amount-21"]')).toBeVisible();
                await expect(modal.locator('[data-testid="zap-amount-100"]')).toBeVisible();
                await expect(modal.locator('[data-testid="zap-amount-500"]')).toBeVisible();
                await expect(modal.locator('[data-testid="zap-amount-1000"]')).toBeVisible();
                await expect(modal.locator('[data-testid="zap-amount-5000"]')).toBeVisible();

                // Verify custom amount and comment inputs exist
                await expect(modal.locator('[data-testid="zap-custom-amount"]')).toBeVisible();
                await expect(modal.locator('[data-testid="zap-comment"]')).toBeVisible();

                // 100 sats should be selected by default
                const chip100 = modal.locator('[data-testid="zap-amount-100"]');
                await expect(chip100).toHaveClass(/active/);

                // Send button text should show "100"
                await expect(sendBtn).toContainText('100');
                break;
            }

            // Close modal and try next post
            await modal.locator('.zap-close').click();
            await expect(modal).not.toBeVisible({ timeout: 3000 });
        }

        if (!foundReady) {
            test.skip(true, 'No posts from users with Lightning address');
        }
    });

    test('amount preset selection updates send button', async ({ page }) => {
        page.on('pageerror', err => console.error('[Page error]', err.message));
        await setupPage(page);
        const { emptyEl, listEl } = await waitForFeed(page);
        if (await emptyEl.isVisible()) { test.skip(true, 'No posts in relay'); return; }

        // Find a post with zappable author
        const notes = listEl.locator('[data-testid="feed-note"]');
        const count = await notes.count();
        let modal = null;

        for (let i = 0; i < Math.min(count, 5); i++) {
            const zapBtn = notes.nth(i).locator('[data-testid="zap-btn"]');
            if (!(await zapBtn.isVisible())) continue;
            await zapBtn.click();
            modal = page.locator('[data-testid="zap-modal"]');
            await expect(modal).toBeVisible({ timeout: 5000 });
            const sendBtn = modal.locator('[data-testid="zap-send-btn"]');
            const error = modal.locator('[data-testid="zap-error"]');
            await expect(sendBtn.or(error)).toBeVisible({ timeout: 15000 });
            if (await sendBtn.isVisible()) break;
            await modal.locator('.zap-close').click();
            await expect(modal).not.toBeVisible({ timeout: 3000 });
            modal = null;
        }

        if (!modal) { test.skip(true, 'No zappable posts'); return; }

        const sendBtn = modal.locator('[data-testid="zap-send-btn"]');

        // Click 500 sats
        await modal.locator('[data-testid="zap-amount-500"]').click();
        await expect(modal.locator('[data-testid="zap-amount-500"]')).toHaveClass(/active/);
        await expect(sendBtn).toContainText('500');

        // Click 21 sats
        await modal.locator('[data-testid="zap-amount-21"]').click();
        await expect(modal.locator('[data-testid="zap-amount-21"]')).toHaveClass(/active/);
        await expect(sendBtn).toContainText('21');
    });

    test('custom amount overrides preset', async ({ page }) => {
        page.on('pageerror', err => console.error('[Page error]', err.message));
        await setupPage(page);
        const { emptyEl, listEl } = await waitForFeed(page);
        if (await emptyEl.isVisible()) { test.skip(true, 'No posts in relay'); return; }

        const notes = listEl.locator('[data-testid="feed-note"]');
        const count = await notes.count();
        let modal = null;

        for (let i = 0; i < Math.min(count, 5); i++) {
            const zapBtn = notes.nth(i).locator('[data-testid="zap-btn"]');
            if (!(await zapBtn.isVisible())) continue;
            await zapBtn.click();
            modal = page.locator('[data-testid="zap-modal"]');
            await expect(modal).toBeVisible({ timeout: 5000 });
            const sendBtn = modal.locator('[data-testid="zap-send-btn"]');
            const error = modal.locator('[data-testid="zap-error"]');
            await expect(sendBtn.or(error)).toBeVisible({ timeout: 15000 });
            if (await sendBtn.isVisible()) break;
            await modal.locator('.zap-close').click();
            await expect(modal).not.toBeVisible({ timeout: 3000 });
            modal = null;
        }

        if (!modal) { test.skip(true, 'No zappable posts'); return; }

        const sendBtn = modal.locator('[data-testid="zap-send-btn"]');
        const customInput = modal.locator('[data-testid="zap-custom-amount"]');

        // Type custom amount
        await customInput.fill('250');
        await expect(sendBtn).toContainText('250');

        // No preset should be active when custom amount is entered
        for (const amt of [21, 100, 500, 1000, 5000]) {
            await expect(modal.locator(`[data-testid="zap-amount-${amt}"]`)).not.toHaveClass(/active/);
        }

        // Clicking a preset should clear custom
        await modal.locator('[data-testid="zap-amount-1000"]').click();
        await expect(customInput).toHaveValue('');
        await expect(sendBtn).toContainText('1,000');
    });

    test('zap send triggers payment flow (QR fallback without wallet)', async ({ page }) => {
        page.on('pageerror', err => console.error('[Page error]', err.message));
        await setupPage(page);
        const { emptyEl, listEl } = await waitForFeed(page);
        if (await emptyEl.isVisible()) { test.skip(true, 'No posts in relay'); return; }

        const notes = listEl.locator('[data-testid="feed-note"]');
        const count = await notes.count();
        let modal = null;

        for (let i = 0; i < Math.min(count, 5); i++) {
            const zapBtn = notes.nth(i).locator('[data-testid="zap-btn"]');
            if (!(await zapBtn.isVisible())) continue;
            await zapBtn.click();
            modal = page.locator('[data-testid="zap-modal"]');
            await expect(modal).toBeVisible({ timeout: 5000 });
            const sendBtn = modal.locator('[data-testid="zap-send-btn"]');
            const error = modal.locator('[data-testid="zap-error"]');
            await expect(sendBtn.or(error)).toBeVisible({ timeout: 15000 });
            if (await sendBtn.isVisible()) break;
            await modal.locator('.zap-close').click();
            await expect(modal).not.toBeVisible({ timeout: 3000 });
            modal = null;
        }

        if (!modal) { test.skip(true, 'No zappable posts'); return; }

        // Add optional comment
        await modal.locator('[data-testid="zap-comment"]').fill('Test zap');

        // Click send (no WebLN or NWC available, should fall back to QR or error)
        const sendBtn = modal.locator('[data-testid="zap-send-btn"]');
        await sendBtn.click();

        // Should show paying state first
        const paying = modal.locator('[data-testid="zap-paying"]');
        const qr = modal.locator('[data-testid="zap-qr"]');
        const error = modal.locator('[data-testid="zap-error"]');
        const success = modal.locator('[data-testid="zap-success"]');

        // Wait for payment attempt to complete — expect QR fallback (no wallet), or error
        await expect(paying.or(qr).or(error).or(success)).toBeVisible({ timeout: 10000 });

        // After payment attempt resolves, should be QR (got invoice but no wallet to pay)
        // or error (could not get invoice from LNURL)
        await expect(qr.or(error)).toBeVisible({ timeout: 30000 });

        if (await qr.isVisible()) {
            // QR state: verify invoice display and copy button
            await expect(modal.locator('[data-testid="zap-copy-invoice"]')).toBeVisible();
            await expect(modal.locator('.zap-invoice-text')).toBeVisible();
        }
    });

    test('zap modal closes on overlay click', async ({ page }) => {
        page.on('pageerror', err => console.error('[Page error]', err.message));
        await setupPage(page);
        const { emptyEl, listEl } = await waitForFeed(page);
        if (await emptyEl.isVisible()) { test.skip(true, 'No posts in relay'); return; }

        const firstNote = listEl.locator('[data-testid="feed-note"]').first();
        const zapBtn = firstNote.locator('[data-testid="zap-btn"]');
        await expect(zapBtn).toBeVisible({ timeout: 10000 });
        await zapBtn.click();

        const modal = page.locator('[data-testid="zap-modal"]');
        await expect(modal).toBeVisible({ timeout: 5000 });

        // Click overlay (outside the card)
        await modal.click({ position: { x: 5, y: 5 } });
        await expect(modal).not.toBeVisible({ timeout: 5000 });
    });

    test('zap modal closes on X button click', async ({ page }) => {
        page.on('pageerror', err => console.error('[Page error]', err.message));
        await setupPage(page);
        const { emptyEl, listEl } = await waitForFeed(page);
        if (await emptyEl.isVisible()) { test.skip(true, 'No posts in relay'); return; }

        const firstNote = listEl.locator('[data-testid="feed-note"]').first();
        const zapBtn = firstNote.locator('[data-testid="zap-btn"]');
        await expect(zapBtn).toBeVisible({ timeout: 10000 });
        await zapBtn.click();

        const modal = page.locator('[data-testid="zap-modal"]');
        await expect(modal).toBeVisible({ timeout: 5000 });

        // Click X button
        await modal.locator('.zap-close').click();
        await expect(modal).not.toBeVisible({ timeout: 5000 });
    });
});
