import { expect, test } from '@playwright/test';
import {
  addFilesToQueue,
  binaryPayload,
  collectPageErrors,
  createRoom,
  disableFileSystemAccess,
  disableOpfs,
  filePayload,
  installObjectUrlCounters,
  installRuntimeCounters,
  joinRoom,
  listOpfsReceiveFiles,
  readDownloadedText,
  readOpfsReceiveFileContents,
  readPersistedQueueNames,
  waitForConnected,
  waitForOpfsEmpty,
} from './helpers.js';

async function connectPair(browser, { creatorSetup, joinerSetup } = {}) {
  const creatorContext = await browser.newContext({ acceptDownloads: true });
  const joinerContext = await browser.newContext({ acceptDownloads: true });
  const creator = await creatorContext.newPage();
  const joiner = await joinerContext.newPage();
  const errors = collectPageErrors(creator);
  const joinerErrors = collectPageErrors(joiner);

  await installRuntimeCounters(creator);
  await installRuntimeCounters(joiner);
  await installObjectUrlCounters(creator);
  await installObjectUrlCounters(joiner);
  // Force the anchor download path so Playwright can observe downloads and
  // the tests can assert that no object URL is created before a click.
  await disableFileSystemAccess(creator);
  await disableFileSystemAccess(joiner);

  if (creatorSetup) {
    await creatorSetup(creator);
  }

  if (joinerSetup) {
    await joinerSetup(joiner);
  }

  const code = await createRoom(creator, { fromHome: true });
  await joinRoom(joiner, code);
  await waitForConnected(creator);
  await waitForConnected(joiner);

  return {
    creator,
    joiner,
    errors,
    joinerErrors,
    close: async () => {
      await Promise.allSettled([creatorContext.close(), joinerContext.close()]);
    },
  };
}

