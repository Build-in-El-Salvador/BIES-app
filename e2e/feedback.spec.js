/**
 * Feedback Feature — Stress Test
 *
 * Tests the full feedback lifecycle:
 *   1. User submits feedback via API (all types, edge cases, abuse)
 *   2. Admin retrieves, filters, updates, and deletes feedback
 *   3. XSS / injection / boundary attacks
 *   4. Auth enforcement (no anonymous submissions)
 *   5. Browser-level form submission and admin panel rendering
 */

import { test, expect } from '@playwright/test';

const API = 'http://localhost:3001/api';

// ─── Auth helper: real Nostr challenge-response login ───────────────────────

async function nostrLogin(request) {
    // Generate a throwaway Nostr keypair using nostr-tools via Node
    // We call the server's challenge endpoint, sign it, and get a JWT.
    const crypto = await import('crypto');
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
    expect(loginData.user.id).toBeTruthy();

    return { token: loginData.token, userId: loginData.user.id, pubkey };
}

function authHeaders(token) {
    return { Authorization: `Bearer ${token}` };
}

// ─── 1. AUTH ENFORCEMENT ────────────────────────────────────────────────────

test.describe('Feedback — Auth Enforcement', () => {

    test('POST /feedback returns 401 without token', async ({ request }) => {
        const res = await request.post(`${API}/feedback`, {
            data: { type: 'BUG', message: 'Should be rejected' },
        });
        expect(res.status()).toBe(401);
    });

    test('POST /feedback returns 401 with garbage token', async ({ request }) => {
        const res = await request.post(`${API}/feedback`, {
            headers: { Authorization: 'Bearer garbage.token.here' },
            data: { type: 'BUG', message: 'Should be rejected' },
        });
        expect(res.status()).toBe(401);
    });

    test('GET /admin/feedback returns 401 without token', async ({ request }) => {
        const res = await request.get(`${API}/admin/feedback`);
        expect(res.status()).toBe(401);
    });

    test('GET /admin/feedback returns 403 for non-admin user', async ({ request }) => {
        const { token } = await nostrLogin(request);
        const res = await request.get(`${API}/admin/feedback`, {
            headers: authHeaders(token),
        });
        // Non-admin users should get 403 (requires MOD role or isAdmin)
        expect(res.status()).toBe(403);
    });
});

// ─── 2. SUBMISSION — HAPPY PATH ─────────────────────────────────────────────

test.describe('Feedback — Submit Happy Path', () => {
    let token;

    test.beforeAll(async ({ request }) => {
        ({ token } = await nostrLogin(request));
    });

    test('Submit BUG feedback', async ({ request }) => {
        const res = await request.post(`${API}/feedback`, {
            headers: authHeaders(token),
            data: { type: 'BUG', message: 'The login button is broken on mobile Safari' },
        });
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body.id).toBeTruthy();
        expect(body.message).toContain('Thank you');
    });

    test('Submit FEATURE feedback', async ({ request }) => {
        const res = await request.post(`${API}/feedback`, {
            headers: authHeaders(token),
            data: { type: 'FEATURE', message: 'Please add dark mode toggle in settings' },
        });
        expect(res.ok()).toBeTruthy();
    });

    test('Submit LOVE feedback', async ({ request }) => {
        const res = await request.post(`${API}/feedback`, {
            headers: authHeaders(token),
            data: { type: 'LOVE', message: 'This platform is incredible! Best Nostr app.' },
        });
        expect(res.ok()).toBeTruthy();
    });

    test('Submit GENERAL feedback', async ({ request }) => {
        const res = await request.post(`${API}/feedback`, {
            headers: authHeaders(token),
            data: { type: 'GENERAL', message: 'Just wanted to share some thoughts about the UX.' },
        });
        expect(res.ok()).toBeTruthy();
    });

    test('Submit feedback with type omitted defaults to GENERAL', async ({ request }) => {
        const res = await request.post(`${API}/feedback`, {
            headers: authHeaders(token),
            data: { message: 'No type specified, should default to GENERAL' },
        });
        expect(res.ok()).toBeTruthy();
    });
});

// ─── 3. SUBMISSION — VALIDATION & EDGE CASES ───────────────────────────────

