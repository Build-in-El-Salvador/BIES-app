import { test, expect } from '@playwright/test';

const BASE_URL = process.env.BIES_BASE_URL || 'http://localhost:8082';
const API = `${BASE_URL}/api`;

async function generateKeypair() {
    const { generateSecretKey, getPublicKey } = await import('nostr-tools/pure');
    const { nip19 } = await import('nostr-tools');
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

test.describe('Like Button - Production Docker', () => {
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
        const privateTab = page.locator('[data-testid="tab-private"]');
        if (!(await privateTab.getAttribute('class'))?.includes('active')) await privateTab.click();
        const loadingEl = page.locator('[data-testid="feed-loading"]');
        const emptyEl = page.locator('[data-testid="feed-empty"]');
        const listEl = page.locator('[data-testid="feed-list"]');
        await expect(loadingEl.or(emptyEl).or(listEl)).toBeVisible({ timeout: 20000 });
        return { emptyEl, listEl };
    }

    test('like button turns active after click', async ({ page }) => {
        page.on('pageerror', err => console.error('[Page error]', err.message));
        page.on('console', msg => {
            if (msg.type() === 'error' || msg.text().includes('[Nostr]')) console.log(`[Browser] ${msg.text()}`);
        });
        await setupPage(page);
        const { emptyEl, listEl } = await waitForFeed(page);
        if (await emptyEl.isVisible()) { test.skip(true, 'No posts in relay'); return; }
        const likeBtn = listEl.locator('[data-testid="feed-note"]').first().locator('[data-testid="like-btn"]');
        await expect(likeBtn).toBeVisible({ timeout: 10000 });
        expect(await likeBtn.getAttribute('class')).not.toContain('active-like');
        await likeBtn.click();
        await expect(likeBtn).toHaveClass(/active-like/, { timeout: 10000 });
    });

    test('liked state persists after page reload', async ({ page }) => {
        page.on('pageerror', err => console.error('[Page error]', err.message));
        await setupPage(page);
        const { emptyEl, listEl } = await waitForFeed(page);
        if (await emptyEl.isVisible()) { test.skip(true, 'No posts in relay'); return; }
        const likeBtn = listEl.locator('[data-testid="feed-note"]').first().locator('[data-testid="like-btn"]');
        await expect(likeBtn).toBeVisible({ timeout: 10000 });
        if (!(await likeBtn.getAttribute('class'))?.includes('active-like')) {
            await likeBtn.click();
            await expect(likeBtn).toHaveClass(/active-like/, { timeout: 10000 });
        }
        await page.reload();
        await expect(page.locator('[data-testid="feed-tabs"]')).toBeVisible({ timeout: 15000 });
        await expect(listEl).toBeVisible({ timeout: 20000 });
        const likedBtn = listEl.locator('[data-testid="feed-note"]').first().locator('[data-testid="like-btn"]');
        await expect(likedBtn).toHaveClass(/active-like/, { timeout: 15000 });
    });

    test('like count persists after page reload', async ({ page }) => {
        page.on('pageerror', err => console.error('[Page error]', err.message));
        await setupPage(page);
        const { emptyEl, listEl } = await waitForFeed(page);
        if (await emptyEl.isVisible()) { test.skip(true, 'No posts in relay'); return; }

        const firstNote = listEl.locator('[data-testid="feed-note"]').first();
        const likeBtn = firstNote.locator('[data-testid="like-btn"]');
        await expect(likeBtn).toBeVisible({ timeout: 10000 });

        // Like the post if not already liked
        if (!(await likeBtn.getAttribute('class'))?.includes('active-like')) {
            await likeBtn.click();
            await expect(likeBtn).toHaveClass(/active-like/, { timeout: 10000 });
        }

        // Get the like count text after liking
        const countAfterLike = await likeBtn.locator('span').textContent();
        const likeCount = parseInt(countAfterLike) || 0;
        expect(likeCount).toBeGreaterThanOrEqual(1);

        // Reload and verify count persists (is not 0)
        await page.reload();
        await expect(page.locator('[data-testid="feed-tabs"]')).toBeVisible({ timeout: 15000 });
        await expect(listEl).toBeVisible({ timeout: 20000 });

        const reloadedNote = listEl.locator('[data-testid="feed-note"]').first();
        const reloadedLikeBtn = reloadedNote.locator('[data-testid="like-btn"]');
        await expect(reloadedLikeBtn).toHaveClass(/active-like/, { timeout: 15000 });

        // Wait for stats to load from relay, then check count is >= 1
        await expect(async () => {
            const countText = await reloadedLikeBtn.locator('span').textContent();
            const count = parseInt(countText) || 0;
            expect(count).toBeGreaterThanOrEqual(1);
        }).toPass({ timeout: 15000 });
    });
});
