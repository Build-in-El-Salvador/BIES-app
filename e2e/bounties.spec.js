/**
 * E2E smoke test: Bounty board
 *
 * Run with the repo default config (boots the API on :3001 and vite on :5173,
 * reusing already-running servers):
 *   npx playwright test e2e/bounties.spec.js
 *
 * Covers:
 *  - auth enforcement + server-side amount limit / points-escrow enforcement (API)
 *  - /bounties renders header, filter tabs, and the create CTA
 *  - /bounties/new renders the reward toggle (SATS/POINTS), per-type amount
 *    limits, and fires client-side validation without submitting
 *  - /bounties/:id renders a SATS bounty (created via API — POINTS bounties
 *    need a seeded points balance, which test users don't have) and a second
 *    user can open the submission form and submit work
 *
 * NOTE: bounty i18n keys are not in en.json yet, so assertions use structural
 * selectors (class names from the Bounties/CreateBounty/BountyDetail pages)
 * rather than translated text.
 */

import { test, expect } from '@playwright/test';

// Override with BIES_E2E_API to point at an isolated test stack.
const API = process.env.BIES_E2E_API || 'http://localhost:3001/api';

// ─── Auth helper: real Nostr challenge-response login ───────────────────────

async function nostrLogin(request) {
    const { getPublicKey, finalizeEvent, generateSecretKey } = await import('nostr-tools/pure');

    const sk = generateSecretKey();
    const pubkey = getPublicKey(sk);

    // Step 1: Get challenge
    const challengeRes = await request.get(`${API}/auth/nostr-challenge?pubkey=${pubkey}`);
    expect(challengeRes.ok(), `Challenge request failed: ${challengeRes.status()}`).toBeTruthy();
    const { challenge } = await challengeRes.json();
    expect(challenge).toBeTruthy();

    // Step 2: Sign the challenge
    const signedEvent = finalizeEvent({
        kind: 27235,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['u', new URL(`${API}/auth/nostr-login`).href], ['method', 'POST']],
        content: challenge,
    }, sk);

    // Step 3: Submit signed event to get JWT
    const loginRes = await request.post(`${API}/auth/nostr-login`, {
        data: { pubkey, signedEvent, fingerprint: null },
    });
    expect(loginRes.ok(), `Nostr login failed: ${loginRes.status()}`).toBeTruthy();
    const loginData = await loginRes.json();
    expect(loginData.token).toBeTruthy();

    return { token: loginData.token, userId: loginData.user.id, pubkey };
}

function authHeaders(token) {
    return { Authorization: `Bearer ${token}` };
}

/**
 * Inject a real JWT into the browser's localStorage so ProtectedRoute
 * lets us through (same pattern as feedback.spec.js).
 */
async function injectAuth(page, { token, userId, pubkey }) {
    const userObj = { id: userId, nostrPubkey: pubkey, role: 'MEMBER', profile: { name: 'Bounty Test User' } };
    await page.goto('/login');
    await page.waitForLoadState('domcontentloaded');
    await page.evaluate(({ token, user }) => {
        localStorage.setItem('bies_token', token);
        localStorage.setItem('bies_user', JSON.stringify(user));
    }, { token, user: userObj });
}

// ─── 1. API — AUTH & LIMIT ENFORCEMENT ──────────────────────────────────────

