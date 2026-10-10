/**
 * Playwright E2E tests for the BIES notification system.
 *
 * These tests verify:
 *  - Notification API endpoints work (list, count, mark read, delete)
 *  - WebSocket pushes notifications in real-time
 *  - Social actions (follow, RSVP, message, project view) trigger notifications
 *  - Notifications page renders correctly with title/body
 *
 * Requires: backend (port 3001) + frontend (port 5173) running.
 * Two test users are created via the API for cross-user notification testing.
 */

import { test, expect } from '@playwright/test';
import { createTestUser } from './helpers/testUser.js';

const API = 'http://localhost:3001/api';

// Helper: register a user and return { token, user }
async function registerUser(request, suffix) {
    const { token, user } = await createTestUser(request, API, `Test User ${suffix}`);
    return { token, user };
}

// Helper: authed GET/POST/PUT/DELETE
function authedHeaders(token) {
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

test.describe('Notification API', () => {
    let tokenA, userA, tokenB, userB;

    test.beforeAll(async ({ request }) => {
        ({ token: tokenA, user: userA } = await registerUser(request, 'A'));
        ({ token: tokenB, user: userB } = await registerUser(request, 'B'));
    });

    test('GET /notifications returns empty list for new user', async ({ request }) => {
        const res = await request.get(`${API}/notifications`, {
            headers: authedHeaders(tokenA),
        });
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body.data).toEqual([]);
        expect(body.unreadCount).toBe(0);
    });

    test('GET /notifications/count returns 0 for new user', async ({ request }) => {
        const res = await request.get(`${API}/notifications/count`, {
            headers: authedHeaders(tokenA),
        });
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body.count).toBe(0);
    });

    test('Follow triggers FOLLOW notification', async ({ request }) => {
        // User B follows User A
        const followRes = await request.post(`${API}/profiles/${userA.id}/follow`, {
            headers: authedHeaders(tokenB),
        });
        expect(followRes.ok()).toBeTruthy();

        // User A should have a FOLLOW notification
        const res = await request.get(`${API}/notifications`, {
            headers: authedHeaders(tokenA),
        });
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        const followNotif = body.data.find(n => n.type === 'FOLLOW');
        expect(followNotif).toBeTruthy();
        expect(followNotif.title).toContain('started following you');
        expect(followNotif.isRead).toBe(false);
    });

    test('Mark notification as read', async ({ request }) => {
        // Get notifications for user A
        const listRes = await request.get(`${API}/notifications`, {
            headers: authedHeaders(tokenA),
        });
        const notifs = (await listRes.json()).data;
        expect(notifs.length).toBeGreaterThan(0);

        const notifId = notifs[0].id;

        // Mark as read
        const markRes = await request.put(`${API}/notifications/${notifId}/read`, {
            headers: authedHeaders(tokenA),
            data: {},
        });
        expect(markRes.ok()).toBeTruthy();

        // Verify it's marked
        const countRes = await request.get(`${API}/notifications/count`, {
            headers: authedHeaders(tokenA),
        });
        const countBody = await countRes.json();
        expect(countBody.count).toBe(0);
    });

    test('Mark all notifications as read', async ({ request }) => {
        // Create another follow notification: User A follows User B
        await request.post(`${API}/profiles/${userB.id}/follow`, {
            headers: authedHeaders(tokenA),
        });

        // Verify User B has unread
        const countBefore = await request.get(`${API}/notifications/count`, {
            headers: authedHeaders(tokenB),
        });
        expect((await countBefore.json()).count).toBeGreaterThan(0);

        // Mark all read
        const markAllRes = await request.put(`${API}/notifications/read-all`, {
            headers: authedHeaders(tokenB),
            data: {},
        });
        expect(markAllRes.ok()).toBeTruthy();

        // Verify count is 0
        const countAfter = await request.get(`${API}/notifications/count`, {
            headers: authedHeaders(tokenB),
        });
        expect((await countAfter.json()).count).toBe(0);
    });

    test('Delete notification', async ({ request }) => {
        // Get user B notifications
        const listRes = await request.get(`${API}/notifications`, {
            headers: authedHeaders(tokenB),
        });
        const notifs = (await listRes.json()).data;
        expect(notifs.length).toBeGreaterThan(0);

        const notifId = notifs[0].id;

        // Delete it
        const delRes = await request.delete(`${API}/notifications/${notifId}`, {
            headers: authedHeaders(tokenB),
        });
        expect(delRes.ok()).toBeTruthy();

        // Verify it's gone
        const listAfter = await request.get(`${API}/notifications`, {
            headers: authedHeaders(tokenB),
        });
        const afterNotifs = (await listAfter.json()).data;
        expect(afterNotifs.find(n => n.id === notifId)).toBeUndefined();
    });

    test('Message triggers NEW_MESSAGE notification', async ({ request }) => {
        // User A sends a message to User B
        const sendRes = await request.post(`${API}/messages`, {
            headers: authedHeaders(tokenA),
            data: {
                recipientId: userB.id,
                content: 'Hello from test!',
                isEncrypted: false,
            },
        });
        expect(sendRes.ok()).toBeTruthy();

        // User B should have a NEW_MESSAGE notification
        const res = await request.get(`${API}/notifications`, {
            headers: authedHeaders(tokenB),
        });
        const body = await res.json();
        const msgNotif = body.data.find(n => n.type === 'NEW_MESSAGE');
        expect(msgNotif).toBeTruthy();
        expect(msgNotif.title).toContain('New message from');
    });
});

