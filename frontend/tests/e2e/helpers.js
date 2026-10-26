import { expect } from '@playwright/test';

export const SAMPLE_TEXT = 'hello twindrop\n';

export function filePayload(name, content = SAMPLE_TEXT, mimeType = 'text/plain') {
  return {
    name,
    mimeType,
    buffer: Buffer.from(content),
  };
}

export function binaryPayload(name, size, mimeType = 'application/octet-stream') {
  return {
    name,
    mimeType,
    buffer: Buffer.alloc(size, 7),
  };
}

export async function addFilesToQueue(page, files) {
  const expected = Array.isArray(files) ? files.length : 1;
  const before = await page.locator('.file-list-item').count();

  await page.locator('.dropzone input[type="file"]').setInputFiles(files);
  await expect(page.locator('.file-list-item')).toHaveCount(before + expected, { timeout: 15000 });
}

export async function createRoom(page, { fromHome = false } = {}) {
  if (fromHome) {
    await page.goto('/');
    await page.locator('.home-room-card.action-card--primary button.action-cta').click();
    await expect(page).toHaveURL(/\/r$/);
  } else {
    await page.goto('/r');
    await page.locator('.room-prejoin-card-wrap .home-room-card.action-card--primary button.action-cta').click();
  }

  await expect(page.locator('.room-workspace')).toBeVisible({ timeout: 20000 });
  const code = (await page.locator('.invite-code').innerText()).trim();

  expect(code).toMatch(/^\d{6}$/);
  return code;
}

export async function joinRoom(page, code, { fromHome = false } = {}) {
  if (fromHome) {
    await page.goto('/');
  } else {
    await page.goto(`/s?r=${code}`);
  }

  const input = page.locator('#homeJoinCode');
  await input.fill(code);
  await page.locator('.home-card-form button[type="submit"]').click();
  await expect(page.locator('.room-workspace')).toBeVisible({ timeout: 20000 });
}

export async function waitForConnected(page) {
  await expect(page.locator('.room-toolbar-status strong')).toHaveText(
    /Комната подключена|P2P-канал активен/,
    { timeout: 25000 },
  );
}