test.describe('Bounties — API smoke', () => {
    let token;

    test.beforeAll(async ({ request }) => {
        ({ token } = await nostrLogin(request));
    });

    test('GET /bounties returns 401 without token', async ({ request }) => {
        const res = await request.get(`${API}/bounties`);
        expect(res.status()).toBe(401);
    });

    test('POST /bounties returns 401 without token', async ({ request }) => {
        const res = await request.post(`${API}/bounties`, {
            data: { title: 'Should be rejected', description: 'No auth', rewardType: 'SATS', amount: 1000 },
        });
        expect(res.status()).toBe(401);
    });

    test('Reject POINTS amount below min (5)', async ({ request }) => {
        const res = await request.post(`${API}/bounties`, {
            headers: authHeaders(token),
            data: { title: 'Too small points bounty', description: 'Limit test', rewardType: 'POINTS', amount: 4 },
        });
        expect(res.status()).toBe(400);
    });

    test('Reject SATS amount outside 100–1,000,000 range', async ({ request }) => {
        const below = await request.post(`${API}/bounties`, {
            headers: authHeaders(token),
            data: { title: 'Too small sats bounty', description: 'Limit test', rewardType: 'SATS', amount: 99 },
        });
        expect(below.status()).toBe(400);

        const above = await request.post(`${API}/bounties`, {
            headers: authHeaders(token),
            data: { title: 'Too big sats bounty', description: 'Limit test', rewardType: 'SATS', amount: 1000001 },
        });
        expect(above.status()).toBe(400);
    });

    test('Reject POINTS bounty when balance is insufficient (escrow-at-post)', async ({ request }) => {
        // Fresh test users have no points, so an in-range POINTS bounty
        // must still be rejected by the escrow check.
        const res = await request.post(`${API}/bounties`, {
            headers: authHeaders(token),
            data: { title: 'Unfunded points bounty', description: 'Escrow test', rewardType: 'POINTS', amount: 50 },
        });
        expect(res.status()).toBe(400);
    });
});

// ─── 2. BROWSER — LIST, CREATE FORM, DETAIL ─────────────────────────────────

