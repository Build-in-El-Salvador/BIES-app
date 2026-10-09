/**
 * Playwright E2E tests for BIES Nostr feed functionality.
 * Tests the landing page SocialPulse and the authenticated Feed page
 * with Private/Public relay tab switching.
 */

import { test, expect } from '@playwright/test';
import { createTestUser } from './helpers/testUser.js';

const API = 'http://localhost:3001/api';
const BASE = '';

// ── Helpers ──────────────────────────────────────────────────────────

async function registerUser(request, suffix) {
    return createTestUser(request, API, `FeedTest ${suffix}`);
}

async function injectAuth(page, token, user, skHex) {
    if (skHex) {
        await page.addInitScript(({ skHex }) => {
            window.__TEST_NSEC_HEX = skHex;
        }, { skHex });
    }
    await page.goto(`${BASE}/`);
    await page.evaluate(({ token, user }) => {
        localStorage.setItem('bies_token', token);
        localStorage.setItem('bies_user', JSON.stringify(user));
        localStorage.setItem('bies_login_method', 'nsec');
    }, { token, user });
}

// ── 1. Landing Page - SocialPulse ────────────────────────────────────

test.describe('Landing Page - Social Pulse', () => {

    test('SocialPulse section renders with cards', async ({ page }) => {
        const jsErrors = [];
        page.on('pageerror', err => jsErrors.push(err.message));

        await page.goto(`${BASE}/`);

        // Wait for the social pulse section to appear (live or mock data)
        const grid = page.locator('[data-testid="social-pulse-grid"]');
        await expect(grid).toBeVisible({ timeout: 20000 });

        // Should have cards rendered
        const cards = page.locator('[data-testid="social-pulse-card"]');
        const count = await cards.count();
        expect(count).toBeGreaterThan(0);

        // Cards should have content
        const firstCard = cards.first();
        await expect(firstCard).toContainText(/.+/);

        expect(jsErrors, `JS errors on landing: ${jsErrors.join('; ')}`).toHaveLength(0);
    });

    test('SocialPulse cards show user names and content', async ({ page }) => {
        await page.goto(`${BASE}/`);

        const grid = page.locator('[data-testid="social-pulse-grid"]');
        await expect(grid).toBeVisible({ timeout: 20000 });

        const cards = page.locator('[data-testid="social-pulse-card"]');
        const count = await cards.count();

        for (let i = 0; i < count; i++) {
            const card = cards.nth(i);
            // Each card should have visible text content
            const text = await card.textContent();
            expect(text.length).toBeGreaterThan(10);
        }
    });
});

// ── 2. Feed Page - Tabs & Rendering ─────────────────────────────────