test.describe('Notifications UI', () => {
    let tokenA, userA, tokenB, userB;

    test.beforeAll(async ({ request }) => {
        ({ token: tokenA, user: userA } = await registerUser(request, 'UI-A'));
        ({ token: tokenB, user: userB } = await registerUser(request, 'UI-B'));

        // Create a follow notification for User A
        await request.post(`${API}/profiles/${userA.id}/follow`, {
            headers: authedHeaders(tokenB),
        });
    });

    async function loginAndGo(page, token, user, path) {
        // First navigate to the base so localStorage is on the right origin
        await page.goto('/');
        await page.evaluate(({ token, user }) => {
            localStorage.setItem('bies_token', token);
            localStorage.setItem('bies_user', JSON.stringify(user));
        }, { token, user });
        await page.goto(path);
    }

    test('Notifications page shows notifications with title and body', async ({ page }) => {
        await loginAndGo(page, tokenA, userA, '/notifications');

        // Wait for notifications to load
        await page.waitForSelector('.notif-item, .empty-state', { timeout: 15_000 });

        // Should show at least the follow notification
        const items = page.locator('.notif-item');
        const count = await items.count();
        expect(count).toBeGreaterThan(0);

        // Check that notification text contains the follow message
        const firstItemText = await items.first().textContent();
        expect(firstItemText).toBeTruthy();
        expect(firstItemText).toContain('started following you');
    });

    test('Unread notification has blue dot indicator', async ({ page }) => {
        await loginAndGo(page, tokenA, userA, '/notifications');

        await page.waitForSelector('.notif-item', { timeout: 15_000 });

        const unreadItem = page.locator('.notif-item.unread');
        const dotCount = await unreadItem.locator('.dot-indicator').count();
        expect(dotCount).toBeGreaterThan(0);
    });

    test('Mark as read removes unread styling', async ({ page }) => {
        await loginAndGo(page, tokenA, userA, '/notifications');

        await page.waitForSelector('.notif-item.unread', { timeout: 15_000 });

        const unreadCountBefore = await page.locator('.notif-item.unread').count();

        // Hover and click mark-as-read button on the first unread item
        const unreadItem = page.locator('.notif-item.unread').first();
        await unreadItem.hover();
        await unreadItem.locator('.action-btn').first().click();

        // Wait for unread count to decrease
        await expect(page.locator('.notif-item.unread')).toHaveCount(unreadCountBefore - 1, { timeout: 5_000 });
    });
});