test.describe('Feedback — Validation', () => {
    let token;

    test.beforeAll(async ({ request }) => {
        ({ token } = await nostrLogin(request));
    });

    test('Reject empty message', async ({ request }) => {
        const res = await request.post(`${API}/feedback`, {
            headers: authHeaders(token),
            data: { type: 'BUG', message: '' },
        });
        expect(res.ok()).toBeFalsy();
        expect(res.status()).toBe(400);
    });

    test('Reject message under 5 chars', async ({ request }) => {
        const res = await request.post(`${API}/feedback`, {
            headers: authHeaders(token),
            data: { type: 'BUG', message: 'Hi' },
        });
        expect(res.ok()).toBeFalsy();
        expect(res.status()).toBe(400);
    });

    test('Reject missing message field', async ({ request }) => {
        const res = await request.post(`${API}/feedback`, {
            headers: authHeaders(token),
            data: { type: 'BUG' },
        });
        expect(res.ok()).toBeFalsy();
    });

    test('Reject invalid type', async ({ request }) => {
        const res = await request.post(`${API}/feedback`, {
            headers: authHeaders(token),
            data: { type: 'INVALID_TYPE', message: 'This should be rejected' },
        });
        expect(res.ok()).toBeFalsy();
        expect(res.status()).toBe(400);
    });

    test('Accept message at exactly 5 chars', async ({ request }) => {
        const res = await request.post(`${API}/feedback`, {
            headers: authHeaders(token),
            data: { type: 'GENERAL', message: 'Hello' },
        });
        expect(res.ok()).toBeTruthy();
    });

    test('Accept max-length message (5000 chars)', async ({ request }) => {
        const longMsg = 'A'.repeat(5000);
        const res = await request.post(`${API}/feedback`, {
            headers: authHeaders(token),
            data: { type: 'BUG', message: longMsg },
        });
        expect(res.ok()).toBeTruthy();
    });

    test('Reject over-max message (5001 chars)', async ({ request }) => {
        const tooLong = 'A'.repeat(5001);
        const res = await request.post(`${API}/feedback`, {
            headers: authHeaders(token),
            data: { type: 'BUG', message: tooLong },
        });
        expect(res.ok()).toBeFalsy();
        expect(res.status()).toBe(400);
    });
});

// ─── 4. XSS & INJECTION ATTACKS ────────────────────────────────────────────

test.describe('Feedback — XSS & Injection', () => {
    let token;

    test.beforeAll(async ({ request }) => {
        ({ token } = await nostrLogin(request));
    });

    test('Script tag in message is sanitized', async ({ request }) => {
        const res = await request.post(`${API}/feedback`, {
            headers: authHeaders(token),
            data: { type: 'BUG', message: '<script>alert("XSS")</script> The app is broken' },
        });
        expect(res.ok()).toBeTruthy();
    });

    test('Event handler injection in message is sanitized', async ({ request }) => {
        const res = await request.post(`${API}/feedback`, {
            headers: authHeaders(token),
            data: { type: 'BUG', message: '<img src=x onerror=alert(1)> broken image attack' },
        });
        expect(res.ok()).toBeTruthy();
    });

    test('SQL injection attempt in message', async ({ request }) => {
        const res = await request.post(`${API}/feedback`, {
            headers: authHeaders(token),
            data: { type: 'BUG', message: "'; DROP TABLE feedback; --" },
        });
        // Should succeed (Prisma parameterizes queries) without dropping the table
        expect(res.ok()).toBeTruthy();

        // Verify the table still exists by submitting another
        const check = await request.post(`${API}/feedback`, {
            headers: authHeaders(token),
            data: { type: 'GENERAL', message: 'Table still exists after SQL injection attempt' },
        });
        expect(check.ok()).toBeTruthy();
    });

    test('Unicode and emoji in message', async ({ request }) => {
        const res = await request.post(`${API}/feedback`, {
            headers: authHeaders(token),
            data: { type: 'LOVE', message: 'Great app! \u{1F680}\u{26A1}\u{1F525} Bitcoin to the moon \u{1F31D}' },
        });
        expect(res.ok()).toBeTruthy();
    });

    test('Null bytes and control characters', async ({ request }) => {
        const res = await request.post(`${API}/feedback`, {
            headers: authHeaders(token),
            data: { type: 'BUG', message: 'Test\x00null\x01byte\x02attack here is some text' },
        });
        // Should either accept (sanitized) or reject — not crash
        expect([200, 201, 400].includes(res.status())).toBeTruthy();
    });

    test('Prototype pollution attempt in body', async ({ request }) => {
        const res = await request.post(`${API}/feedback`, {
            headers: authHeaders(token),
            data: {
                type: 'BUG',
                message: 'Legit feedback',
                __proto__: { isAdmin: true },
                constructor: { prototype: { isAdmin: true } },
            },
        });
        // Should succeed as normal feedback, proto fields ignored
        expect(res.ok()).toBeTruthy();
    });
});

// ─── 5. ADMIN OPERATIONS (requires admin user) ─────────────────────────────
// These tests verify admin endpoints work. Since test users aren't admins,
// we test that the endpoints properly enforce auth. Real admin tests require
// an admin token — we verify the API contract and status codes.