async function runShareDbTask(page, task, payload) {
  return page.evaluate(async ({ taskName, taskPayload }) => {
    function openDatabase() {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open('twindrop-share-target', 2);

        request.onupgradeneeded = () => {
          const database = request.result;

          if (!database.objectStoreNames.contains('files')) {
            database.createObjectStore('files');
          }

          if (!database.objectStoreNames.contains('queue')) {
            database.createObjectStore('queue', { keyPath: 'id' });
          }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }

    function requestToPromise(request) {
      return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }

    function transactionDone(transaction) {
      return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error || new Error('indexeddb-aborted'));
      });
    }

    function encodeFile(file) {
      const encoder = new TextEncoder();
      const bytes = Array.isArray(file.bytes)
        ? Uint8Array.from(file.bytes)
        : encoder.encode(file.content || '');

      return {
        bytes,
        record: {
          id: file.id || `test-share-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
          name: file.name,
          type: file.type || 'text/plain',
          size: bytes.byteLength,
          lastModified: Date.now(),
          data: bytes.buffer,
          createdAt: Date.now(),
        },
      };
    }

    const db = await openDatabase();

    try {
      if (taskName === 'read-queue-names') {
        const transaction = db.transaction('queue', 'readonly');
        const records = await requestToPromise(transaction.objectStore('queue').getAll());
        return (records || []).map((record) => record.name);
      }

      if (taskName === 'read-shared-records') {
        const transaction = db.transaction('files', 'readonly');
        const store = transaction.objectStore('files');
        const keys = await requestToPromise(store.getAllKeys());
        const values = await requestToPromise(store.getAll());
        const records = [];

        for (let index = 0; index < values.length; index += 1) {
          const key = keys[index];
          const value = values[index];

          if (key === 'shared-files' && Array.isArray(value)) {
            for (const legacyRecord of value) {
              if (legacyRecord && typeof legacyRecord === 'object') {
                records.push({ ...legacyRecord, legacy: true });
              }
            }
            continue;
          }

          if (Array.isArray(value) || !value || typeof value !== 'object') {
            continue;
          }

          records.push(value);
        }

        return records.map((record) => ({
          id: record.id || null,
          name: record.name,
          size: record.size,
          rejectedAt: record.rejectedAt || null,
          rejectReason: record.rejectReason || null,
          legacy: Boolean(record.legacy),
        }));
      }

      if (taskName === 'write-shared-records') {
        const transaction = db.transaction('files', 'readwrite');
        const store = transaction.objectStore('files');
        const done = transactionDone(transaction);

        for (const file of taskPayload) {
          const { record } = encodeFile(file);
          store.put(record, record.id);
        }

        await done;
        return null;
      }

      if (taskName === 'write-legacy-records') {
        const transaction = db.transaction('files', 'readwrite');
        const store = transaction.objectStore('files');
        const done = transactionDone(transaction);
        const encoder = new TextEncoder();
        const records = taskPayload.map((file) => {
          const bytes = encoder.encode(file.content || '');

          return {
            name: file.name,
            type: file.type || 'text/plain',
            size: bytes.byteLength,
            lastModified: Date.now(),
            data: bytes.buffer,
          };
        });

        store.put(records, 'shared-files');
        await done;
        return null;
      }

      if (taskName === 'clear-shared-records') {
        const transaction = db.transaction('files', 'readwrite');
        const done = transactionDone(transaction);
        transaction.objectStore('files').clear();
        await done;
        return null;
      }

      throw new Error(`Unknown share database task: ${taskName}`);
    } finally {
      db.close();
    }
  }, { taskName: task, taskPayload: payload });
}

export function readPersistedQueueNames(page) {
  return runShareDbTask(page, 'read-queue-names');
}

export async function readSharedRecords(page) {
  return runShareDbTask(page, 'read-shared-records');
}

export async function readSharedFileNames(page) {
  const records = await readSharedRecords(page);
  return records.map((record) => record.name);
}

export function writeSharedFiles(page, files) {
  return runShareDbTask(page, 'write-shared-records', files);
}

export function writeLegacySharedFiles(page, files) {
  return runShareDbTask(page, 'write-legacy-records', files);
}

export function clearSharedFiles(page) {
  return runShareDbTask(page, 'clear-shared-records');
}

export async function waitForServiceWorkerControl(page) {
  await expect.poll(
    () => page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) {
        return false;
      }

      const registration = await navigator.serviceWorker.getRegistration();

      return Boolean(registration?.active) && Boolean(navigator.serviceWorker.controller);
    }),
    { timeout: 30000 },
  ).toBe(true);
}

export async function openWithServiceWorker(page) {
  await page.goto('/');
  await waitForServiceWorkerControl(page);
  // The first load may have happened before clients.claim() took effect. A
  // reload guarantees that both the page and the fetch below go through the
  // production service worker.
  await page.reload();
  await waitForServiceWorkerControl(page);
}

export async function postSharedFiles(page, files) {
  const redirectPromise = page.waitForResponse(
    (response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/s',
    { timeout: 20000 },
  );

  const result = await page.evaluate(async (entries) => {
    const formData = new FormData();
    const encoder = new TextEncoder();

    for (const entry of entries) {
      const bytes = Array.isArray(entry.bytes)
        ? Uint8Array.from(entry.bytes)
        : encoder.encode(entry.content || '');
      const blob = new Blob([bytes], { type: entry.type || 'text/plain' });
      formData.append('files', blob, entry.name);
    }

    const response = await fetch('/s', {
      method: 'POST',
      body: formData,
      redirect: 'follow',
    });

    return {
      status: response.status,
      redirected: response.redirected,
      url: response.url,
    };
  }, files);

  const redirectResponse = await redirectPromise;

  return {
    ...result,
    redirectStatus: redirectResponse.status(),
    redirectLocation: redirectResponse.headers()['location'] || '',
    fromServiceWorker: redirectResponse.fromServiceWorker(),
  };
}

export async function collectSharePostRedirects(page, count, action) {
  const responses = [];
  const listener = (response) => {
    if (response.request().method() === 'POST' && new URL(response.url()).pathname === '/s') {
      responses.push({
        status: response.status(),
        location: response.headers()['location'] || '',
        fromServiceWorker: response.fromServiceWorker(),
      });
    }
  };

  page.on('response', listener);

  try {
    const result = await action();
    await expect.poll(() => responses.length, { timeout: 20000 }).toBe(count);
    return { result, responses };
  } finally {
    page.off('response', listener);
  }
}

export async function submitShareForm(page, files) {
  const navigation = page.waitForURL(/\/s(?:\?|$)/, { timeout: 30000 });
  const redirectPromise = page.waitForResponse(
    (response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/s',
    { timeout: 30000 },
  );

  await page.evaluate(async (entries) => {
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = '/s';
    form.enctype = 'multipart/form-data';
    form.style.display = 'none';

    const input = document.createElement('input');
    input.type = 'file';
    input.name = 'files';
    input.multiple = true;

    const transfer = new DataTransfer();
    const encoder = new TextEncoder();

    for (const entry of entries) {
      const bytes = Array.isArray(entry.bytes)
        ? Uint8Array.from(entry.bytes)
        : encoder.encode(entry.content || '');
      const file = new File([bytes], entry.name, { type: entry.type || 'text/plain' });
      transfer.items.add(file);
    }

    input.files = transfer.files;
    form.appendChild(input);
    document.body.appendChild(form);
    form.submit();
  }, files).catch((error) => {
    if (!String(error?.message || error).includes('Execution context was destroyed')) {
      throw error;
    }
  });

  const redirectResponse = await redirectPromise;

  await navigation;
  await page.waitForLoadState('domcontentloaded');

  return {
    url: page.url(),
    pathname: new URL(page.url()).pathname,
    searchParams: new URL(page.url()).searchParams,
    redirectStatus: redirectResponse.status(),
    redirectLocation: redirectResponse.headers()['location'] || '',
    fromServiceWorker: redirectResponse.fromServiceWorker(),
  };
}

export async function installShareImportGate(page) {
  await page.addInitScript(() => {
    const gate = {
      started: false,
      released: false,
      waiters: [],
    };

    window.__shareImportGate = gate;
    window.__releaseShareImportGate = () => {
      gate.released = true;
      gate.waiters.splice(0).forEach((resolve) => resolve());
    };
    window.__TWINDROP_TEST_HOOKS__ = {
      beforeShareImport: async () => {
        gate.started = true;

        if (gate.released) {
          return;
        }

        await new Promise((resolve) => {
          gate.waiters.push(resolve);
        });
      },
    };
  });
}

export async function waitForShareImportGate(page) {
  await expect.poll(
    () => page.evaluate(() => window.__shareImportGate?.started === true),
    { timeout: 20000 },
  ).toBe(true);
}

export async function releaseShareImportGate(page) {
  await page.evaluate(() => {
    window.__releaseShareImportGate?.();
  });
}

export async function getServiceWorker(context) {
  const existing = context.serviceWorkers()[0];

  if (existing) {
    return existing;
  }

  return context.waitForEvent('serviceworker', { timeout: 30000 });
}

export async function failServiceWorkerStorage(context) {
  const worker = await getServiceWorker(context);

  await worker.evaluate(() => {
    const nativeTransaction = IDBDatabase.prototype.transaction;

    IDBDatabase.prototype.transaction = function transaction(...args) {
      const result = nativeTransaction.apply(this, args);
      const nativeObjectStore = result.objectStore.bind(result);

      result.objectStore = function objectStore(...storeArgs) {
        const store = nativeObjectStore(...storeArgs);

        if (store.name === 'files') {
          store.put = function put() {
            throw new DOMException('forced share storage failure', 'UnknownError');
          };
        }

        return store;
      };

      return result;
    };
  });

  return worker;
}

export async function failServiceWorkerFileRead(context) {
  const worker = await getServiceWorker(context);

  await worker.evaluate(() => {
    File.prototype.arrayBuffer = function arrayBuffer() {
      return Promise.reject(new DOMException('forced share read failure', 'NotReadableError'));
    };
  });

  return worker;
}

export async function installObjectUrlCounters(page) {
  await page.addInitScript(() => {
    window.__objectUrlsCreated = 0;
    window.__objectUrlsRevoked = 0;

    const nativeCreate = URL.createObjectURL.bind(URL);
    const nativeRevoke = URL.revokeObjectURL.bind(URL);

    URL.createObjectURL = (blob) => {
      window.__objectUrlsCreated += 1;
      return nativeCreate(blob);
    };

    URL.revokeObjectURL = (url) => {
      window.__objectUrlsRevoked += 1;
      return nativeRevoke(url);
    };
  });
}

export async function disableFileSystemAccess(page) {
  await page.addInitScript(() => {
    try {
      window.showSaveFilePicker = undefined;
    } catch {}

    try {
      delete window.showSaveFilePicker;
    } catch {}
  });
}

export async function disableOpfs(page) {
  await page.addInitScript(() => {
    try {
      Object.defineProperty(navigator.storage, 'getDirectory', {
        value: undefined,
        configurable: true,
      });
    } catch {}
  });
}

export async function listOpfsReceiveFiles(page) {
  return page.evaluate(async () => {
    if (typeof navigator.storage?.getDirectory !== 'function') {
      return [];
    }

    let directory;

    try {
      const root = await navigator.storage.getDirectory();
      directory = await root.getDirectoryHandle('twindrop-received', { create: false });
    } catch (error) {
      if (error?.name === 'NotFoundError') {
        return [];
      }

      throw error;
    }

    const files = [];

    for await (const [name, handle] of directory.entries()) {
      try {
        const file = await handle.getFile();
        files.push({
          name,
          size: file.size,
          lastModified: file.lastModified,
        });
      } catch {}
    }

    return files.sort((left, right) => left.name.localeCompare(right.name));
  });
}

export async function readOpfsReceiveFileContents(page) {
  return page.evaluate(async () => {
    if (typeof navigator.storage?.getDirectory !== 'function') {
      return [];
    }

    let directory;

    try {
      const root = await navigator.storage.getDirectory();
      directory = await root.getDirectoryHandle('twindrop-received', { create: false });
    } catch (error) {
      if (error?.name === 'NotFoundError') {
        return [];
      }

      throw error;
    }

    const files = [];

    for await (const [name, handle] of directory.entries()) {
      try {
        const file = await handle.getFile();
        files.push({
          name,
          size: file.size,
          text: await file.text(),
        });
      } catch {}
    }

    return files;
  });
}

export async function waitForOpfsEmpty(page) {
  await expect.poll(
    async () => (await listOpfsReceiveFiles(page)).length,
    { timeout: 15000 },
  ).toBe(0);
}

export async function installRuntimeCounters(page) {
  await page.addInitScript(() => {
    window.__spaMarker = 'initial';
    window.__rtcPeerConnections = 0;
    window.__socketIoWebSockets = 0;

    const NativePeerConnection = window.RTCPeerConnection;

    if (NativePeerConnection) {
      function WrappedPeerConnection(...args) {
        window.__rtcPeerConnections += 1;
        return new NativePeerConnection(...args);
      }

      WrappedPeerConnection.prototype = NativePeerConnection.prototype;
      Object.setPrototypeOf(WrappedPeerConnection, NativePeerConnection);
      window.RTCPeerConnection = WrappedPeerConnection;
    }

    const NativeWebSocket = window.WebSocket;

    if (NativeWebSocket) {
      function WrappedWebSocket(url, protocols) {
        if (String(url).includes('/socket.io/')) {
          window.__socketIoWebSockets += 1;
        }

        return new NativeWebSocket(url, protocols);
      }

      WrappedWebSocket.prototype = NativeWebSocket.prototype;
      Object.setPrototypeOf(WrappedWebSocket, NativeWebSocket);
      window.WebSocket = WrappedWebSocket;
    }
  });
}

export function collectPageErrors(page) {
  const errors = [];

  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('frame-ancestors')) {
      errors.push(`console: ${message.text()}`);
    }
  });

  return errors;
}

export async function readDownloadedText(page, fileName) {
  const item = page.locator('.history-item').filter({ hasText: fileName }).first();
  const button = item.locator('[data-action="download"]');

  await expect(button).toBeVisible({ timeout: 15000 });

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }),
    button.click(),
  ]);

  const downloadPath = await download.path();
  const { readFileSync } = await import('node:fs');
  return readFileSync(downloadPath, 'utf8');
}
