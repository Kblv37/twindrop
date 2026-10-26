import { expect, test } from '@playwright/test';
import {
  addFilesToQueue,
  collectPageErrors,
  createRoom,
  filePayload,
  installRuntimeCounters,
  joinRoom,
  waitForConnected,
} from './helpers.js';

test.describe('Twindrop room lifecycle and SPA state', () => {
  test('creates a room after selecting files and keeps queue, socket and room across navigation', async ({ page }) => {
    const errors = collectPageErrors(page);
    await installRuntimeCounters(page);

    await page.goto('/');
    await addFilesToQueue(page, [
      filePayload('before-room.txt', 'selected before room'),
      filePayload('before-room-2.txt', 'second file'),
    ]);

    await page.locator('.home-room-card.action-card--primary button.action-cta').click();
    await expect(page).toHaveURL(/\/r$/);
    await expect(page.locator('.room-workspace')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('.file-list-item')).toHaveCount(2);

    const code = (await page.locator('.invite-code').innerText()).trim();
    expect(code).toMatch(/^\d{6}$/);
    await expect(page.locator('.nav-room-code')).toHaveText(code);
    expect(await page.evaluate(() => window.__socketIoWebSockets)).toBe(1);
    expect(await page.evaluate(() => window.__rtcPeerConnections)).toBe(0);

    await page.evaluate(() => {
      window.__spaMarker = 'room-alive';
    });

    await page.locator('.brand').click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('.room-workspace')).toHaveCount(0);
    await expect(page.locator('.nav-room-code')).toHaveText(code);
    await expect(page.locator('.file-list-item')).toHaveCount(2);
    expect(await page.evaluate(() => window.__spaMarker)).toBe('room-alive');

    await page.locator('.nav-room-link').click();
    await expect(page).toHaveURL(/\/r$/);
    await expect(page.locator('.room-workspace')).toBeVisible();
    await expect(page.locator('.invite-code')).toHaveText(code);
    await expect(page.locator('.file-list-item')).toHaveCount(2);
    expect(await page.evaluate(() => window.__spaMarker)).toBe('room-alive');
    expect(await page.evaluate(() => window.__socketIoWebSockets)).toBe(1);

    await page.locator('.room-icon-btn').click();
    await expect(page.locator('dialog.tw-dialog--info')).toBeVisible();
    await expect(page.locator('dialog.tw-dialog--info')).toContainText(code);
    await page.getByRole('button', { name: 'Закрыть информацию о комнате' }).click();
    await expect(page.locator('dialog.tw-dialog--info')).not.toBeVisible();

    await page.getByRole('button', { name: /Отключиться/ }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('.file-list-item')).toHaveCount(2);
    await expect(page.locator('.nav-room-code')).toHaveCount(0);

    expect(errors).toEqual([]);
  });

  test('restores the active room and its code after a full page reload', async ({ page }) => {
    const errors = collectPageErrors(page);
    await installRuntimeCounters(page);

    const code = await createRoom(page, { fromHome: true });

    await page.reload();

    await expect(page.locator('.room-workspace')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('.invite-code')).toHaveText(code);
    await expect(page.locator('.nav-room-code')).toHaveText(code);
    await expect(page.locator('.room-toolbar-status strong')).toHaveText(
      /Комната создана|Комната активна/,
      { timeout: 15000 },
    );
    expect(await page.evaluate(() => window.__socketIoWebSockets)).toBe(1);
    expect(await page.evaluate(() => window.__rtcPeerConnections)).toBe(0);

    expect(errors).toEqual([]);
  });

  test('joins an existing room and preserves one WebRTC session across route changes', async ({ browser }) => {
    const creatorContext = await browser.newContext();
    const joinerContext = await browser.newContext();
    const creator = await creatorContext.newPage();
    const joiner = await joinerContext.newPage();
    const errors = collectPageErrors(creator);
    const joinerErrors = collectPageErrors(joiner);

    await installRuntimeCounters(creator);
    await installRuntimeCounters(joiner);

    const code = await createRoom(creator, { fromHome: true });
    await joiner.goto(`/s?r=${code}`);
    await expect(joiner.locator('#homeJoinCode')).toHaveValue(code);
    await joiner.locator('.home-card-form button[type="submit"]').click();
    await expect(joiner.locator('.room-workspace')).toBeVisible({ timeout: 20000 });

    await waitForConnected(creator);
    await waitForConnected(joiner);
    expect(await creator.evaluate(() => window.__rtcPeerConnections)).toBe(1);
    expect(await joiner.evaluate(() => window.__rtcPeerConnections)).toBe(1);

    await expect(joiner.locator('.device-card[data-connection-path]')).toHaveAttribute(
      'data-connection-path',
      'direct',
      { timeout: 15000 },
    );
    await expect(joiner.locator('.device-card[data-connection-path]')).toContainText('напрямую');

    await creator.evaluate(() => {
      window.__spaMarker = 'creator-alive';
    });
    await joiner.evaluate(() => {
      window.__spaMarker = 'joiner-alive';
    });

    await creator.locator('.brand').click();
    await creator.locator('.nav-room-link').click();
    await expect(creator.locator('.room-workspace')).toBeVisible();
    expect(await creator.evaluate(() => window.__spaMarker)).toBe('creator-alive');
    expect(await creator.evaluate(() => window.__rtcPeerConnections)).toBe(1);
    expect(await creator.evaluate(() => window.__socketIoWebSockets)).toBe(1);

    await joiner.locator('.nav-icon-link').click();
    await joiner.locator('.nav-room-link').click();
    await expect(joiner.locator('.room-workspace')).toBeVisible();
    expect(await joiner.evaluate(() => window.__spaMarker)).toBe('joiner-alive');
    expect(await joiner.evaluate(() => window.__rtcPeerConnections)).toBe(1);
    expect(await joiner.evaluate(() => window.__socketIoWebSockets)).toBe(1);

    await waitForConnected(creator);
    await waitForConnected(joiner);

    expect(errors).toEqual([]);
    expect(joinerErrors).toEqual([]);

    await creatorContext.close();
    await joinerContext.close();
  });

  test('detects a TURN relay from the selected ICE candidate pair', async ({ browser }) => {
    const creatorContext = await browser.newContext();
    const joinerContext = await browser.newContext();
    const creator = await creatorContext.newPage();
    const joiner = await joinerContext.newPage();

    for (const page of [creator, joiner]) {
      await page.addInitScript(() => {
        RTCPeerConnection.prototype.getStats = () => {
          const stats = new Map();
          stats.set('pair', {
            id: 'pair',
            type: 'candidate-pair',
            selected: true,
            nominated: true,
            state: 'succeeded',
            localCandidateId: 'local',
            remoteCandidateId: 'remote',
          });
          stats.set('local', { id: 'local', type: 'local-candidate', candidateType: 'relay' });
          stats.set('remote', { id: 'remote', type: 'remote-candidate', candidateType: 'host' });
          return Promise.resolve(stats);
        };
      });
    }

    const code = await createRoom(creator, { fromHome: true });
    await joinRoom(joiner, code);
    await waitForConnected(creator);
    await waitForConnected(joiner);

    const remoteCard = joiner.locator('.device-card[data-connection-path]');
    await expect(remoteCard).toHaveAttribute('data-connection-path', 'relay', { timeout: 15000 });
    await expect(remoteCard).toContainText('TURN');

    await creatorContext.close();
    await joinerContext.close();
  });
});
