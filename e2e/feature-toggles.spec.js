import { test, expect } from '@playwright/test';
import { createTestUser } from './helpers/testUser.js';

// Override for isolated verification runs; defaults match the dev stack.
const API = process.env.BIES_E2E_API || 'http://localhost:3001/api';

test.use({ viewport: { width: 1280, height: 900 } });

async function registerBuilder(request) {
    const { token, user } = await createTestUser(request, API, 'Flags Test User');
    return { token, user };
}

async function injectAuth(page, token, user) {
    await page.goto('/');
    await page.evaluate(({ token, user }) => {
        localStorage.setItem('bies_token', token);
        localStorage.setItem('bies_user', JSON.stringify(user));
    }, { token, user });
}

/** Stub the public flags endpoint so UI gating can be tested without admin DB access. */
async function stubFlags(page, flags) {
    await page.route('**/api/flags', (route) =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(flags),
        })
    );
}

test.describe('Runtime feature toggles', () => {

    test('GET /api/flags is public and defaults every slug to enabled', async ({ request }) => {
        const res = await request.get(`${API}/flags`);
        expect(res.status()).toBe(200);
        const flags = await res.json();
        for (const slug of ['directories', 'points', 'events', 'media', 'news', 'messages', 'zaps', 'feedback', 'investors', 'projects', 'cowork']) {
            expect(flags[slug], `${slug} should default enabled`).toBe(true);
        }
    });

    test('PUT /api/admin/flags rejects anonymous and non-admin callers', async ({ request }) => {
        // Anonymous → 401
        const anon = await request.put(`${API}/admin/flags`, { data: { points: false } });
        expect(anon.status()).toBe(401);

        // Regular authenticated user → 403 (and the flag must NOT change)
        const { token } = await registerBuilder(request);
        const nonAdmin = await request.put(`${API}/admin/flags`, {
            data: { points: false },
            headers: { Authorization: `Bearer ${token}` },
        });
        expect(nonAdmin.status()).toBe(403);

        const after = await (await request.get(`${API}/flags`)).json();
        expect(after.points).toBe(true);
    });

    test('disabling `points` hides the leaderboard nav link and 404s the route', async ({ page, request }) => {
        const { token, user } = await registerBuilder(request);
        await stubFlags(page, { points: false });
        await injectAuth(page, token, user);

        await page.goto('/feed');
        await expect(page.locator('.desktop-links')).toBeVisible();
        // Trophy/leaderboard link gone; a core link is still there.
        await expect(page.locator('.desktop-links a[href="/leaderboard"]')).toHaveCount(0);
        await expect(page.locator('.desktop-links a[href="/discover"]')).toBeVisible();

        // Route renders the standard 404 page.
        await page.goto('/leaderboard');
        await expect(page.getByText(/404|not found/i).first()).toBeVisible();
    });

    test('all-enabled flags keep the leaderboard visible (control)', async ({ page, request }) => {
        const { token, user } = await registerBuilder(request);
        await stubFlags(page, { points: true });
        await injectAuth(page, token, user);

        await page.goto('/feed');
        await expect(page.locator('.desktop-links a[href="/leaderboard"]')).toBeVisible();
    });

    test('disabled features are excluded from the mobile bottom nav, even when customized', async ({ page, request }) => {
        const { token, user } = await registerBuilder(request);
        await stubFlags(page, { events: false, media: false });
        await injectAuth(page, token, user);

        // Customize the dock to include a disabled feature id before load.
        await page.evaluate(() => {
            localStorage.setItem('bies_bottom_nav', JSON.stringify(['feed', 'events', 'media', 'dashboard']));
        });

        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto('/feed');

        await expect(page.getByTestId('bottom-nav-feed')).toBeVisible();
        await expect(page.getByTestId('bottom-nav-dashboard')).toBeVisible();
        await expect(page.getByTestId('bottom-nav-events')).toHaveCount(0);
        await expect(page.getByTestId('bottom-nav-media')).toHaveCount(0);

        // The stored preference is untouched — re-enabling restores the tabs.
        const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('bies_bottom_nav')));
        expect(stored).toContain('events');
    });

    test('fail-open: a broken flags endpoint never hides the app', async ({ page, request }) => {
        const { token, user } = await registerBuilder(request);
        await page.route('**/api/flags', (route) => route.fulfill({ status: 500, body: '{}' }));
        await injectAuth(page, token, user);

        await page.goto('/feed');
        await expect(page.locator('.desktop-links a[href="/leaderboard"]')).toBeVisible();
        await expect(page.locator('.desktop-links a[href="/events"]')).toBeVisible();
    });
});
