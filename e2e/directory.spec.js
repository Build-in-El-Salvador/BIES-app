/**
 * E2E test: the Farm Directory and BIES Trusted, each on its own page
 *
 * Run with the repo default config (boots the API on :3001 and vite on :5173,
 * reusing already-running servers):
 *   npx playwright test e2e/directory.spec.js
 *
 * Covers:
 *  - /farms renders the section header, search input, and add button
 *  - links from before the move (/discover/farms, /discover/certified) redirect
 *  - /discover no longer carries the directory cards, and keeps its 2 tabs
 *  - a member's listing goes live at once and lands on its own page
 *  - desktop /trusted renders the BIES Trusted section header
 */

import { test, expect } from '@playwright/test';
import { createTestUser } from './helpers/testUser.js';

const API = 'http://localhost:3001/api';

async function registerUser(request) {
    const { token, user } = await createTestUser(request, API, `DirTest ${Date.now()}`);
    return { token, user };
}

async function loginAs(page, token) {
    await page.goto('/');
    await page.evaluate((t) => {
        localStorage.setItem('bies_token', t);
    }, token);
}

test.describe('Directories', () => {
    let token;
    let user;

    test.beforeAll(async ({ request }) => {
        const registered = await registerUser(request);
        token = registered.token;
        user = registered.user;
    });

    test('mobile: farm directory renders header, search, and add button', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await loginAs(page, token);
        await page.goto('/farms');
        await page.waitForLoadState('networkidle');

        // Section header with title + subtitle
        const header = page.locator('.dir-section-header');
        await expect(header).toBeVisible();
        await expect(header).toContainText('Regenerative Farms');

        // Search input with farm placeholder
        const search = page.locator('input[placeholder="Search farms, products, or locations"]');
        await expect(search).toBeVisible();

        // Add-listing button available to members
        await expect(page.locator('.directory-add-btn')).toBeVisible();

        await page.screenshot({ path: 'e2e/screenshots/directory-farms-mobile.png', fullPage: false });
    });

    test('links from before the move redirect to the new pages', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await loginAs(page, token);
        await page.goto('/discover/farms');
        await expect(page).toHaveURL(/\/farms$/);
        await page.goto('/discover/certified');
        await expect(page).toHaveURL(/\/trusted$/);
        await page.goto('/discover/directory/new?type=provider');
        await expect(page).toHaveURL(/\/trusted\/new$/);
    });

    test('mobile: /discover has its 2 tabs and no directory cards', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await loginAs(page, token);
        await page.goto('/discover');
        await page.waitForLoadState('networkidle');

        const tabs = page.locator('.discover-mobile-tabs .discover-tab');
        await expect(tabs).toHaveCount(2);
        await expect(page.locator('.directory-entry-card')).toHaveCount(0);
    });

    test("submit flow: a member's farm goes live at once on its own page", async ({ page, request }) => {
        const listingName = `E2E Test Farm ${Date.now()}`;

        await page.setViewportSize({ width: 390, height: 844 });
        await loginAs(page, token);
        await page.goto('/farms/new');
        await page.waitForLoadState('networkidle');

        // Their own farm, so no review is needed; name it and submit
        await page.getByText("It's my farm, or I work there").click();
        const nameInput = page.locator('input[name="name"]');
        await expect(nameInput).toBeVisible();
        await nameInput.fill(listingName);
        await page.getByRole('button', { name: 'Submit Listing' }).click();

        // Lands on the live listing
        await expect(page).toHaveURL(/\/farms\/[a-z0-9]+$/, { timeout: 10_000 });
        await expect(page.getByRole('heading', { name: listingName })).toBeVisible();

        // And it's in the public list
        const publicRes = await request.get(`${API}/directory?type=FARM&search=${encodeURIComponent(listingName)}`);
        expect(publicRes.ok()).toBeTruthy();
        const publicBody = await publicRes.json();
        const live = (publicBody.data || []).find((l) => l.name === listingName);
        expect(live, 'the new farm should be listed').toBeTruthy();
        expect(live.status).toBe('active');
        expect(live.ownerId).toBe(user.id);
    });

    test('desktop: BIES Trusted renders its section header', async ({ page }) => {
        await page.setViewportSize({ width: 1280, height: 800 });
        await loginAs(page, token);
        await page.goto('/trusted');
        await page.waitForLoadState('networkidle');

        const header = page.locator('.dir-section-header');
        await expect(header).toBeVisible();
        await expect(header).toContainText('BIES Trusted');

        await page.screenshot({ path: 'e2e/screenshots/directory-trusted-desktop.png', fullPage: false });
    });
});
