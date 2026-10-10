/**
 * Playwright E2E for the BIES Cowork page (server-backed sessions, v2).
 *
 * Cowork moved from ephemeral Nostr check-ins to server-persisted, joinable,
 * titled sessions with attendance and a Past tab. This exercises that flow
 * against the real backend.
 *
 * Requires:
 *   - Backend server on port 3001
 *   - Vite dev server on port 5173
 */

import { test, expect } from '@playwright/test';
import { createTestUser } from './helpers/testUser.js';

const API = 'http://localhost:3001/api';

// ── Helpers ──────────────────────────────────────────────────────────

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

async function createSession(request, token, title, durationMinutes = 180) {
    const res = await request.post(`${API}/cowork/sessions`, {
        headers: { Authorization: `Bearer ${token}` },
        data: {
            title,
            locationName: 'Test Spot',
            lat: 13.49,
            lng: -89.32,
            durationMinutes,
            amenities: ['coffee'],
        },
    });
    expect(res.ok(), `Create session failed: ${res.status()}`).toBeTruthy();
    const body = await res.json();
    return body.session || body.data || body;
}

// ── Tests ────────────────────────────────────────────────────────────

test.describe('Cowork v2 - server-backed sessions', () => {
    test('page renders with Active and Past tabs', async ({ page, request }) => {
        const { token, user } = await register(request, 'Cowork Host');
        await injectAuth(page, token, user);
        await page.goto('/cowork');
        await expect(page.getByTestId('cowork-page')).toBeVisible();
        await expect(page.getByTestId('cowork-tab-active')).toBeVisible();
        await expect(page.getByTestId('cowork-tab-past')).toBeVisible();
    });

    test('a titled session appears as a clickable card and opens the detail modal', async ({ page, request }) => {
        const { token, user } = await register(request, 'Card Host');
        const s = await createSession(request, token, 'Deep Work Sprint');
        await injectAuth(page, token, user);
        await page.goto('/cowork');

        const card = page.getByTestId(`cowork-card-${s.id}`);
        await expect(card).toBeVisible();
        await expect(card).toContainText('Deep Work Sprint'); // title is the top line
        await expect(card).toContainText('attending');        // attendee count

        await card.click();
        const modal = page.getByTestId('cowork-session-modal');
        await expect(modal).toBeVisible();
        await expect(modal).toContainText('Deep Work Sprint');
    });

    test('another member can join a session and the count increments', async ({ page, request }) => {
        const host = await register(request, 'Join Host');
        const s = await createSession(request, host.token, 'Join Test Session');
        const joiner = await register(request, 'The Joiner');
        await injectAuth(page, joiner.token, joiner.user);
        await page.goto('/cowork');

        await page.getByTestId(`cowork-card-${s.id}`).click();
        await expect(page.getByTestId('cowork-session-modal')).toBeVisible();
        await expect(page.getByTestId('cowork-attendee-count')).toHaveText('1');

        await page.getByTestId('cowork-join-btn').click();
        await expect(page.getByTestId('cowork-attendee-count')).toHaveText('2');
        await expect(page.getByTestId('cowork-leave-btn')).toBeVisible();
    });

    test('a member can create a session through the check-in modal', async ({ page, request }) => {
        const { token, user } = await register(request, 'Creator');
        await injectAuth(page, token, user);
        await page.goto('/cowork');

        await page.getByTestId('cowork-checkin-btn').click();
        const title = `Modal Session ${Date.now()}`;
        await page.getByTestId('cowork-title-input').fill(title);

        // Add a fresh venue inline (starts empty), which auto-selects it.
        await page.getByTestId('cowork-venue-select').click();
        await page.getByTestId('cowork-add-venue-toggle').click();
        await page.getByTestId('cowork-add-venue-name').fill(`Spot ${Date.now()}`);
        await page.getByTestId('cowork-add-venue-area').fill('Test Area');
        await page.getByTestId('cowork-add-venue-submit').click();

        await page.getByTestId('cowork-submit').click();

        // Modal closes and the new titled session shows in the active list.
        await expect(page.getByTestId('cowork-list')).toContainText(title, { timeout: 10_000 });
    });

    test('ended sessions appear under the Past tab', async ({ page, request }) => {
        const host = await register(request, 'Past Host');
        const s = await createSession(request, host.token, 'Past Session Title');
        const endRes = await request.post(`${API}/cowork/sessions/${s.id}/end`, {
            headers: { Authorization: `Bearer ${host.token}` },
        });
        expect(endRes.ok(), `End failed: ${endRes.status()}`).toBeTruthy();

        await injectAuth(page, host.token, host.user);
        await page.goto('/cowork');
        await page.getByTestId('cowork-tab-past').click();

        const card = page.getByTestId(`cowork-card-${s.id}`);
        await expect(card).toBeVisible();
        await expect(card).toContainText('Past Session Title');
    });
});

// ── "Open with" maps chooser ─────────────────────────────────────────
// Availability is platform-inferred (web can't probe installed apps):
// Apple Maps on Apple devices, Google Maps everywhere, Waze on mobile.

async function openSessionMapChooser(page, request, name) {
    const { token, user } = await register(request, name);
    const s = await createSession(request, token, `${name} Session`);
    await injectAuth(page, token, user);
    await page.goto('/cowork');
    await page.getByTestId(`cowork-card-${s.id}`).click();
    await expect(page.getByTestId('cowork-session-modal')).toBeVisible();
    await page.getByTestId('cowork-map-open').click();
    await expect(page.getByTestId('maps-open-with-sheet')).toBeVisible();
}

test.describe('Cowork map "Open with" — iPhone', () => {
    test.use({
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    });

    test('shows Apple Maps, Google Maps and Waze', async ({ page, request }) => {
        await openSessionMapChooser(page, request, 'Iphone Chooser');
        await expect(page.getByTestId('maps-option-apple')).toBeVisible();
        await expect(page.getByTestId('maps-option-google')).toBeVisible();
        await expect(page.getByTestId('maps-option-waze')).toBeVisible();
    });

    test('picking Google Maps opens the maps URL and closes the sheet', async ({ page, request }) => {
        await page.addInitScript(() => {
            window.__openedUrls = [];
            window.open = (u) => { window.__openedUrls.push(String(u)); return null; };
        });
        await openSessionMapChooser(page, request, 'Iphone Picker');
        await page.getByTestId('maps-option-google').click();
        await expect(page.getByTestId('maps-open-with-sheet')).toHaveCount(0);
        const opened = await page.evaluate(() => window.__openedUrls);
        expect(opened.length).toBe(1);
        expect(opened[0]).toContain('google.com/maps');
        expect(opened[0]).toContain('13.49');
    });
});

test.describe('Cowork map "Open with" — Android', () => {
    test.use({
        userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36',
    });

    test('shows Google Maps and Waze but not Apple Maps', async ({ page, request }) => {
        await openSessionMapChooser(page, request, 'Android Chooser');
        await expect(page.getByTestId('maps-option-google')).toBeVisible();
        await expect(page.getByTestId('maps-option-waze')).toBeVisible();
        await expect(page.getByTestId('maps-option-apple')).toHaveCount(0);
    });
});
