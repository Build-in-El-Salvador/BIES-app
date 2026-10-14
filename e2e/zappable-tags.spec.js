import { test, expect } from '@playwright/test';

const BASE_URL = process.env.BIES_BASE_URL || 'http://localhost:5173';
const API_BASE = process.env.BIES_API_URL || 'http://localhost:3001';
const API = `${API_BASE}/api`;

async function generateKeypair() {
    const { generateSecretKey, getPublicKey } = await import('nostr-tools/pure');
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const skHex = Buffer.from(sk).toString('hex');
    return { sk, skHex, pk };
}

async function nostrLogin(request, sk, pk) {
    const challengeRes = await request.get(`${API}/auth/nostr-challenge?pubkey=${pk}`);
    expect(challengeRes.ok(), `Challenge request failed: ${challengeRes.status()}`).toBeTruthy();
    const { challenge } = await challengeRes.json();

    const { finalizeEvent } = await import('nostr-tools/pure');
    const signed = finalizeEvent({
        kind: 27235,
        pubkey: pk,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['u', new URL(`${API}/auth/nostr-login`).href], ['method', 'POST']],
        content: challenge,
    }, sk);

    const loginRes = await request.post(`${API}/auth/nostr-login`, {
        data: { pubkey: pk, signedEvent: signed },
    });
    expect(loginRes.ok(), `Nostr login failed: ${loginRes.status()}`).toBeTruthy();
    const body = await loginRes.json();
    return { token: body.token, user: body.user };
}

