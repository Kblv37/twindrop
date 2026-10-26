import { expect, test } from '@playwright/test';
import {
  readPersistedQueueNames,
  readSharedFileNames,
  readSharedRecords,
  writeLegacySharedFiles,
  writeSharedFiles,
} from './helpers.js';

test.describe('Twindrop Share Target import', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('moves shared files into the persistent queue and clears the source store', async ({ page }) => {
    await writeSharedFiles(page, [
      { name: 'shared-alpha.txt', content: 'alpha from share' },
      { name: 'shared-beta.txt', content: 'beta from share' },
    ]);

    await page.reload();

    await expect(page.locator('.file-list-item')).toHaveCount(2, { timeout: 15000 });
    await expect(page.locator('.file-list-item').filter({ hasText: 'shared-alpha.txt' })).toHaveCount(1);
    await expect(page.locator('.file-list-item').filter({ hasText: 'shared-beta.txt' })).toHaveCount(1);

    await expect.poll(() => readSharedFileNames(page)).toEqual([]);
    await expect.poll(async () => (await readPersistedQueueNames(page)).sort()).toEqual([
      'shared-alpha.txt',
      'shared-beta.txt',
    ]);
  });

  test('keeps a rejected shared file in the source store', async ({ page }) => {
    await writeSharedFiles(page, [
      { name: 'shared-valid.txt', content: 'valid shared file' },
      { name: 'shared-empty.txt', content: '' },
    ]);

    await page.reload();

    await expect(page.locator('.file-list-item')).toHaveCount(1, { timeout: 15000 });
    await expect(page.locator('.file-list-item')).toContainText('shared-valid.txt');

    await expect.poll(() => readSharedFileNames(page)).toEqual(['shared-empty.txt']);
    await expect.poll(() => readPersistedQueueNames(page)).toEqual(['shared-valid.txt']);

    const [rejected] = await readSharedRecords(page);
    expect(rejected.rejectedAt).toBeTruthy();
    expect(rejected.rejectReason).toBe('empty');

    // A rejected record must not be retried on every application start.
    const rejectedAt = rejected.rejectedAt;
    await page.reload();
    await expect(page.locator('.file-list-item')).toHaveCount(1, { timeout: 15000 });
    await expect.poll(() => readSharedFileNames(page)).toEqual(['shared-empty.txt']);
    const [afterReload] = await readSharedRecords(page);
    expect(afterReload.rejectedAt).toBe(rejectedAt);
  });

  test('keeps the source record when writing the queue record fails', async ({ page }) => {
    await page.addInitScript(() => {
      const nativePut = IDBObjectStore.prototype.put;

      IDBObjectStore.prototype.put = function put(...args) {
        if (this.name === 'queue') {
          throw new DOMException('forced queue write failure', 'UnknownError');
        }

        return nativePut.apply(this, args);
      };
    });

    await writeSharedFiles(page, [
      { name: 'shared-preserve-me.txt', content: 'must survive a failed queue write' },
    ]);

    await page.reload();

    // The file remains usable in the in-memory queue for this session, but its
    // persistent queue record was not written, so the share source must stay.
    await expect(page.locator('.file-list-item')).toHaveCount(1, { timeout: 15000 });
    await expect(page.locator('.file-list-item')).toContainText('shared-preserve-me.txt');

    await expect.poll(() => readSharedFileNames(page)).toEqual(['shared-preserve-me.txt']);
    await expect.poll(() => readPersistedQueueNames(page)).toEqual([]);
  });

  test('deletes only the shared records that were persisted when another queue write fails', async ({ page }) => {
    await page.addInitScript(() => {
      const nativePut = IDBObjectStore.prototype.put;

      IDBObjectStore.prototype.put = function put(record, ...args) {
        if (this.name === 'queue' && record?.name === 'shared-partial-fail.txt') {
          throw new DOMException('forced queue write failure', 'UnknownError');
        }

        return nativePut.call(this, record, ...args);
      };
    });

    await writeSharedFiles(page, [
      { name: 'shared-partial-ok.txt', content: 'persist me' },
      { name: 'shared-partial-fail.txt', content: 'keep me pending' },
    ]);

    await page.reload();

    await expect(page.locator('.file-list-item')).toHaveCount(2, { timeout: 15000 });
    await expect(page.locator('.file-list-item').filter({ hasText: 'shared-partial-ok.txt' })).toHaveCount(1);
    await expect(page.locator('.file-list-item').filter({ hasText: 'shared-partial-fail.txt' })).toHaveCount(1);

    await expect.poll(() => readSharedFileNames(page)).toEqual(['shared-partial-fail.txt']);
    await expect.poll(() => readPersistedQueueNames(page)).toEqual(['shared-partial-ok.txt']);

    const [pending] = await readSharedRecords(page);
    expect(pending.rejectedAt).toBeNull();
  });

  test('keeps pending records when reading the share store fails', async ({ page }) => {
    await writeSharedFiles(page, [
      { name: 'shared-read-error.txt', content: 'must survive a failed read' },
    ]);

    await page.addInitScript(() => {
      const nativeGetAll = IDBObjectStore.prototype.getAll;

      IDBObjectStore.prototype.getAll = function getAll(...args) {
        if (this.name === 'files' && !window.__forcedShareReadFailureUsed) {
          window.__forcedShareReadFailureUsed = true;
          throw new DOMException('forced share read failure', 'UnknownError');
        }

        return nativeGetAll.apply(this, args);
      };
    });

    await page.reload();

    await expect(page.locator('.toast-card').filter({ hasText: 'Не удалось добавить файлы из меню «Поделиться»' })).toBeVisible({ timeout: 15000 });
    await expect.poll(() => readSharedFileNames(page)).toEqual(['shared-read-error.txt']);
    await expect.poll(() => readPersistedQueueNames(page)).toEqual([]);

    const [record] = await readSharedRecords(page);
    expect(record.id).toBeTruthy();
    expect(record.rejectedAt).toBeNull();

    // A failed read must not replace the pending record with an empty batch.
    await page.reload();
    await expect.poll(() => readSharedFileNames(page)).toEqual(['shared-read-error.txt']);
  });

  test('migrates the legacy shared-files array into per-record entries', async ({ page }) => {
    await writeLegacySharedFiles(page, [
      { name: 'legacy-alpha.txt', content: 'legacy alpha' },
      { name: 'legacy-beta.txt', content: 'legacy beta' },
    ]);

    await page.reload();

    await expect(page.locator('.file-list-item')).toHaveCount(2, { timeout: 15000 });
    await expect(page.locator('.file-list-item').filter({ hasText: 'legacy-alpha.txt' })).toHaveCount(1);
    await expect(page.locator('.file-list-item').filter({ hasText: 'legacy-beta.txt' })).toHaveCount(1);

    await expect.poll(() => readSharedFileNames(page)).toEqual([]);
    await expect.poll(async () => (await readPersistedQueueNames(page)).sort()).toEqual([
      'legacy-alpha.txt',
      'legacy-beta.txt',
    ]);
  });
});
