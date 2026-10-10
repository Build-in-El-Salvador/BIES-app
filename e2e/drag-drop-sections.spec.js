import { test, expect } from '@playwright/test';
import { createTestUser } from './helpers/testUser.js';

const API = 'http://localhost:3001/api';

async function registerBuilder(request) {
    const { token, user } = await createTestUser(request, API, 'DragTest User');
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
 * Simulate HTML5 drag-and-drop between two elements using dispatchEvent.
 * Playwright's built-in dragTo doesn't reliably fire HTML5 DnD events.
 */
async function html5DragDrop(page, srcLocator, dstLocator) {
    const srcBox = await srcLocator.boundingBox();
    const dstBox = await dstLocator.boundingBox();

    await page.evaluate(({ srcSel, dstSel }) => {
        function fireEvent(el, type, dataTransfer) {
            const event = new DragEvent(type, {
                bubbles: true,
                cancelable: true,
                dataTransfer,
            });
            el.dispatchEvent(event);
        }

        const src = document.querySelectorAll('[draggable="true"]')[srcSel];
        const dst = document.querySelectorAll('[draggable="true"]')[dstSel];

        const dt = new DataTransfer();
        dt.setData('text/plain', String(srcSel));

        fireEvent(src, 'dragstart', dt);
        fireEvent(dst, 'dragover', dt);
        fireEvent(dst, 'drop', dt);
        fireEvent(src, 'dragend', dt);
    }, {
        srcSel: await getSectionIndex(page, srcLocator),
        dstSel: await getSectionIndex(page, dstLocator),
    });
}

async function getSectionIndex(page, locator) {
    const allSections = page.locator('[draggable="true"]');
    const count = await allSections.count();
    const targetBox = await locator.boundingBox();
    for (let i = 0; i < count; i++) {
        const box = await allSections.nth(i).boundingBox();
        if (box && targetBox && Math.abs(box.y - targetBox.y) < 5) return i;
    }
    return 0;
}

test.describe('Drag and Drop Sections', () => {

    test('Create Event - drag sections to reorder', async ({ page, request }) => {
        const { token, user } = await registerBuilder(request);
        await injectAuth(page, token, user);

        await page.goto('/events/create');
        await page.waitForTimeout(1500);

        // Scroll to custom sections area and add 3 sections
        await page.evaluate(() => window.scrollTo(0, 999999));
        await page.waitForTimeout(300);

        await page.locator('button', { hasText: '+ Text' }).first().click();
        await page.waitForTimeout(300);
        await page.locator('button', { hasText: '+ Photo' }).first().click();
        await page.waitForTimeout(300);
        await page.locator('button', { hasText: '+ Carousel' }).first().click();
        await page.waitForTimeout(500);

        // Scroll to see all sections
        await page.evaluate(() => window.scrollTo(0, 999999));
        await page.waitForTimeout(500);

        const sections = page.locator('[draggable="true"]');
        const sectionCount = await sections.count();
        console.log(`Draggable sections: ${sectionCount}`);
        expect(sectionCount).toBeGreaterThanOrEqual(3);

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

        await page.screenshot({ path: 'e2e/screenshots/before-drag.png' });

        // Drag section 0 (Text) to section 2 (Carousel) using HTML5 DnD events
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

            // Fire dragover on intermediate items too for live reorder
            fireEvent(items[1], 'dragover', dt);
            fireEvent(dst, 'dragover', dt);
            fireEvent(dst, 'drop', dt);
            fireEvent(src, 'dragend', dt);
        });

        await page.waitForTimeout(1000);

        await page.screenshot({ path: 'e2e/screenshots/after-drag.png' });

        const afterLabels = await getLabels();
        console.log('After drag:', afterLabels);

        // Text section should have moved - order should be different
        expect(afterLabels).not.toEqual(beforeLabels);
        // Text should now be at position 2 (or Photo at position 0)
        expect(afterLabels[0]).toContain('PHOTO');

        console.log('Drag and drop reorder successful!');

        // Now test dragging back up: drag the last item (Text) to first position
        const midLabels = await getLabels();
        console.log('Before drag-up:', midLabels);

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
            const src = items[2]; // Last item (Text)
            const dst = items[0]; // First position

            const dt = new DataTransfer();
            dt.setData('text/plain', '2');
            dt.effectAllowed = 'move';

            fireEvent(src, 'dragstart', dt);
            fireEvent(items[1], 'dragover', dt);
            fireEvent(dst, 'dragover', dt);
            fireEvent(dst, 'drop', dt);
            fireEvent(src, 'dragend', dt);
        });

        await page.waitForTimeout(1000);

        const finalLabels = await getLabels();
        console.log('After drag-up:', finalLabels);

        // Should be back to original order
        expect(finalLabels[0]).toContain('TEXT');
        expect(finalLabels[2]).toContain('CAROUSEL');

        console.log('Drag up reorder successful!');

        await page.screenshot({ path: 'e2e/screenshots/final-state.png' });
        await page.waitForTimeout(2000);
    });
});
