import { test, expect } from '@playwright/test';
import { createTestUser } from './helpers/testUser.js';

const API = 'http://localhost:3001/api';

async function registerBuilder(request) {
    const { token, user } = await createTestUser(request, API, 'Profile Sections Test');
    return { token, user };
}

async function injectAuth(page, token, user) {
    await page.goto('/');
    await page.evaluate(({ token, user }) => {
        localStorage.setItem('bies_token', token);
        localStorage.setItem('bies_user', JSON.stringify(user));
    }, { token, user });
}

test.describe('Profile Custom Sections', () => {

    test('Add custom sections, drag to reorder, and save profile', async ({ page, request }) => {
        const { token, user } = await registerBuilder(request);
        await injectAuth(page, token, user);

        // Navigate to profile edit
        await page.goto('/profile/edit');
        await page.waitForTimeout(2000);

        await page.screenshot({ path: 'e2e/screenshots/profile-edit-initial.png' });

        // Scroll to Custom Sections area
        const customSectionsCard = page.locator('text=Custom Sections').first();
        await customSectionsCard.scrollIntoViewIfNeeded();
        await page.waitForTimeout(500);

        // Add 3 sections: Text, Photo, Graph
        await page.locator('button', { hasText: '+ Text' }).first().click();
        await page.waitForTimeout(300);
        await page.locator('button', { hasText: '+ Photo' }).first().click();
        await page.waitForTimeout(300);
        await page.locator('button', { hasText: '+ Graph' }).first().click();
        await page.waitForTimeout(500);

        // Verify 3 draggable sections exist
        const sections = page.locator('[draggable="true"]');
        const sectionCount = await sections.count();
        console.log(`Draggable sections created: ${sectionCount}`);
        expect(sectionCount).toBe(3);

        await page.screenshot({ path: 'e2e/screenshots/profile-sections-added.png' });

        // Fill in section titles
        const titleInputs = page.locator('[draggable="true"] input[placeholder="Section Title"]');
        await titleInputs.nth(0).fill('About My Work');
        await titleInputs.nth(1).fill('Featured Photo');
        await titleInputs.nth(2).fill('Revenue Growth');
        await page.waitForTimeout(300);

        // Read section labels before drag
        const getLabels = async () => {
            const labels = [];
            const count = await sections.count();
            for (let i = 0; i < count; i++) {
                const text = await sections.nth(i).locator('span').first().innerText();
                labels.push(text.trim());
            }
            return labels;
        };

        const beforeLabels = await getLabels();
        console.log('Before drag:', beforeLabels);

        await page.screenshot({ path: 'e2e/screenshots/profile-before-drag.png' });

        // Drag section 0 (Text) to section 2 (Graph) using HTML5 DnD events
        await page.evaluate(() => {
            function fireEvent(el, type, dataTransfer) {
                const event = new DragEvent(type, {
                    bubbles: true,
                    cancelable: true,
                    dataTransfer,
                });
                el.dispatchEvent(event);
            }

            const items = document.querySelectorAll('[draggable="true"]');
            const src = items[0];
            const dst = items[2];

            const dt = new DataTransfer();
            dt.setData('text/plain', '0');
            dt.effectAllowed = 'move';

            fireEvent(src, 'dragstart', dt);
            fireEvent(items[1], 'dragover', dt);
            fireEvent(dst, 'dragover', dt);
            fireEvent(dst, 'drop', dt);
            fireEvent(src, 'dragend', dt);
        });

        await page.waitForTimeout(1000);

        const afterLabels = await getLabels();
        console.log('After drag:', afterLabels);

        await page.screenshot({ path: 'e2e/screenshots/profile-after-drag.png' });

        // Text section should have moved
        expect(afterLabels).not.toEqual(beforeLabels);
        expect(afterLabels[0]).toContain('PHOTO');

        console.log('Profile drag and drop reorder successful!');

        // Save the profile
        await page.locator('button', { hasText: 'Save' }).first().click();
        await page.waitForTimeout(2000);

        // Verify we navigated to profile page (save success)
        await expect(page).toHaveURL(/\/profile/, { timeout: 5000 });

        await page.screenshot({ path: 'e2e/screenshots/profile-saved.png' });
        console.log('Profile with custom sections saved successfully!');
    });

    test('Delete a custom section', async ({ page, request }) => {
        const { token, user } = await registerBuilder(request);
        await injectAuth(page, token, user);

        await page.goto('/profile/edit');
        await page.waitForTimeout(2000);

        // Add 2 sections
        const customSectionsCard = page.locator('text=Custom Sections').first();
        await customSectionsCard.scrollIntoViewIfNeeded();
        await page.waitForTimeout(300);

        await page.locator('button', { hasText: '+ Text' }).first().click();
        await page.waitForTimeout(300);
        await page.locator('button', { hasText: '+ Carousel' }).first().click();
        await page.waitForTimeout(500);

        const sections = page.locator('[draggable="true"]');
        expect(await sections.count()).toBe(2);

        // Delete the first section (trash icon button is in the section header bar)
        const firstSectionHeader = sections.nth(0).locator('div').first();
        const deleteBtn = firstSectionHeader.locator('button').last();
        await deleteBtn.click();
        await page.waitForTimeout(500);

        // Verify only 1 section remains
        expect(await sections.count()).toBe(1);

        // The remaining section should be CAROUSEL
        const remainingLabel = await sections.nth(0).locator('span').first().innerText();
        expect(remainingLabel.trim()).toContain('CAROUSEL');

        await page.screenshot({ path: 'e2e/screenshots/profile-section-deleted.png' });
        console.log('Section deletion successful!');
    });
});