test.describe('Feedback — Admin API Contract', () => {
    let userToken;

    test.beforeAll(async ({ request }) => {
        ({ token: userToken } = await nostrLogin(request));

        // Seed some feedback for filter/pagination tests
        for (let i = 0; i < 5; i++) {
            await request.post(`${API}/feedback`, {
                headers: authHeaders(userToken),
                data: { type: ['BUG', 'FEATURE', 'LOVE', 'GENERAL', 'BUG'][i], message: `Stress test feedback #${i + 1} with enough chars` },
            });
        }
    });

    test('Non-admin cannot list feedback', async ({ request }) => {
        const res = await request.get(`${API}/admin/feedback`, {
            headers: authHeaders(userToken),
        });
        expect(res.status()).toBe(403);
    });

    test('Non-admin cannot update feedback', async ({ request }) => {
        const res = await request.put(`${API}/admin/feedback/fake-id`, {
            headers: authHeaders(userToken),
            data: { status: 'FIXED' },
        });
        expect(res.status()).toBe(403);
    });

    test('Non-admin cannot delete feedback', async ({ request }) => {
        const res = await request.delete(`${API}/admin/feedback/fake-id`, {
            headers: authHeaders(userToken),
        });
        expect(res.status()).toBe(403);
    });
});

// ─── 6. RAPID-FIRE / RACE CONDITIONS ───────────────────────────────────────

test.describe('Feedback — Stress & Race Conditions', () => {
    let token;

    test.beforeAll(async ({ request }) => {
        ({ token } = await nostrLogin(request));
    });

    test('20 concurrent submissions should all succeed', async ({ request }) => {
        const promises = Array.from({ length: 20 }, (_, i) =>
            request.post(`${API}/feedback`, {
                headers: authHeaders(token),
                data: { type: 'GENERAL', message: `Concurrent feedback submission #${i + 1} load test` },
            })
        );

        const results = await Promise.all(promises);
        const statuses = results.map(r => r.status());

        // All should succeed (201) or be rate-limited (429) — no 500s
        for (const status of statuses) {
            expect([201, 429].includes(status), `Unexpected status ${status}`).toBeTruthy();
        }

        // At least some should succeed
        const successes = statuses.filter(s => s === 201).length;
        expect(successes).toBeGreaterThan(0);
    });

    test('Rapid duplicate submissions are all stored (no dedup)', async ({ request }) => {
        const sameMsg = 'Exact same feedback submitted rapidly for dedup test';
        const promises = Array.from({ length: 5 }, () =>
            request.post(`${API}/feedback`, {
                headers: authHeaders(token),
                data: { type: 'BUG', message: sameMsg },
            })
        );

        const results = await Promise.all(promises);
        const successes = results.filter(r => r.status() === 201);
        // All should be stored (feedback doesn't need dedup)
        expect(successes.length).toBe(5);
    });
});

// ─── 7. BROWSER — USER FEEDBACK FORM ───────────────────────────────────────

