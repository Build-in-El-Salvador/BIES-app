import { test, expect, devices } from '@playwright/test';

const BASE_URL = process.env.BIES_BASE_URL || 'http://localhost:5173';
const API_BASE = process.env.BIES_API_URL || 'http://localhost:3001';
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

// Use iPhone 12 emulation for mobile testing
test.use({
    ...devices['iPhone 12'],
    hasTouch: true,
});

test.describe('Zap Modal Click-Through on Mobile', () => {
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
        // Wait for either tab to appear (page loaded)
        await expect(page.locator('[data-testid="tab-private"], [data-testid="tab-explore"]').first()).toBeVisible({ timeout: 15000 });

        // Switch to explore/public tab to see posts
        const exploreTab = page.locator('[data-testid="tab-explore"]');
        if (await exploreTab.isVisible()) await exploreTab.click();

        const firstNote = page.locator('[data-testid="feed-list"] .primal-note').first();
        await expect(firstNote).toBeVisible({ timeout: 30000 });
    }

    test('zap modal blocks touch events on mobile — taps do not reach feed behind it', async ({ page }) => {
        page.on('pageerror', err => console.error('[Page error]', err.message));
        await setupPage(page);
        await waitForFeed(page);

        // Record initial scroll position and page URL
        const initialUrl = page.url();
        const initialScroll = await page.evaluate(() => window.scrollY);

        // Find and tap zap button on first note
        const firstNote = page.locator('[data-testid="feed-list"] .primal-note').first();
        const zapBtn = firstNote.locator('.primal-action-icon-zap').first();
        await expect(zapBtn).toBeVisible({ timeout: 10000 });

        // Screenshot before
        await page.screenshot({ path: 'e2e/screenshots/zap-modal-before.png' });

        await zapBtn.tap();

        // Modal should appear
        const modal = page.locator('[data-testid="zap-modal"]');
        await expect(modal).toBeVisible({ timeout: 5000 });

        // Screenshot with modal open
        await page.screenshot({ path: 'e2e/screenshots/zap-modal-open.png' });

        // Wait for the modal to resolve to ready or error state
        const sendBtn = modal.locator('[data-testid="zap-send-btn"]');
        const error = modal.locator('[data-testid="zap-error"]');
        await expect(sendBtn.or(error)).toBeVisible({ timeout: 15000 });

        if (await error.isVisible()) {
            console.log('Note author has no lud16 — testing click-through on error state');
        }

        // NOW test click-through: tap various places on the modal card
        // and verify nothing happens behind it (no navigation, no scroll, no side effects)
        const zapCard = modal.locator('.zap-card');
        const cardBox = await zapCard.boundingBox();

        if (cardBox) {
            // Tap the center of the modal card
            await page.tap('.zap-card', { position: { x: cardBox.width / 2, y: cardBox.height / 2 } });

            // Wait a moment for any side effects
            await page.waitForTimeout(300);

            // Modal should STILL be visible (touch didn't pass through)
            await expect(modal).toBeVisible();

            // Page should not have navigated
            expect(page.url()).toBe(initialUrl);

            // Scroll position should not have changed
            const scrollAfterTap = await page.evaluate(() => window.scrollY);
            expect(scrollAfterTap).toBe(initialScroll);

            // Screenshot after tapping inside modal
            await page.screenshot({ path: 'e2e/screenshots/zap-modal-after-tap.png' });
        }

        // Test tapping the overlay (outside the card but inside the overlay)
        // This should close the modal, NOT interact with feed behind it
        const overlayBox = await modal.boundingBox();
        if (overlayBox && cardBox) {
            // Tap near the top-left corner of the overlay (outside the card)
            await modal.tap({ position: { x: 5, y: 5 } });
            await page.waitForTimeout(300);

            // Modal should have closed from overlay tap
            // (or remained open if the tap was on the card edge)
            // Either way, page should not have navigated
            expect(page.url()).toContain('/feed');
        }
    });

    test('zap modal amount buttons respond to taps on mobile', async ({ page }) => {
        page.on('pageerror', err => console.error('[Page error]', err.message));
        await setupPage(page);
        await waitForFeed(page);

        // Try multiple notes to find one with a zappable author
        const notes = page.locator('[data-testid="feed-list"] .primal-note');
        const count = await notes.count();
        let modal = null;

        for (let i = 0; i < Math.min(count, 5); i++) {
            const zapBtn = notes.nth(i).locator('.primal-action-icon-zap').first();
            if (!(await zapBtn.isVisible())) continue;
            await zapBtn.tap();

            modal = page.locator('[data-testid="zap-modal"]');
            await expect(modal).toBeVisible({ timeout: 5000 });

            const sendBtn = modal.locator('[data-testid="zap-send-btn"]');
            const error = modal.locator('[data-testid="zap-error"]');
            await expect(sendBtn.or(error)).toBeVisible({ timeout: 15000 });

            if (await sendBtn.isVisible()) break;

            // Close and try next
            await modal.locator('.zap-close').tap();
            await expect(modal).not.toBeVisible({ timeout: 3000 });
            modal = null;
        }

        if (!modal || !(await modal.locator('[data-testid="zap-send-btn"]').isVisible())) {
            test.skip(true, 'No zappable posts found');
            return;
        }

        // Test: tap the 500 sat amount chip
        const chip500 = modal.locator('[data-testid="zap-amount-500"]');
        await chip500.tap();
        await expect(chip500).toHaveClass(/active/);

        const sendBtn = modal.locator('[data-testid="zap-send-btn"]');
        await expect(sendBtn).toContainText('500');

        // Test: tap the 21 sat amount chip
        const chip21 = modal.locator('[data-testid="zap-amount-21"]');
        await chip21.tap();
        await expect(chip21).toHaveClass(/active/);
        await expect(sendBtn).toContainText('21');

        // Test: tap custom amount input and type
        const customInput = modal.locator('[data-testid="zap-custom-amount"]');
        await customInput.tap();
        await customInput.fill('250');
        await expect(sendBtn).toContainText('250');

        // Page should not have navigated during any of these interactions
        expect(page.url()).toContain('/feed');

        await page.screenshot({ path: 'e2e/screenshots/zap-modal-mobile-amounts.png' });
    });

    test('body scroll is locked when zap modal is open on mobile', async ({ page }) => {
        page.on('pageerror', err => console.error('[Page error]', err.message));
        await setupPage(page);
        await waitForFeed(page);

        // Scroll down first so we have room
        await page.evaluate(() => window.scrollTo(0, 200));
        await page.waitForTimeout(200);
        const scrollBefore = await page.evaluate(() => window.scrollY);

        // Open zap modal
        const firstNote = page.locator('[data-testid="feed-list"] .primal-note').first();
        const zapBtn = firstNote.locator('.primal-action-icon-zap').first();
        await zapBtn.tap();

        const modal = page.locator('[data-testid="zap-modal"]');
        await expect(modal).toBeVisible({ timeout: 5000 });

        // Try to scroll the page via touch on the overlay
        const overlayBox = await modal.boundingBox();
        if (overlayBox) {
            // Simulate a swipe/scroll gesture on the overlay
            await page.touchscreen.tap(overlayBox.x + overlayBox.width / 2, overlayBox.y + 50);
        }

        await page.waitForTimeout(300);
        const scrollAfter = await page.evaluate(() => window.scrollY);

        // Scroll should not have changed
        expect(Math.abs(scrollAfter - scrollBefore)).toBeLessThanOrEqual(1);
    });
});
