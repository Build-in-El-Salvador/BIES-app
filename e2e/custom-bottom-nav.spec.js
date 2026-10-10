import { test, expect } from '@playwright/test';
import { createTestUser } from './helpers/testUser.js';

const API = 'http://localhost:3001/api';
const STORAGE_KEY = 'bies_bottom_nav';
const DEFAULT_TABS = ['feed', 'discover', 'events', 'media', 'dashboard'];

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

async function registerBuilder(request) {
    const { token, user } = await createTestUser(request, API, 'NavTest User');
    return { token, user };
}

async function injectAuth(page, token, user) {
    await page.goto('/');
    await page.evaluate(({ token, user }) => {
        localStorage.setItem('bies_token', token);
        localStorage.setItem('bies_user', JSON.stringify(user));
    }, { token, user });
}

/**
 * Drive the Pointer Events drag primitive (usePointerDrag) with the mouse:
 * press at the source center, move 12px to cross the 8px activation
 * threshold, glide to the destination center in steps, then release.
 * (No HTML5 DragEvent synthesis — the customizer doesn't use HTML5 DnD.)
 */
async function pointerDrag(page, srcSel, dstSel) {
    const src = page.locator(srcSel);
    const dst = page.locator(dstSel);
    await src.scrollIntoViewIfNeeded();
    await dst.scrollIntoViewIfNeeded();

    const srcBox = await src.boundingBox();
    const dstBox = await dst.boundingBox();
    expect(srcBox, `No bounding box for ${srcSel}`).toBeTruthy();
    expect(dstBox, `No bounding box for ${dstSel}`).toBeTruthy();

    const sx = srcBox.x + srcBox.width / 2;
    const sy = srcBox.y + srcBox.height / 2;

    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx + 12, sy + 12); // cross the 8px activation threshold

    // The floating ghost confirms the drag is active before we glide to the target.
    await expect(page.getByTestId('drag-ghost')).toBeVisible();

    await page.mouse.move(dstBox.x + dstBox.width / 2, dstBox.y + dstBox.height / 2, { steps: 15 });
    await page.mouse.up();
    await page.waitForTimeout(400); // let React commit + eviction FLIP settle
}

async function openCustomizer(page, request) {
    const { token, user } = await registerBuilder(request);
    await injectAuth(page, token, user);
    await page.goto('/settings/navbar');
    await expect(page.getByTestId('nav-dock')).toBeVisible({ timeout: 15000 });
    // Default dock is fully populated before any customization.
    await expect(page.getByTestId('dock-icon-feed')).toBeVisible();
    await expect(page.getByTestId('dock-icon-dashboard')).toBeVisible();
}

async function storedTabs(page) {
    return page.evaluate((key) => JSON.parse(localStorage.getItem(key)), STORAGE_KEY);
}

test.describe('Customizable bottom navbar', () => {

    test('drag a grid icon into the full dock evicts the rightmost tab', async ({ page, request }) => {
        await openCustomizer(page, request);

        await expect(page.getByTestId('grid-icon-news')).toBeVisible();

        await pointerDrag(page, '[data-testid="grid-icon-news"]', '[data-testid="nav-dock"]');

        await expect(page.getByTestId('dock-icon-news')).toBeVisible();
        // Rightmost default tab (dashboard) was evicted back to the grid.
        await expect(page.getByTestId('grid-icon-dashboard')).toBeVisible();
        await expect(page.getByTestId('dock-icon-dashboard')).toHaveCount(0);

        const stored = await storedTabs(page);
        expect(stored).toHaveLength(5);
        expect(stored).toContain('news');
        expect(stored).not.toContain('dashboard');
    });

    test('drag a dock icon out to the grid removes it', async ({ page, request }) => {
        await openCustomizer(page, request);

        await expect(page.getByTestId('dock-icon-media')).toBeVisible();

        await pointerDrag(page, '[data-testid="dock-icon-media"]', '[data-testid="grid-icon-news"]');

        await expect(page.getByTestId('grid-icon-media')).toBeVisible();
        await expect(page.getByTestId('dock-icon-media')).toHaveCount(0);

        const stored = await storedTabs(page);
        expect(stored).toHaveLength(4);
        expect(stored).not.toContain('media');
    });

    test('reset restores the default tabs', async ({ page, request }) => {
        await openCustomizer(page, request);

        // Customize first so reset has something to undo.
        await pointerDrag(page, '[data-testid="grid-icon-news"]', '[data-testid="nav-dock"]');
        expect(await storedTabs(page)).toContain('news');

        await page.getByTestId('nav-reset').click();
        await page.waitForTimeout(300);

        expect(await storedTabs(page)).toEqual(DEFAULT_TABS);
        await expect(page.getByTestId('dock-icon-dashboard')).toBeVisible();
        await expect(page.getByTestId('grid-icon-news')).toBeVisible();
    });

    test('MobileBottomNav renders the customized tabs on /feed', async ({ page, request }) => {
        await openCustomizer(page, request);

        await pointerDrag(page, '[data-testid="grid-icon-news"]', '[data-testid="nav-dock"]');
        await expect(page.getByTestId('dock-icon-news')).toBeVisible();

        await page.goto('/feed');
        await expect(page.getByTestId('bottom-nav-news')).toBeVisible({ timeout: 15000 });
        await expect(page.getByTestId('bottom-nav-dashboard')).toHaveCount(0);
    });

    test('customization persists across reload', async ({ page, request }) => {
        await openCustomizer(page, request);

        await pointerDrag(page, '[data-testid="grid-icon-news"]', '[data-testid="nav-dock"]');
        const stored = await storedTabs(page);
        expect(stored).toHaveLength(5);
        expect(stored).toContain('news');

        await page.reload();
        await expect(page.getByTestId('nav-dock')).toBeVisible({ timeout: 15000 });
        await expect(page.getByTestId('dock-icon-news')).toBeVisible();

        const domOrder = await page
            .locator('[data-testid="nav-dock"] [data-page-id]')
            .evaluateAll((els) => els.map((el) => el.getAttribute('data-page-id')));
        expect(domOrder).toEqual(stored);
    });
});