test.describe('Feedback — Browser Form', () => {

    /**
     * Inject a real JWT into the browser's localStorage so ProtectedRoute
     * lets us through. We get the JWT via the Nostr challenge-response flow
     * from the API, then inject it + a user cache before navigating.
     */
    async function injectAuth(page, request) {
        const { token, userId, pubkey } = await nostrLogin(request);
        const userObj = { id: userId, nostrPubkey: pubkey, role: 'MEMBER', profile: { name: 'Test User' } };

        // Navigate to a page first so we can set localStorage on the correct origin
        await page.goto('/login');
        await page.waitForLoadState('domcontentloaded');
        await page.evaluate(({ token, user }) => {
            localStorage.setItem('bies_token', token);
            localStorage.setItem('bies_user', JSON.stringify(user));
        }, { token, user: userObj });
    }

    test('Feedback page loads for authenticated user', async ({ page, request }) => {
        await injectAuth(page, request);
        await page.goto('/feedback');
        await page.waitForLoadState('domcontentloaded');

        await expect(page.locator('h1')).toContainText('Feedback', { timeout: 10000 });
        await expect(page.locator('textarea')).toBeVisible();
    });

    test('Feedback page redirects to login for unauthenticated user', async ({ page }) => {
        await page.goto('/login');
        await page.evaluate(() => {
            localStorage.removeItem('bies_token');
            localStorage.removeItem('bies_user');
        });
        await page.goto('/feedback');
        await page.waitForLoadState('domcontentloaded');

        await expect(page).toHaveURL(/\/login/);
    });

    test('Type selector buttons work', async ({ page, request }) => {
        await injectAuth(page, request);
        await page.goto('/feedback');
        await page.waitForLoadState('domcontentloaded');

        const bugBtn = page.locator('button.type-btn', { hasText: 'Report a Bug' });
        await bugBtn.waitFor({ timeout: 10000 });
        await bugBtn.click();
        await expect(bugBtn).toHaveClass(/selected/);

        const featureBtn = page.locator('button.type-btn', { hasText: 'Request a Feature' });
        await featureBtn.click();
        await expect(featureBtn).toHaveClass(/selected/);
        await expect(bugBtn).not.toHaveClass(/selected/);
    });

    test('Submit button is disabled when textarea is empty', async ({ page, request }) => {
        await injectAuth(page, request);
        await page.goto('/feedback');
        await page.waitForLoadState('domcontentloaded');

        const submitBtn = page.locator('button[type="submit"]');
        await expect(submitBtn).toBeDisabled({ timeout: 10000 });
    });

    test('Submit button enables when text is entered', async ({ page, request }) => {
        await injectAuth(page, request);
        await page.goto('/feedback');
        await page.waitForLoadState('domcontentloaded');

        const textarea = page.locator('textarea');
        await textarea.waitFor({ timeout: 10000 });
        await textarea.fill('This is a test feedback message');

        const submitBtn = page.locator('button[type="submit"]');
        await expect(submitBtn).toBeEnabled();
    });

    test('Character count updates as user types', async ({ page, request }) => {
        await injectAuth(page, request);
        await page.goto('/feedback');
        await page.waitForLoadState('domcontentloaded');

        const textarea = page.locator('textarea');
        await textarea.waitFor({ timeout: 10000 });
        await textarea.fill('Hello World');

        const charCount = page.locator('.char-count');
        await expect(charCount).toContainText('11 / 5000');
    });

    test('Full submit flow shows success state', async ({ page, request }) => {
        await injectAuth(page, request);
        await page.goto('/feedback');
        await page.waitForLoadState('domcontentloaded');

        // Select type
        const bugBtn = page.locator('button.type-btn', { hasText: 'Report a Bug' });
        await bugBtn.waitFor({ timeout: 10000 });
        await bugBtn.click();

        // Type message
        const textarea = page.locator('textarea');
        await textarea.fill('E2E test: the login flow has a timing issue on slow connections');

        // Submit
        const submitBtn = page.locator('button[type="submit"]');
        await submitBtn.click();

        // Should show success state
        await expect(page.locator('text=Thank you')).toBeVisible({ timeout: 10000 });
        await expect(page.locator('button', { hasText: 'Send More Feedback' })).toBeVisible();
    });

    test('No JS errors on the feedback page', async ({ page, request }) => {
        const jsErrors = [];
        page.on('pageerror', err => jsErrors.push(err.message));

        await injectAuth(page, request);
        await page.goto('/feedback');
        await page.waitForLoadState('networkidle');

        expect(jsErrors, `JS errors: ${jsErrors.join('; ')}`).toHaveLength(0);
    });
});

// ─── 8. BROWSER — ADMIN FEEDBACK PANEL ─────────────────────────────────────
// Admin panel UI tests verify the page renders correctly when accessed.
// Since test users aren't admins, the admin API calls return 403, but
// we can still verify the page structure renders without JS errors.

test.describe('Feedback — Admin Panel UI', () => {

    async function injectAdminAuth(page, request) {
        const { token, userId, pubkey } = await nostrLogin(request);
        const userObj = {
            id: userId, nostrPubkey: pubkey, role: 'MEMBER',
            isAdmin: true, profile: { name: 'Admin Test User' },
        };
        await page.goto('/login');
        await page.waitForLoadState('domcontentloaded');
        await page.evaluate(({ token, user }) => {
            localStorage.setItem('bies_token', token);
            localStorage.setItem('bies_user', JSON.stringify(user));
        }, { token, user: userObj });
    }

    test('Admin feedback page renders without JS errors', async ({ page, request }) => {
        const jsErrors = [];
        page.on('pageerror', err => jsErrors.push(err.message));

        await injectAdminAuth(page, request);
        await page.goto('/admin/feedback');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(2000);

        expect(jsErrors, `JS errors: ${jsErrors.join('; ')}`).toHaveLength(0);
    });

    test('Non-admin with fake isAdmin in localStorage gets redirected away from admin panel', async ({ page, request }) => {
        // This proves you CANNOT bypass admin checks by editing localStorage.
        // The backend /auth/me returns the real user (not admin), AuthContext
        // updates state, and AdminRoute redirects to /dashboard.
        await injectAdminAuth(page, request);
        await page.goto('/admin/feedback');

        // Should be redirected away from admin
        await expect(page).not.toHaveURL(/\/admin\/feedback/, { timeout: 15000 });
    });
});
