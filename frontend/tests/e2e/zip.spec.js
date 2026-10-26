import { expect, test } from '@playwright/test';
import {
  addFilesToQueue,
  binaryPayload,
  collectPageErrors,
  filePayload,
} from './helpers.js';

async function openPreparation(page) {
  await page.getByRole('button', { name: /ZIP \/ подготовка/ }).click();
  const dialog = page.locator('dialog.tw-dialog--prepare');
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe('Twindrop ZIP preparation', () => {
  test('creates a ZIP on the home page and keeps it in the persisted queue', async ({ page }) => {
    const errors = collectPageErrors(page);

    await page.goto('/');
    await addFilesToQueue(page, [
      filePayload('archive-one.txt', 'first archive file'),
      filePayload('archive-two.txt', 'second archive file'),
    ]);

    const prepareDialog = await openPreparation(page);
    await expect(prepareDialog.locator('.prep-file-row')).toHaveCount(2);
    await prepareDialog.getByRole('button', { name: 'Продолжить' }).click();

    const readyDialog = page.locator('dialog.tw-dialog--ready');
    await expect(readyDialog).toBeVisible({ timeout: 20000 });
    await expect(readyDialog).toContainText('.zip');
    await readyDialog.getByRole('button', { name: 'Продолжить к отправке' }).click();

    await expect(page.locator('.file-list-item')).toHaveCount(1);
    await expect(page.locator('.file-list-name')).toContainText('.zip');
    await expect(page.locator('.file-list-name')).not.toContainText('archive-one.txt');

    await page.reload();
    await expect(page.locator('.file-list-item')).toHaveCount(1, { timeout: 15000 });
    await expect(page.locator('.file-list-name')).toContainText('.zip');

    await page.locator('.nav-icon-link').click();
    await expect(page).toHaveURL(/\/about$/);
    await page.locator('.brand').click();
    await expect(page.locator('.file-list-item')).toHaveCount(1);

    expect(errors).toEqual([]);
  });

  test('closes preparation without touching the queue', async ({ page }) => {
    const errors = collectPageErrors(page);
    await page.goto('/');
    await addFilesToQueue(page, [
      filePayload('keep-one.txt', 'one'),
      filePayload('keep-two.txt', 'two'),
    ]);

    const dialog = await openPreparation(page);
    await dialog.getByRole('button', { name: 'Закрыть подготовку файлов' }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.locator('.file-list-item')).toHaveCount(2);
    await expect(page.locator('.file-list-name').first()).toHaveText('keep-one.txt');

    expect(errors).toEqual([]);
  });

  test('cancels archive creation and returns to the untouched source files', async ({ page }) => {
    const errors = collectPageErrors(page);
    await page.goto('/');
    await addFilesToQueue(page, [
      binaryPayload('cancel-archive-one.bin', 6 * 1024 * 1024),
      binaryPayload('cancel-archive-two.bin', 6 * 1024 * 1024),
    ]);

    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 20 });

    const prepareDialog = await openPreparation(page);
    await prepareDialog.getByRole('button', { name: 'Продолжить' }).click();

    const archiveDialog = page.locator('dialog.tw-dialog--archive');
    await expect(archiveDialog).toBeVisible();
    await archiveDialog.getByRole('button', { name: 'Отменить архивацию' }).click();

    await expect(prepareDialog).toBeVisible({ timeout: 20000 });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });

    await expect(page.locator('.file-list-item')).toHaveCount(2);
    await expect(page.locator('.file-list-name').first()).toHaveText('cancel-archive-one.bin');
    await expect(page.locator('.file-list-name').nth(1)).toHaveText('cancel-archive-two.bin');

    expect(errors).toEqual([]);
  });
});
