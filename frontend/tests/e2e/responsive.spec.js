import { expect, test } from '@playwright/test';
import {
  addFilesToQueue,
  collectPageErrors,
  filePayload,
} from './helpers.js';

const WIDTHS = [360, 390, 430, 768, 1024, 1440];

async function expectNoHorizontalOverflow(page) {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    bodyScrollWidth: document.body.scrollWidth,
  }));

  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
  expect(metrics.bodyScrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
}

test.describe('Twindrop responsive layout', () => {
  test('home page and modals fit every target width', async ({ page }) => {
    const errors = collectPageErrors(page);
    await page.goto('/');
    await addFilesToQueue(page, [
      filePayload('responsive-one.txt', 'responsive one'),
      filePayload('responsive-two.txt', 'responsive two'),
    ]);

    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await expectNoHorizontalOverflow(page);
      await expect(page.locator('.home-room-card')).toHaveCount(2);
      await expect(page.locator('.dropzone')).toBeVisible();
      await expect(page.locator('.file-list-item')).toHaveCount(2);

      const boxes = await page.locator('.home-room-card').evaluateAll((cards) => cards.map((card) => {
        const rect = card.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      }));

      if (width <= 700) {
        expect(boxes[0].bottom).toBeLessThanOrEqual(boxes[1].top + 1);
      } else {
        expect(boxes[0].top).toBeCloseTo(boxes[1].top, 0);
      }
    }

    await page.setViewportSize({ width: 360, height: 800 });
    await page.getByRole('button', { name: /ZIP \/ подготовка/ }).click();
    const dialog = page.locator('dialog.tw-dialog--prepare');
    await expect(dialog).toBeVisible();

    const dialogBox = await dialog.boundingBox();
    expect(dialogBox.width).toBeLessThanOrEqual(360);
    await expectNoHorizontalOverflow(page);

    expect(errors).toEqual([]);
  });

  test('room workspace stays usable on a narrow phone', async ({ page }) => {
    const errors = collectPageErrors(page);
    await page.setViewportSize({ width: 360, height: 780 });
    await page.goto('/r');

    await page.locator('.room-prejoin-card-wrap .home-room-card.action-card--primary button.action-cta').click();
    await expect(page.locator('.room-workspace')).toBeVisible({ timeout: 20000 });
    await expectNoHorizontalOverflow(page);

    await addFilesToQueue(page, [filePayload('narrow-room.txt', 'narrow room')]);
    await expect(page.locator('.home-files-actions .btn-send')).toBeVisible();
    await expect(page.locator('.invite-card')).toBeVisible();
    await expect(page.locator('.devices-panel')).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await page.setViewportSize({ width: 768, height: 900 });
    await expectNoHorizontalOverflow(page);
    await expect(page.locator('.room-workspace')).toBeVisible();

    expect(errors).toEqual([]);
  });
});