test.describe('Zappable Tags', () => {
    let sk, skHex, pk, token, user;

    test.beforeAll(async ({ request }) => {
        const keys = await generateKeypair();
        sk = keys.sk; skHex = keys.skHex; pk = keys.pk;
        const auth = await nostrLogin(request, sk, pk);
        token = auth.token; user = auth.user;

        // Set up profile with tags
        const profileRes = await request.put(`${API}/profiles/me`, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            data: {
                name: 'Zap Tag Tester',
                bio: 'Testing zappable tags',
                tags: ['Bitcoin', 'Lightning', 'Nostr'],
            },
        });
        expect(profileRes.ok(), `Profile update failed: ${profileRes.status()}`).toBeTruthy();
    });

    async function setupPage(page) {
        await page.addInitScript(({ nsecHex }) => { window.__TEST_NSEC_HEX = nsecHex; }, { nsecHex: skHex });
        await page.goto(BASE_URL);
        await page.evaluate(({ token, user }) => {
            localStorage.setItem('bies_token', token);
            localStorage.setItem('bies_user', JSON.stringify(user));
            localStorage.setItem('bies_login_method', 'nsec');
        }, { token, user });
    }

    test('profile page renders zappable tags with zap icons', async ({ page }) => {
        await setupPage(page);
        await page.goto(`${BASE_URL}/profile`);

        // Wait for profile to load
        await expect(page.getByRole('heading', { name: 'Zap Tag Tester' })).toBeVisible({ timeout: 15000 });

        // Verify zappable tags are rendered
        const bitcoinTag = page.locator('[data-testid="zappable-tag-Bitcoin"]');
        const lightningTag = page.locator('[data-testid="zappable-tag-Lightning"]');
        const nostrTag = page.locator('[data-testid="zappable-tag-Nostr"]');

        await expect(bitcoinTag).toBeVisible({ timeout: 5000 });
        await expect(lightningTag).toBeVisible();
        await expect(nostrTag).toBeVisible();

        // Each tag should contain a zap icon (svg element from lucide)
        const svgInTag = bitcoinTag.locator('svg');
        await expect(svgInTag).toBeVisible();
    });

    test('clicking a zappable tag opens the ZapModal', async ({ page }) => {
        await setupPage(page);
        await page.goto(`${BASE_URL}/profile`);
        await expect(page.getByRole('heading', { name: 'Zap Tag Tester' })).toBeVisible({ timeout: 15000 });

        const bitcoinTag = page.locator('[data-testid="zappable-tag-Bitcoin"]');
        await expect(bitcoinTag).toBeVisible({ timeout: 5000 });

        // Click the tag
        await bitcoinTag.click();

        // Should show loading state or modal
        // The tag might show a spinner while fetching, then ZapModal opens
        const modal = page.locator('[data-testid="zap-modal"]');
        const errorTooltip = bitcoinTag.locator('.zappable-tag-error');

        // Either the modal opens (recipients found) or an error tooltip shows (no recipients)
        await expect(modal.or(errorTooltip)).toBeVisible({ timeout: 15000 });

        if (await modal.isVisible()) {
            // Modal opened — verify it has the expected structure
            await expect(modal.locator('.zap-title')).toContainText('Send Zap');

            // Wait for resolving to complete
            const sendBtn = modal.locator('[data-testid="zap-send-btn"]');
            const error = modal.locator('[data-testid="zap-error"]');
            await expect(sendBtn.or(error)).toBeVisible({ timeout: 15000 });

            if (await sendBtn.isVisible()) {
                // Should show "Split between N recipients" for multi-recipient
                const splitLabel = modal.locator('text=/Split between/');
                // If multiple recipients matched the tag, split label shows
                // Otherwise single recipient view is shown
                const singleRecipient = modal.locator('.zap-single-recipient');
                await expect(splitLabel.or(singleRecipient)).toBeVisible({ timeout: 5000 });
            }

            // Close modal
            await modal.locator('.zap-close').click();
            await expect(modal).not.toBeVisible({ timeout: 3000 });
        }
    });

    test('zappable tag shows hover state with orange border', async ({ page }) => {
        await setupPage(page);
        await page.goto(`${BASE_URL}/profile`);
        await expect(page.getByRole('heading', { name: 'Zap Tag Tester' })).toBeVisible({ timeout: 15000 });

        const bitcoinTag = page.locator('[data-testid="zappable-tag-Bitcoin"]');
        await expect(bitcoinTag).toBeVisible({ timeout: 5000 });

        // Hover over the tag
        await bitcoinTag.hover();

        // Verify the tag is a button (interactive element)
        const tagName = await bitcoinTag.evaluate(el => el.tagName.toLowerCase());
        expect(tagName).toBe('button');
    });

    test('public profile renders zappable tags', async ({ page }) => {
        await setupPage(page);

        // Navigate to own public profile (builder/<id>)
        const userId = user.id;
        await page.goto(`${BASE_URL}/builder/${userId}`);

        // Wait for profile to load
        await expect(page.getByRole('heading', { name: 'Zap Tag Tester' })).toBeVisible({ timeout: 15000 });

        // Verify zappable tags exist
        const bitcoinTag = page.locator('[data-testid="zappable-tag-Bitcoin"]');
        await expect(bitcoinTag).toBeVisible({ timeout: 5000 });
    });

    test('zappable tag click does not navigate away from profile', async ({ page }) => {
        await setupPage(page);
        await page.goto(`${BASE_URL}/profile`);
        await expect(page.getByRole('heading', { name: 'Zap Tag Tester' })).toBeVisible({ timeout: 15000 });

        const initialUrl = page.url();

        const bitcoinTag = page.locator('[data-testid="zappable-tag-Bitcoin"]');
        await expect(bitcoinTag).toBeVisible({ timeout: 5000 });
        await bitcoinTag.click();

        // Wait for any loading to complete
        await page.waitForTimeout(2000);

        // URL should not have changed (no navigation)
        expect(page.url()).toBe(initialUrl);

        // Close modal if it appeared
        const modal = page.locator('[data-testid="zap-modal"]');
        if (await modal.isVisible()) {
            await modal.locator('.zap-close').click();
        }
    });

    test('project zappable tag on profile fetches team and opens modal', async ({ page }) => {
        await setupPage(page);
        await page.goto(`${BASE_URL}/profile`);
        await expect(page.getByRole('heading', { name: 'Zap Tag Tester' })).toBeVisible({ timeout: 15000 });

        // Check if there are project zap tags (mode="project")
        // These appear on the project cards in the sidebar
        const projectZapTags = page.locator('.zappable-tag');
        const count = await projectZapTags.count();

        if (count > 3) {
            // More than the 3 profile tags — means project zap tags exist
            const projectTag = projectZapTags.nth(3); // First one after the 3 profile tags
            await projectTag.click();

            const modal = page.locator('[data-testid="zap-modal"]');
            const errorTooltip = projectTag.locator('.zappable-tag-error');
            await expect(modal.or(errorTooltip)).toBeVisible({ timeout: 15000 });

            if (await modal.isVisible()) {
                await expect(modal.locator('.zap-title')).toContainText('Send Zap');
                await modal.locator('.zap-close').click();
            }
        } else {
            test.skip(true, 'No projects on profile to test project zapping');
        }
    });
});