test.describe('Feed Page - Authenticated', () => {
    let token, user, skHex;

    test.beforeAll(async ({ request }) => {
        ({ token, user, skHex } = await registerUser(request, 'feed'));
    });

    test('Feed page loads with Private/Public tabs', async ({ page }) => {
        const jsErrors = [];
        page.on('pageerror', err => jsErrors.push(err.message));

        await injectAuth(page, token, user, skHex);
        await page.goto(`${BASE}/feed`);

        // Feed tabs should be visible
        const tabs = page.locator('[data-testid="feed-tabs"]');
        await expect(tabs).toBeVisible({ timeout: 10000 });

        // Private tab should exist and be active by default
        const privateTab = page.locator('[data-testid="tab-private"]');
        await expect(privateTab).toBeVisible();
        await expect(privateTab).toHaveClass(/active/);

        // Explore tab should exist but not active
        const publicTab = page.locator('[data-testid="tab-explore"]');
        await expect(publicTab).toBeVisible();

        expect(jsErrors, `JS errors on feed: ${jsErrors.join('; ')}`).toHaveLength(0);
    });

    test('Feed page shows compose box with textarea and post button', async ({ page }) => {
        await injectAuth(page, token, user, skHex);
        await page.goto(`${BASE}/feed`);

        const composeInput = page.locator('[data-testid="compose-input"]');
        await expect(composeInput).toBeVisible({ timeout: 10000 });

        const postBtn = page.locator('[data-testid="post-btn"]');
        await expect(postBtn).toBeVisible();

        // Post button should be disabled when input is empty
        await expect(postBtn).toBeDisabled();

        // Type something and post button should become enabled
        await composeInput.fill('Test post from Playwright');
        await expect(postBtn).toBeEnabled();
    });

    test('Private tab loads posts from BIES relay', async ({ page }) => {
        await injectAuth(page, token, user, skHex);
        await page.goto(`${BASE}/feed`);

        // Should initially show loading
        const loadingEl = page.locator('[data-testid="feed-loading"]');
        const emptyEl = page.locator('[data-testid="feed-empty"]');
        const listEl = page.locator('[data-testid="feed-list"]');

        // Wait for either loading, empty state, or posts to appear
        await expect(loadingEl.or(emptyEl).or(listEl)).toBeVisible({ timeout: 10000 });

        // Private relay should have events (seeded by test setup) — expect posts
        await expect(listEl).toBeVisible({ timeout: 20000 });

        const notes = page.locator('[data-testid="feed-note"]');
        const count = await notes.count();
        expect(count).toBeGreaterThan(0);
    });

    test('Switching to Public tab loads real posts from public relays', async ({ page }) => {
        const jsErrors = [];
        page.on('pageerror', err => jsErrors.push(err.message));

        await injectAuth(page, token, user, skHex);
        await page.goto(`${BASE}/feed`);

        // Wait for tabs
        const publicTab = page.locator('[data-testid="tab-explore"]');
        await expect(publicTab).toBeVisible({ timeout: 10000 });

        // Click Public tab
        await publicTab.click();

        // Public tab should now be active
        await expect(publicTab).toHaveClass(/active/);

        // Private tab should no longer be active
        const privateTab = page.locator('[data-testid="tab-private"]');
        await expect(privateTab).not.toHaveClass(/active/);

        // Should show loading for public relays
        const loadingText = page.locator('text=Connecting to public relays');
        const emptyEl = page.locator('[data-testid="feed-empty"]');
        const listEl = page.locator('[data-testid="feed-list"]');

        // Wait for loading, empty, or posts
        await expect(loadingText.or(emptyEl).or(listEl)).toBeVisible({ timeout: 10000 });

        // Public feed should load real posts from public relays (no #bies filter)
        await expect(listEl).toBeVisible({ timeout: 30000 });

        // Should have actual feed notes
        const notes = page.locator('[data-testid="feed-note"]');
        await expect(notes.first()).toBeVisible({ timeout: 10000 });
        const count = await notes.count();
        expect(count).toBeGreaterThan(0);

        expect(jsErrors, `JS errors on public feed: ${jsErrors.join('; ')}`).toHaveLength(0);
    });

    test('Switching between tabs clears and reloads posts', async ({ page }) => {
        await injectAuth(page, token, user, skHex);
        await page.goto(`${BASE}/feed`);

        const privateTab = page.locator('[data-testid="tab-private"]');
        const publicTab = page.locator('[data-testid="tab-explore"]');
        await expect(privateTab).toBeVisible({ timeout: 10000 });

        // Switch to public
        await publicTab.click();
        await expect(publicTab).toHaveClass(/active/);

        // Switch back to private
        await privateTab.click();
        await expect(privateTab).toHaveClass(/active/);

        // Should show loading or content - no crash
        const loadingEl = page.locator('[data-testid="feed-loading"]');
        const emptyEl = page.locator('[data-testid="feed-empty"]');
        const listEl = page.locator('[data-testid="feed-list"]');
        await expect(loadingEl.or(emptyEl).or(listEl)).toBeVisible({ timeout: 10000 });
    });
});

// ── 3. Feed Page - Unauthenticated Redirect ─────────────────────────

test.describe('Feed Page - Unauthenticated', () => {

    test('Redirects to login when not authenticated', async ({ page }) => {
        await page.goto(`${BASE}/feed`);
        await page.waitForLoadState('networkidle');

        const url = page.url();
        expect(url).toContain('/login');
    });
});

// ── 4. Page Stability ────────────────────────────────────────────────

test.describe('Feed Stability - No JS Crashes', () => {
    let token, user;

    test.beforeAll(async ({ request }) => {
        ({ token, user } = await registerUser(request, 'stability'));
    });

    test('No uncaught errors on feed page', async ({ page }) => {
        const jsErrors = [];
        page.on('pageerror', err => jsErrors.push(err.message));

        await injectAuth(page, token, user, skHex);
        await page.goto(`${BASE}/feed`);
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(3000);

        expect(jsErrors, `Uncaught JS errors: ${jsErrors.join('; ')}`).toHaveLength(0);
    });

    test('No uncaught errors on landing page with SocialPulse', async ({ page }) => {
        const jsErrors = [];
        page.on('pageerror', err => jsErrors.push(err.message));

        await page.goto(`${BASE}/`);
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(3000);

        expect(jsErrors, `Uncaught JS errors: ${jsErrors.join('; ')}`).toHaveLength(0);
    });
});
