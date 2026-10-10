/**
 * E2E test: Farm & Certified Provider directories
 *
 * Run with the repo default config (boots the API on :3001 and vite on :5173,
 * reusing already-running servers):
 *   npx playwright test e2e/directory.spec.js
 *
 * Covers:
 *  - /discover/farms renders the section header, search input, and add button
 *  - the Discover bottom-nav tab is active on /discover/farms (rgb(255,91,0))
 *  - /discover still shows exactly 2 mobile tabs (Projects/Members untouched)
 *  - member submit flow: form submission lands as pending-review and is
 *    excluded from the public list while visible to the owner
 *  - desktop /discover/certified renders the certified section header
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
        await page.goto('/discover/farms');
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

    test('mobile: Discover bottom-nav tab is active on /discover/farms', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await loginAs(page, token);
        await page.goto('/discover/farms');
        await page.waitForLoadState('networkidle');

        const discoverTab = page.locator('.mobile-bottom-nav a[href="/discover"]');
        await expect(discoverTab).toBeVisible();
        const color = await discoverTab.evaluate((el) => getComputedStyle(el).color);
        expect(color).toBe('rgb(255, 91, 0)');
    });

    test('mobile: /discover still has exactly 2 tabs', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await loginAs(page, token);
        await page.goto('/discover');
        await page.waitForLoadState('networkidle');

        const tabs = page.locator('.discover-mobile-tabs .discover-tab');
        await expect(tabs).toHaveCount(2);
    });

    test('submit flow: member submission is pending and hidden from public list', async ({ page, request }) => {
        const listingName = `E2E Test Farm ${Date.now()}`;

        await page.setViewportSize({ width: 390, height: 844 });
        await loginAs(page, token);
        await page.goto('/discover/directory/new?type=farm');
        await page.waitForLoadState('networkidle');

        // Fill the name field (first input in the basic-info card) and submit
        const nameInput = page.locator('.dir-form-card .dir-input').first();
        await expect(nameInput).toBeVisible();
        await nameInput.fill(listingName);
        await page.getByRole('button', { name: 'Submit Listing' }).click();

        // Confirmation screen: submitted for review
        await expect(page.getByText('submitted for review')).toBeVisible({ timeout: 10_000 });
        await page.screenshot({ path: 'e2e/screenshots/directory-submit-confirmation.png', fullPage: false });

        // Public list (unauthenticated) must NOT include the pending listing
        const publicRes = await request.get(`${API}/directory?type=FARM&search=${encodeURIComponent(listingName)}`);
        expect(publicRes.ok()).toBeTruthy();
        const publicBody = await publicRes.json();
        expect((publicBody.data || []).some((l) => l.name === listingName)).toBeFalsy();

        // Owner sees their own submission with pending-review status
        const ownRes = await request.get(
            `${API}/directory?type=FARM&ownerId=${user.id}&search=${encodeURIComponent(listingName)}`,
            { headers: { Authorization: `Bearer ${token}` } }
        );
        expect(ownRes.ok()).toBeTruthy();
        const ownBody = await ownRes.json();
        const mine = (ownBody.data || []).find((l) => l.name === listingName);
        expect(mine, 'owner should see their pending listing').toBeTruthy();
        expect(mine.status).toBe('pending-review');
    });

    test('desktop: certified directory renders section header', async ({ page }) => {
        await page.setViewportSize({ width: 1280, height: 800 });
        await loginAs(page, token);
        await page.goto('/discover/certified');
        await page.waitForLoadState('networkidle');

        const header = page.locator('.dir-section-header');
        await expect(header).toBeVisible();
        await expect(header).toContainText('BIES Certified Professionals');

        await page.screenshot({ path: 'e2e/screenshots/directory-certified-desktop.png', fullPage: false });
    });
});