test.describe('Bounties — Browser smoke', () => {
    let auth;

    test.beforeAll(async ({ request }) => {
        auth = await nostrLogin(request);
    });

    test('list page renders header, filter tabs, and create CTA', async ({ page }) => {
        const jsErrors = [];
        page.on('pageerror', err => jsErrors.push(err.message));

        await injectAuth(page, auth);
        await page.goto('/bounties');
        await page.waitForLoadState('domcontentloaded');

        await expect(page.locator('.bounties-page')).toBeVisible({ timeout: 15000 });
        await expect(page.locator('h1.bounties-title')).toBeVisible();

        // 5 filter tabs for a logged-in user (all/open/awarded/paid/mine)
        await expect(page.locator('.bounties-tabs .bounties-tab')).toHaveCount(5, { timeout: 10000 });

        // Create CTA links to the new-bounty form
        await expect(page.locator('a.bounties-create-btn[href="/bounties/new"]')).toBeVisible();

        // Loading resolves into either the list or the empty state
        await expect(page.locator('.bounties-list, .bounties-empty').first()).toBeVisible({ timeout: 15000 });

        // Clicking a filter tab activates it
        const openTab = page.locator('.bounties-tabs .bounties-tab').nth(1);
        await openTab.click();
        await expect(openTab).toHaveClass(/active/);

        const relevantErrors = jsErrors.filter(e => !e.includes('ResizeObserver'));
        expect(relevantErrors, `JS errors: ${relevantErrors.join('; ')}`).toHaveLength(0);
    });

    test('create form renders with SATS default and per-type amount limits', async ({ page }) => {
        await injectAuth(page, auth);
        await page.goto('/bounties/new');
        await page.waitForLoadState('domcontentloaded');

        await expect(page.locator('.create-bounty-page')).toBeVisible({ timeout: 15000 });

        // Reward toggle: SATS active by default
        const satsBtn = page.locator('button.reward-type-btn.sats');
        const pointsBtn = page.locator('button.reward-type-btn.points');
        await expect(satsBtn).toBeVisible({ timeout: 10000 });
        await expect(satsBtn).toHaveClass(/active/);
        await expect(pointsBtn).not.toHaveClass(/active/);

        // SATS limits on the amount input
        const amountInput = page.locator('input[type="number"].create-bounty-input');
        await expect(amountInput).toHaveAttribute('min', '100');
        await expect(amountInput).toHaveAttribute('max', '1000000');

        // Toggling to POINTS swaps the limits
        await pointsBtn.click();
        await expect(pointsBtn).toHaveClass(/active/);
        await expect(satsBtn).not.toHaveClass(/active/);
        await expect(amountInput).toHaveAttribute('min', '5');
        await expect(amountInput).toHaveAttribute('max', '10000');

        // Title, description, and optional deadline fields render
        await expect(page.locator('input[type="text"].create-bounty-input')).toBeVisible();
        await expect(page.locator('textarea.create-bounty-input')).toBeVisible();
        await expect(page.locator('input[type="date"].create-bounty-input')).toBeVisible();
    });

    test('create form validation blocks out-of-range amounts without submitting', async ({ page }) => {
        let createPosted = false;
        page.on('request', req => {
            if (req.method() === 'POST' && req.url().includes('/api/bounties')) createPosted = true;
        });

        await injectAuth(page, auth);
        await page.goto('/bounties/new');
        await page.waitForLoadState('domcontentloaded');
        await expect(page.locator('.create-bounty-page')).toBeVisible({ timeout: 15000 });

        await page.locator('input[type="text"].create-bounty-input').fill('E2E validation bounty');
        await page.locator('textarea.create-bounty-input').fill('Client-side limit enforcement smoke test.');

        // SATS (default): below min (100) fires the amount-range error
        const amountInput = page.locator('input[type="number"].create-bounty-input');
        await amountInput.fill('4');
        const postBtn = page.locator('.create-bounty-actions .btn-primary');
        await postBtn.click();
        await expect(page.locator('.create-bounty-error')).toBeVisible({ timeout: 10000 });
        await expect(page).toHaveURL(/\/bounties\/new/);

        // SATS: above max (1,000,000) fires it too
        await amountInput.fill('2000000');
        await postBtn.click();
        await expect(page.locator('.create-bounty-error')).toBeVisible({ timeout: 10000 });
        await expect(page).toHaveURL(/\/bounties\/new/);

        // POINTS: fresh users have zero spendable balance, so the
        // escrow-at-post guard disables submit entirely (can't even try).
        await page.locator('button.reward-type-btn.points').click();
        await amountInput.fill('10');
        await expect(postBtn).toBeDisabled();

        // Validation is client-side: nothing was POSTed
        expect(createPosted).toBe(false);
    });

    test('detail page renders a SATS bounty and a second user can submit work', async ({ page, request }) => {
        // Create a SATS bounty via API (no points balance required)
        const title = `E2E SATS bounty ${Date.now()}`;
        const createRes = await request.post(`${API}/bounties`, {
            headers: authHeaders(auth.token),
            data: {
                title,
                description: 'Smoke-test bounty: reproduce the flaky login and attach steps.',
                rewardType: 'SATS',
                amount: 1500,
            },
        });
        expect(createRes.status(), `Create failed: ${createRes.status()}`).toBe(201);
        const bounty = await createRes.json();
        expect(bounty.id).toBeTruthy();

        // A second (non-poster) user views the detail page
        const hunter = await nostrLogin(request);
        await injectAuth(page, hunter);
        await page.goto(`/bounties/${bounty.id}`);
        await page.waitForLoadState('domcontentloaded');

        await expect(page.locator('.bounty-detail-page')).toBeVisible({ timeout: 15000 });
        await expect(page.locator('h1.bounty-detail-title')).toHaveText(title, { timeout: 10000 });
        await expect(page.locator('.bounty-reward.sats')).toBeVisible();
        await expect(page.locator('.bounty-status.open')).toBeVisible();
        await expect(page.locator('a.bounty-back-link[href="/bounties"]')).toBeVisible();

        // Open the submission form
        const submitWorkBtn = page.locator('.bounty-submissions-head .bounty-btn.primary');
        await expect(submitWorkBtn).toBeVisible({ timeout: 10000 });
        await submitWorkBtn.click();

        const textarea = page.locator('.bounty-textarea');
        await expect(textarea).toBeVisible({ timeout: 10000 });

        // Send is disabled until there is content
        const sendBtn = page.locator('.bounty-form-actions .bounty-btn.primary');
        await expect(sendBtn).toBeDisabled();
        await textarea.fill('E2E submission: reproduced on Chromium 138, steps attached.');
        await expect(sendBtn).toBeEnabled();
        await sendBtn.click();

        // Submission lands in the list and the form closes
        await expect(page.locator('.bounty-submission')).toHaveCount(1, { timeout: 15000 });
        await expect(textarea).toBeHidden({ timeout: 10000 });
    });
});
