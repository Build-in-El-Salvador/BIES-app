/**
 * Playwright E2E for the BIES built-in Wallet page (/wallet).
 *
 * UI-state tests only — no external wallet APIs (Coinos/Blink/NWC relays) are
 * ever called: a fresh account has no wallet, so the page stays in its
 * not-connected state and the connect flows are asserted at the UI level.
 *
 * Requires: backend on 3001, vite on 5173.
 */

import { test, expect } from '@playwright/test';
import { createTestUser } from './helpers/testUser.js';

const API = 'http://localhost:3001/api';

async function register(request, name) {
    const { token, user } = await createTestUser(request, API, name);
    return { token, user };
}

async function injectAuth(page, token, user) {
    await page.goto('/');
    await page.evaluate(({ token, user }) => {
        localStorage.setItem('bies_token', token);
        localStorage.setItem('bies_user', JSON.stringify(user));
    }, { token, user });
}

test.describe('Built-in Wallet page', () => {
    test('renders the not-connected state with create + connect paths', async ({ page, request }) => {
        const { token, user } = await register(request, 'Wallet Fresh');
        await injectAuth(page, token, user);
        await page.goto('/wallet');

        await expect(page.getByTestId('wallet-page')).toBeVisible();
        // Two paths: instant BIES wallet (Coinos) + connect-your-own
        await expect(page.getByTestId('wallet-create-card')).toBeVisible();
        await expect(page.getByTestId('wallet-create-username')).toBeVisible();
        await expect(page.getByTestId('wallet-create-btn')).toBeVisible();
        await expect(page.getByTestId('wallet-connect-card')).toBeVisible();
    });

    test('connect card offers NWC and the Blink API option', async ({ page, request }) => {
        const { token, user } = await register(request, 'Wallet Options');
        await injectAuth(page, token, user);
        await page.goto('/wallet');

        const connectCard = page.getByTestId('wallet-connect-card');
        await expect(connectCard).toBeVisible();
        // The embedded WalletConnect flow mentions both Blink and NWC paths.
        await expect(connectCard).toContainText(/blink/i);
        await expect(connectCard).toContainText(/nostr wallet connect|nwc/i);
    });

    test('send/receive/balance are not shown while disconnected', async ({ page, request }) => {
        const { token, user } = await register(request, 'Wallet Gated');
        await injectAuth(page, token, user);
        await page.goto('/wallet');

        await expect(page.getByTestId('wallet-page')).toBeVisible();
        await expect(page.getByTestId('wallet-send-btn')).toHaveCount(0);
        await expect(page.getByTestId('wallet-receive-btn')).toHaveCount(0);
        await expect(page.getByTestId('wallet-balance')).toHaveCount(0);
    });

    test('wallet page is registered in the navbar customizer', async ({ page, request }) => {
        const { token, user } = await register(request, 'Wallet Nav');
        await injectAuth(page, token, user);
        await page.goto('/settings/navbar');

        // The wallet page appears as a draggable icon (grid or dock).
        await expect(page.locator('[data-page-id="wallet"]').first()).toBeVisible();
    });
});
