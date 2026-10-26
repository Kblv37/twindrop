import { expect, test } from '@playwright/test';
import {
  addFilesToQueue,
  collectPageErrors,
  filePayload,
  installRuntimeCounters,
} from './helpers.js';

test.describe('Twindrop home and shared file queue', () => {
  test('shows both room actions and a large file queue without creating a room', async ({ page }) => {
    const errors = collectPageErrors(page);
    const roomRequests = [];

    page.on('request', (request) => {
      if (request.url().endsWith('/api/rooms') && request.method() === 'POST') {
        roomRequests.push(request.url());
      }
    });

    await page.goto('/');

    await expect(page.locator('.home-room-card')).toHaveCount(2);
    await expect(page.locator('.home-room-card.action-card--primary')).toContainText('Создать комнату');
    await expect(page.locator('.dropzone')).toBeVisible();
    await expect(page.locator('.file-list-item')).toHaveCount(0);

    await addFilesToQueue(page, [
      filePayload('alpha.txt', 'alpha content'),
      filePayload('beta.json', JSON.stringify({ beta: true }), 'application/json'),
    ]);

    await expect(page.locator('.queue-summary-pill')).toContainText('2 файла');
    await expect(page.locator('.file-list-item')).toHaveCount(2);
    await expect(page.locator('.room-workspace')).toHaveCount(0);
    expect(roomRequests).toHaveLength(0);
    expect(page.url()).toMatch(/\/$/);

    await page.locator('.file-list-item').first().locator('.file-list-remove').click();
    await expect(page.locator('.file-list-item')).toHaveCount(1);
    await expect(page.locator('.file-list-item')).toContainText('beta.json');

    await page.getByRole('button', { name: 'Очистить', exact: true }).click();
    await expect(page.locator('dialog.tw-dialog--confirm')).toBeVisible();
    await page.getByRole('button', { name: 'Очистить', exact: true }).last().click();
    await expect(page.locator('.file-list-item')).toHaveCount(0);

    expect(errors).toEqual([]);
  });

  test('keeps the queue across reload and SPA navigation without document reloads', async ({ page }) => {
    const errors = collectPageErrors(page);
    await installRuntimeCounters(page);

    await page.goto('/');
    await addFilesToQueue(page, [
      filePayload('persisted-one.txt', 'persisted one'),
      filePayload('persisted-two.txt', 'persisted two'),
    ]);

    await page.reload();
    await expect(page.locator('.file-list-item')).toHaveCount(2, { timeout: 15000 });
    await expect(page.locator('.file-list-item').first()).toContainText('persisted-one.txt');
    await expect(page.locator('.file-list-item').nth(1)).toContainText('persisted-two.txt');

    await page.evaluate(() => {
      window.__spaMarker = 'still-alive';
    });

    await page.locator('.nav-icon-link').click();
    await expect(page).toHaveURL(/\/about$/);
    await expect(page.locator('.section')).toHaveCount(7);

    await page.getByRole('link', { name: 'Создать', exact: true }).click();
    await expect(page).toHaveURL(/\/r$/);
    await expect(page.locator('.room-prejoin-card-wrap')).toBeVisible();
    await expect(page.locator('.file-list-item')).toHaveCount(2);

    await page.getByRole('link', { name: 'Подключиться', exact: true }).click();
    await expect(page).toHaveURL(/\/s$/);
    await expect(page.locator('.room-prejoin-card-wrap')).toBeVisible();

    await page.locator('.brand').click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('.file-list-item')).toHaveCount(2);
    expect(await page.evaluate(() => window.__spaMarker)).toBe('still-alive');

    expect(errors).toEqual([]);
  });

  test('keeps the queue after a failed join and normalizes invalid input', async ({ page }) => {
    const errors = collectPageErrors(page);
    await page.goto('/s');
    await addFilesToQueue(page, [filePayload('keep-after-error.txt', 'keep me')]);

    const input = page.locator('#homeJoinCode');
    await input.fill('12ab34');
    await expect(input).toHaveValue('1234');
    await expect(page.locator('.home-card-form button[type="submit"]')).toBeDisabled();

    const firstCandidate = '000000';
    const firstResponse = await page.request.get(`/api/rooms/${firstCandidate}`);
    const firstPayload = await firstResponse.json();
    const missingCode = firstPayload.exists ? '000001' : firstCandidate;

    await input.fill(missingCode);
    await page.locator('.home-card-form button[type="submit"]').click();

    await expect(page.locator('.toast-card').filter({ hasText: 'не найдена' })).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.room-workspace')).toHaveCount(0);
    await expect(page.locator('.file-list-item')).toHaveCount(1);
    await expect(page.locator('.file-list-item')).toContainText('keep-after-error.txt');

    expect(errors).toEqual([]);
  });
});
