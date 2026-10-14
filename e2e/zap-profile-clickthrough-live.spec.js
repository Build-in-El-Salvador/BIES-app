import { test, expect, devices } from '@playwright/test';

const BASE_URL = 'https://bies.sovit.xyz';
const API = `${BASE_URL}/api`;

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

test.use({
    ...devices['iPhone 12'],
    hasTouch: true,
});

test.describe('Zap Discover Click-Through — Live Site', () => {
    let sk, skHex, pk, token, user;

    test.beforeAll(async ({ request }) => {
        const keys = await generateKeypair();
        sk = keys.sk; skHex = keys.skHex; pk = keys.pk;
        const auth = await nostrLogin(request, sk, pk);
        token = auth.token; user = auth.user;
    });

    async function setupAuth(page) {
        await page.addInitScript(({ nsecHex }) => { window.__TEST_NSEC_HEX = nsecHex; }, { nsecHex: skHex });
        await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
        await page.evaluate(({ token, user }) => {
            localStorage.setItem('bies_token', token);
            localStorage.setItem('bies_user', JSON.stringify(user));
            localStorage.setItem('bies_login_method', 'nsec');
        }, { token, user });
    }

    test('tap zap on discover member card — should NOT navigate to profile', async ({ page }) => {
        test.setTimeout(120_000);
        page.on('pageerror', err => console.error('[Page error]', err.message));

        await setupAuth(page);

        // Go to discover page
        await page.goto(`${BASE_URL}/discover`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(3000);

        // Switch to Members tab
        const membersTab = page.getByText('Members', { exact: false }).first();
        if (await membersTab.isVisible({ timeout: 5000 }).catch(() => false)) {
            await membersTab.tap();
            await page.waitForTimeout(2000);
        }

        await page.screenshot({ path: 'e2e/screenshots/live-disc-01-members.png', fullPage: true });
        console.log('On discover/members, URL:', page.url());

        // Find a zap button on any member card
        const zapBtn = page.locator('.zap-btn, .zap-btn-bitcoin').first();
        await expect(zapBtn).toBeVisible({ timeout: 10000 });

        const discoverUrl = page.url();
        console.log('Found zap button on discover page. Tapping...');

        // Tap the zap button to open modal
        await zapBtn.tap();
        await page.waitForTimeout(1500);

        await page.screenshot({ path: 'e2e/screenshots/live-disc-02-modal-open.png', fullPage: true });

        // Check we're still on discover (didn't navigate to profile)
        expect(page.url()).toBe(discoverUrl);
        console.log('After opening modal, URL:', page.url(), '(should still be /discover)');

        // Wait for modal to load
        const modal = page.locator('[data-testid="zap-modal"]');
        await expect(modal).toBeVisible({ timeout: 5000 });

        const sendBtn = modal.locator('[data-testid="zap-send-btn"]');
        const errorEl = modal.locator('[data-testid="zap-error"]');
        await expect(sendBtn.or(errorEl)).toBeVisible({ timeout: 15000 });

        await page.screenshot({ path: 'e2e/screenshots/live-disc-03-modal-ready.png', fullPage: true });

        // NOW THE KEY TEST: tap the "Zap X sats" send button
        if (await sendBtn.isVisible()) {
            console.log('Tapping the Zap send button inside modal...');
            await sendBtn.tap();
            await page.waitForTimeout(2000);

            await page.screenshot({ path: 'e2e/screenshots/live-disc-04-after-send.png', fullPage: true });

            const urlAfterSend = page.url();
            console.log('After tapping send, URL:', urlAfterSend);

            // THIS IS THE BUG: the click should NOT navigate to the profile
            if (urlAfterSend !== discoverUrl) {
                console.error(`BUG CONFIRMED: Navigated from ${discoverUrl} to ${urlAfterSend}`);
            }
            expect(urlAfterSend).toBe(discoverUrl);
        } else {
            // Error state — test tapping the close/try-again button
            console.log('Modal in error state, tapping close...');
            const closeBtn = modal.locator('.zap-done-btn, .zap-close').first();
            await closeBtn.tap();
            await page.waitForTimeout(500);
            expect(page.url()).toBe(discoverUrl);
            console.log('After closing error modal, URL:', page.url());
        }

        // Also test: tap amount chips
        if (await modal.isVisible().catch(() => false) && await sendBtn.isVisible().catch(() => false)) {
            const chip500 = modal.locator('[data-testid="zap-amount-500"]');
            if (await chip500.isVisible().catch(() => false)) {
                await chip500.tap();
                await page.waitForTimeout(300);
                expect(page.url()).toBe(discoverUrl);
                console.log('After tapping 500 chip, URL:', page.url());
            }

            // Tap custom amount input
            const customInput = modal.locator('[data-testid="zap-custom-amount"]');
            if (await customInput.isVisible().catch(() => false)) {
                await customInput.tap();
                await page.waitForTimeout(300);
                expect(page.url()).toBe(discoverUrl);
                console.log('After tapping custom input, URL:', page.url());
            }
        }

        console.log('=== Test Complete ===');
    });
});