test.describe('Twindrop WebRTC transfer', () => {
  test('transfers files in both directions, stores them in OPFS and downloads on demand', async ({ browser }) => {
    const pair = await connectPair(browser);
    const { creator, joiner } = pair;

    await addFilesToQueue(joiner, [
      filePayload('alpha.txt', 'hello alpha'),
      filePayload('beta.json', JSON.stringify({ beta: 42 }), 'application/json'),
    ]);

    await joiner.locator('.home-files-actions .btn-send').click();

    await expect(creator.locator('.history-status-pill', { hasText: 'Получено' })).toHaveCount(2, { timeout: 30000 });
    await expect(joiner.locator('.history-status-pill', { hasText: 'Отправлено' })).toHaveCount(2, { timeout: 30000 });
    await expect(joiner.locator('.file-list-item')).toHaveCount(0);
    await expect(creator.locator('.history-item[data-storage="opfs"]')).toHaveCount(2);

    // Receiving must not materialize a full Blob or create an object URL.
    expect(await creator.evaluate(() => window.__objectUrlsCreated)).toBe(0);

    const receivedFiles = await listOpfsReceiveFiles(creator);
    expect(receivedFiles).toHaveLength(2);
    expect(receivedFiles.every((file) => file.size > 0)).toBe(true);

    const opfsContents = await readOpfsReceiveFileContents(creator);
    expect(opfsContents.map((file) => file.text).sort()).toEqual([
      'hello alpha',
      JSON.stringify({ beta: 42 }),
    ].sort());

    expect(await readDownloadedText(creator, 'alpha.txt')).toBe('hello alpha');
    expect(await readDownloadedText(creator, 'beta.json')).toBe(JSON.stringify({ beta: 42 }));
    expect(await creator.evaluate(() => window.__objectUrlsCreated)).toBe(2);

    await joiner.evaluate(() => {
      window.__spaMarker = 'transfer-alive';
    });
    await joiner.locator('.brand').click();
    await expect(joiner).toHaveURL(/\/$/);
    await joiner.locator('.nav-room-link').click();
    await expect(joiner.locator('.room-workspace')).toBeVisible();
    await waitForConnected(joiner);
    await waitForConnected(creator);

    expect(await joiner.evaluate(() => window.__spaMarker)).toBe('transfer-alive');
    expect(await joiner.evaluate(() => window.__rtcPeerConnections)).toBe(1);
    expect(await joiner.evaluate(() => window.__socketIoWebSockets)).toBe(1);
    await expect(joiner.locator('.history-item')).toHaveCount(2);
    await expect(creator.locator('.history-item')).toHaveCount(2);
    expect(await listOpfsReceiveFiles(creator)).toHaveLength(2);

    await addFilesToQueue(joiner, [filePayload('after-nav.txt', 'sent after navigation')]);
    await joiner.locator('.home-files-actions .btn-send').click();

    await expect(creator.locator('.history-status-pill', { hasText: 'Получено' })).toHaveCount(3, { timeout: 30000 });
    await expect(joiner.locator('.history-status-pill', { hasText: 'Отправлено' })).toHaveCount(3, { timeout: 30000 });
    expect(await readDownloadedText(creator, 'after-nav.txt')).toBe('sent after navigation');
    expect(await listOpfsReceiveFiles(creator)).toHaveLength(3);

    expect(pair.errors).toEqual([]);
    expect(pair.joinerErrors).toEqual([]);
    await pair.close();
  });

  test('keeps a confirmed file out of the persisted queue after sender reload', async ({ browser }) => {
    const pair = await connectPair(browser);
    const { creator, joiner } = pair;
    const code = (await joiner.locator('.nav-room-code').innerText()).trim();

    await addFilesToQueue(joiner, [filePayload('confirmed-before-reload.txt', 'confirmed payload')]);
    await joiner.locator('.home-files-actions .btn-send').click();

    await expect(creator.locator('.history-status-pill', { hasText: 'Получено' })).toHaveCount(1, { timeout: 30000 });
    await expect(joiner.locator('.history-status-pill', { hasText: 'Отправлено' })).toHaveCount(1, { timeout: 30000 });
    await expect(joiner.locator('.file-list-item')).toHaveCount(0);
    await expect.poll(() => readPersistedQueueNames(joiner)).toEqual([]);
    expect(await listOpfsReceiveFiles(creator)).toHaveLength(1);

    await joiner.reload();

    await expect(joiner.locator('.room-workspace')).toBeVisible({ timeout: 20000 });
    await expect(joiner.locator('.nav-room-code')).toHaveText(code);
    await waitForConnected(joiner);
    await expect(joiner.locator('.file-list-item')).toHaveCount(0);
    expect(await readPersistedQueueNames(joiner)).toEqual([]);

    // Reloading the sender must not remove the file already stored by the receiver.
    expect(await listOpfsReceiveFiles(creator)).toHaveLength(1);
    expect(await readDownloadedText(creator, 'confirmed-before-reload.txt')).toBe('confirmed payload');

    expect(pair.errors).toEqual([]);
    expect(pair.joinerErrors).toEqual([]);
    await pair.close();
  });

  test('cancels an active transfer after confirmation and keeps the queue', async ({ browser }) => {
    const pair = await connectPair(browser);
    const { creator, joiner } = pair;

    await addFilesToQueue(joiner, [binaryPayload('cancel-me.bin', 32 * 1024 * 1024)]);
    await joiner.locator('.transfer-chunk select').selectOption('16384');
    await joiner.locator('.home-files-actions .btn-send').click();

    const cancelButton = joiner.locator('.current-cancel-btn');
    await expect(cancelButton).toBeVisible({ timeout: 15000 });
    await cancelButton.click();

    const confirm = joiner.locator('dialog.tw-dialog--confirm');
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText('Отменить отправку?');
    await confirm.getByRole('button', { name: 'Да, отменить' }).click();

    await expect(joiner.locator('.history-status-pill', { hasText: 'Отменено' })).toBeVisible({ timeout: 15000 });
    await expect(joiner.locator('.file-list-item')).toHaveCount(1);
    await expect(joiner.locator('.file-list-item')).toContainText('cancel-me.bin');
    await expect(creator.locator('.history-status-pill', { hasText: /Отменено|Ошибка/ })).toBeVisible({ timeout: 15000 });

    // A canceled transfer must not leave a partial receive file behind.
    await waitForOpfsEmpty(creator);
    expect(await creator.evaluate(() => window.__objectUrlsCreated)).toBe(0);

    expect(pair.errors).toEqual([]);
    expect(pair.joinerErrors).toEqual([]);
    await pair.close();
  });

  test('removes the received OPFS file when the history is cleared', async ({ browser }) => {
    const pair = await connectPair(browser);
    const { creator, joiner } = pair;

    await addFilesToQueue(joiner, [filePayload('clear-opfs.txt', 'download before clearing')]);
    await joiner.locator('.home-files-actions .btn-send').click();

    await expect(creator.locator('.history-status-pill', { hasText: 'Получено' })).toHaveCount(1, { timeout: 30000 });
    expect(await listOpfsReceiveFiles(creator)).toHaveLength(1);
    expect(await creator.evaluate(() => window.__objectUrlsCreated)).toBe(0);

    expect(await readDownloadedText(creator, 'clear-opfs.txt')).toBe('download before clearing');
    expect(await creator.evaluate(() => window.__objectUrlsCreated)).toBe(1);

    await creator.locator('.history-clear-btn').click();
    const confirm = creator.locator('dialog.tw-dialog--confirm');
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Очистить' }).click();

    await expect(creator.locator('.history-item')).toHaveCount(0);
    await waitForOpfsEmpty(creator);
    await expect(creator.locator('[data-action="download"]')).toHaveCount(0);

    expect(pair.errors).toEqual([]);
    expect(pair.joinerErrors).toEqual([]);
    await pair.close();
  });

  test('removes the received OPFS file when leaving the room', async ({ browser }) => {
    const pair = await connectPair(browser);
    const { creator, joiner } = pair;

    await addFilesToQueue(joiner, [filePayload('leave-opfs.txt', 'download before leaving')]);
    await joiner.locator('.home-files-actions .btn-send').click();

    await expect(creator.locator('.history-status-pill', { hasText: 'Получено' })).toHaveCount(1, { timeout: 30000 });
    expect(await listOpfsReceiveFiles(creator)).toHaveLength(1);
    expect(await readDownloadedText(creator, 'leave-opfs.txt')).toBe('download before leaving');
    expect(await creator.evaluate(() => window.__objectUrlsCreated)).toBe(1);

    await creator.locator('.room-leave-btn').click();
    await expect(creator).toHaveURL(/\/$/);
    await waitForOpfsEmpty(creator);
    await expect(creator.locator('.history-item')).toHaveCount(0);

    expect(pair.errors).toEqual([]);
    expect(pair.joinerErrors).toEqual([]);
    await pair.close();
  });

  test('does not leave the receiver in the receiving state or a partial file when the sender disconnects', async ({ browser }) => {
    const pair = await connectPair(browser);
    const { creator, joiner } = pair;

    await addFilesToQueue(joiner, [binaryPayload('disconnect-me.bin', 32 * 1024 * 1024)]);
    await joiner.locator('.transfer-chunk select').selectOption('16384');
    await joiner.locator('.home-files-actions .btn-send').click();

    await expect(creator.locator('.history-status-pill', { hasText: 'Принимается' })).toBeVisible({ timeout: 15000 });

    await joiner.close();

    await expect(creator.locator('.history-status-pill', { hasText: /Отменено|Ошибка/ })).toBeVisible({ timeout: 20000 });
    await expect(creator.locator('.history-status-pill', { hasText: 'Принимается' })).toHaveCount(0);
    await waitForOpfsEmpty(creator);

    expect(pair.errors).toEqual([]);
    await pair.close();
  });

  test('uses the bounded memory fallback when OPFS is unavailable', async ({ browser }) => {
    const pair = await connectPair(browser, { creatorSetup: disableOpfs });
    const { creator, joiner } = pair;

    await addFilesToQueue(joiner, [filePayload('memory-fallback.txt', 'memory fallback works')]);
    await joiner.locator('.home-files-actions .btn-send').click();

    await expect(creator.locator('.history-status-pill', { hasText: 'Получено' })).toHaveCount(1, { timeout: 30000 });
    await expect(creator.locator('.history-item[data-storage="memory"]')).toHaveCount(1);
    await expect(
      creator.locator('.history-item').filter({ hasText: 'memory-fallback.txt' }),
    ).toContainText('временно в памяти');

    expect(await creator.evaluate(() => window.__objectUrlsCreated)).toBe(0);
    expect(await readDownloadedText(creator, 'memory-fallback.txt')).toBe('memory fallback works');
    expect(await creator.evaluate(() => window.__objectUrlsCreated)).toBe(1);

    expect(pair.errors).toEqual([]);
    expect(pair.joinerErrors).toEqual([]);
    await pair.close();
  });
});
