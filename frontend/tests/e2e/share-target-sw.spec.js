import { expect, test } from '@playwright/test';
import {
  collectSharePostRedirects,
  failServiceWorkerFileRead,
  failServiceWorkerStorage,
  installShareImportGate,
  openWithServiceWorker,
  postSharedFiles,
  readPersistedQueueNames,
  readSharedFileNames,
  readSharedRecords,
  releaseShareImportGate,
  submitShareForm,
  waitForShareImportGate,
} from './helpers.js';

test.describe('Twindrop production service worker Share Target', () => {
  test.beforeEach(async ({ page }) => {
    await installShareImportGate(page);
    await openWithServiceWorker(page);
  });

  test('imports a real form share and removes only the imported records', async ({ page }) => {
    const submission = await submitShareForm(page, [
      { name: 'sw-form-alpha.txt', content: 'alpha via form' },
      { name: 'sw-form-beta.txt', content: 'beta via form' },
    ]);

    expect(submission.pathname).toBe('/s');
    expect(submission.searchParams.get('shareError')).toBeNull();
    expect(submission.redirectStatus).toBe(303);
    expect(new URL(submission.redirectLocation).pathname).toBe('/s');
    expect(new URL(submission.redirectLocation).searchParams.get('shareError')).toBeNull();
    expect(submission.fromServiceWorker).toBe(true);

    await waitForShareImportGate(page);

    const pending = await readSharedRecords(page);
    expect(pending.map((record) => record.name).sort()).toEqual([
      'sw-form-alpha.txt',
      'sw-form-beta.txt',
    ]);
    expect(pending.every((record) => typeof record.id === 'string' && record.id.length > 0)).toBe(true);
    expect(new Set(pending.map((record) => record.id)).size).toBe(2);

    await releaseShareImportGate(page);

    await expect(page.locator('.file-list-item')).toHaveCount(2, { timeout: 15000 });
    await expect(page.locator('.file-list-item').filter({ hasText: 'sw-form-alpha.txt' })).toHaveCount(1);
    await expect(page.locator('.file-list-item').filter({ hasText: 'sw-form-beta.txt' })).toHaveCount(1);
    await expect.poll(async () => (await readPersistedQueueNames(page)).sort()).toEqual([
      'sw-form-alpha.txt',
      'sw-form-beta.txt',
    ]);
    await expect.poll(() => readSharedFileNames(page)).toEqual([]);
  });

  test('does not overwrite files from two parallel multipart POST requests', async ({ page }) => {
    const { result: responses, responses: redirects } = await collectSharePostRedirects(
      page,
      2,
      () => page.evaluate(async () => {
        const post = (name, content) => {
          const formData = new FormData();
          formData.append('files', new Blob([content], { type: 'text/plain' }), name);

          return fetch('/s', {
            method: 'POST',
            body: formData,
            redirect: 'follow',
          }).then((response) => ({
            status: response.status,
            redirected: response.redirected,
            url: response.url,
          }));
        };

        return Promise.all([
          post('sw-parallel-a.txt', 'parallel a'),
          post('sw-parallel-b.txt', 'parallel b'),
        ]);
      }),
    );

    expect(redirects).toHaveLength(2);

    for (const redirect of redirects) {
      expect(redirect.status).toBe(303);
      expect(redirect.fromServiceWorker).toBe(true);
      expect(new URL(redirect.location).pathname).toBe('/s');
      expect(new URL(redirect.location).searchParams.get('shareError')).toBeNull();
    }

    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(new URL(response.url).pathname).toBe('/s');
      expect(new URL(response.url).searchParams.get('shareError')).toBeNull();
    }

    await waitForShareImportGate(page);

    const pending = await readSharedRecords(page);
    expect(pending.map((record) => record.name).sort()).toEqual([
      'sw-parallel-a.txt',
      'sw-parallel-b.txt',
    ]);
    expect(new Set(pending.map((record) => record.id)).size).toBe(2);

    await releaseShareImportGate(page);

    await expect.poll(async () => (await readPersistedQueueNames(page)).sort()).toEqual([
      'sw-parallel-a.txt',
      'sw-parallel-b.txt',
    ]);
    await expect.poll(() => readSharedFileNames(page)).toEqual([]);
  });

  test('imports a share that arrives while another import is in progress', async ({ page }) => {
    const first = await postSharedFiles(page, [
      { name: 'sw-during-first.txt', content: 'first' },
    ]);

    expect(first.status).toBe(200);
    expect(first.redirectStatus).toBe(303);
    expect(first.fromServiceWorker).toBe(true);
    expect(new URL(first.redirectLocation).pathname).toBe('/s');
    expect(new URL(first.redirectLocation).searchParams.get('shareError')).toBeNull();
    expect(new URL(first.url).pathname).toBe('/s');

    await waitForShareImportGate(page);
    expect(await readSharedFileNames(page)).toEqual(['sw-during-first.txt']);

    const second = await postSharedFiles(page, [
      { name: 'sw-during-second.txt', content: 'second' },
    ]);

    expect(second.status).toBe(200);
    expect(second.redirectStatus).toBe(303);
    expect(second.fromServiceWorker).toBe(true);
    expect(new URL(second.redirectLocation).pathname).toBe('/s');
    expect(new URL(second.redirectLocation).searchParams.get('shareError')).toBeNull();
    expect(new URL(second.url).pathname).toBe('/s');

    await expect.poll(async () => (await readSharedFileNames(page)).sort()).toEqual([
      'sw-during-first.txt',
      'sw-during-second.txt',
    ]);

    await releaseShareImportGate(page);

    await expect(page.locator('.file-list-item')).toHaveCount(2, { timeout: 15000 });
    await expect.poll(async () => (await readPersistedQueueNames(page)).sort()).toEqual([
      'sw-during-first.txt',
      'sw-during-second.txt',
    ]);
    await expect.poll(() => readSharedFileNames(page)).toEqual([]);
  });

  test('keeps an empty shared file as a rejected record through the real service worker path', async ({ page }) => {
    const submission = await submitShareForm(page, [
      { name: 'sw-empty.txt', content: '' },
    ]);

    expect(submission.pathname).toBe('/s');
    expect(submission.searchParams.get('shareError')).toBeNull();
    expect(submission.redirectStatus).toBe(303);
    expect(new URL(submission.redirectLocation).pathname).toBe('/s');
    expect(new URL(submission.redirectLocation).searchParams.get('shareError')).toBeNull();
    expect(submission.fromServiceWorker).toBe(true);

    await waitForShareImportGate(page);
    expect(await readSharedFileNames(page)).toEqual(['sw-empty.txt']);

    await releaseShareImportGate(page);

    await expect(page.locator('.toast-card').filter({ hasText: 'пустой файл' })).toBeVisible({ timeout: 15000 });
    await expect.poll(() => readSharedFileNames(page)).toEqual(['sw-empty.txt']);

    const [record] = await readSharedRecords(page);
    expect(record.size).toBe(0);
    expect(record.rejectedAt).toBeTruthy();
    expect(record.rejectReason).toBe('empty');
    await expect.poll(() => readPersistedQueueNames(page)).toEqual([]);

    const rejectedAt = record.rejectedAt;
    await page.reload();
    await expect.poll(() => readSharedFileNames(page)).toEqual(['sw-empty.txt']);

    const [afterReload] = await readSharedRecords(page);
    expect(afterReload.rejectedAt).toBe(rejectedAt);
  });

  test('keeps older pending files when a new share cannot be stored', async ({ page, context }) => {
    const first = await submitShareForm(page, [
      { name: 'sw-before-storage-error.txt', content: 'pending before error' },
    ]);

    expect(first.pathname).toBe('/s');

    await waitForShareImportGate(page);
    expect(await readSharedFileNames(page)).toEqual(['sw-before-storage-error.txt']);

    await failServiceWorkerStorage(context);

    const failed = await postSharedFiles(page, [
      { name: 'sw-storage-error.txt', content: 'must not replace pending' },
    ]);

    expect(failed.status).toBe(200);
    expect(failed.redirectStatus).toBe(303);
    expect(failed.fromServiceWorker).toBe(true);
    expect(new URL(failed.redirectLocation).pathname).toBe('/s');
    expect(new URL(failed.redirectLocation).searchParams.get('shareError')).toBe('storage');
    expect(new URL(failed.url).pathname).toBe('/s');
    expect(new URL(failed.url).searchParams.get('shareError')).toBe('storage');

    // The failed transaction must leave the earlier pending record untouched.
    expect(await readSharedFileNames(page)).toEqual(['sw-before-storage-error.txt']);

    // A real browser follows the redirect and loads the application with the
    // error query. Reproduce that navigation to verify the user-facing notice.
    await page.goto(failed.url);
    await expect(page.locator('.toast-card').filter({ hasText: 'Не удалось сохранить файлы' })).toBeVisible({ timeout: 15000 });

    await releaseShareImportGate(page);

    await expect(page.locator('.file-list-item')).toHaveCount(1, { timeout: 15000 });
    await expect(page.locator('.file-list-item')).toContainText('sw-before-storage-error.txt');
    await expect.poll(() => readPersistedQueueNames(page)).toEqual(['sw-before-storage-error.txt']);
    await expect.poll(() => readSharedFileNames(page)).toEqual([]);
  });

  test('keeps older pending files when a shared file cannot be read', async ({ page, context }) => {
    const first = await submitShareForm(page, [
      { name: 'sw-before-read-error.txt', content: 'pending before error' },
    ]);

    expect(first.pathname).toBe('/s');

    await waitForShareImportGate(page);
    expect(await readSharedFileNames(page)).toEqual(['sw-before-read-error.txt']);

    await failServiceWorkerFileRead(context);

    const failed = await postSharedFiles(page, [
      { name: 'sw-read-error.txt', content: 'cannot be read' },
    ]);

    expect(failed.status).toBe(200);
    expect(failed.redirectStatus).toBe(303);
    expect(failed.fromServiceWorker).toBe(true);
    expect(new URL(failed.redirectLocation).pathname).toBe('/s');
    expect(new URL(failed.redirectLocation).searchParams.get('shareError')).toBe('read');
    expect(new URL(failed.url).pathname).toBe('/s');
    expect(new URL(failed.url).searchParams.get('shareError')).toBe('read');
    expect(await readSharedFileNames(page)).toEqual(['sw-before-read-error.txt']);

    await page.goto(failed.url);
    await expect(page.locator('.toast-card').filter({ hasText: 'Не удалось прочитать один или несколько файлов' })).toBeVisible({ timeout: 15000 });

    await releaseShareImportGate(page);

    await expect(page.locator('.file-list-item')).toHaveCount(1, { timeout: 15000 });
    await expect(page.locator('.file-list-item')).toContainText('sw-before-read-error.txt');
    await expect.poll(() => readPersistedQueueNames(page)).toEqual(['sw-before-read-error.txt']);
    await expect.poll(() => readSharedFileNames(page)).toEqual([]);
  });
});
