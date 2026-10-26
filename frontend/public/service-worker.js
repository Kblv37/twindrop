const SHARE_TARGET_DB = 'twindrop-share-target';
const SHARE_TARGET_DB_VERSION = 2;
const SHARE_TARGET_STORE = 'files';
const QUEUE_STORE = 'queue';
const SW_VERSION = '__TWINDROP_BUILD_VERSION__';
const CACHE_NAME = `twindrop-${SW_VERSION}`;
const SEND_PAGE_PATHS = new Set(['/s', '/send', '/send.html']);
const CACHE_URLS = [
  '/',
  '/manifest.json',
  '/images/icon.png',
  '/images/icon64.ico',
  '/images/pwd.png',
];

async function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SHARE_TARGET_DB, SHARE_TARGET_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SHARE_TARGET_STORE)) {
        db.createObjectStore(SHARE_TARGET_STORE);
      }
      // The application stores its persistent file queue in the same database.
      // Creating it here avoids opening v2 without the queue store when the
      // service worker upgrades the schema first.
      if (!db.objectStoreNames.contains(QUEUE_STORE)) {
        db.createObjectStore(QUEUE_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('indexeddb-blocked'));
  });
}

function createSharedId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  return `share-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function appendSharedFiles(files) {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(SHARE_TARGET_STORE, 'readwrite');
    const store = transaction.objectStore(SHARE_TARGET_STORE);
    let settled = false;

    const finish = (callback, value) => {
      if (settled) {
        return;
      }

      settled = true;
      db.close();
      callback(value);
    };

    transaction.oncomplete = () => finish(resolve);
    transaction.onerror = () => finish(reject, transaction.error);
    transaction.onabort = () => finish(reject, transaction.error || new Error('indexeddb-aborted'));

    try {
      // One key per file means two concurrent POST requests cannot overwrite
      // each other's records.
      for (const file of files) {
        store.put(file, file.id);
      }
    } catch (error) {
      try {
        transaction.abort();
      } catch {}
      finish(reject, error);
    }
  });
}

function isSendPagePath(pathname) {
  return SEND_PAGE_PATHS.has(pathname);
}

function isShareTargetRequest(request) {
  const url = new URL(request.url);
  return request.method === 'POST' && isSendPagePath(url.pathname);
}

function shouldBypassCache(request) {
  const url = new URL(request.url);

  if (url.origin !== self.location.origin) {
    return true;
  }

  return url.pathname === '/app-config.js'
    || url.pathname === '/service-worker.js'
    || url.pathname === '/api'
    || url.pathname.startsWith('/api/')
    || url.pathname === '/socket.io'
    || url.pathname.startsWith('/socket.io/');
}

async function notifyClientsOfSharedFiles() {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clients) {
    try {
      client.postMessage({ type: 'SHARED_FILES_AVAILABLE' });
    } catch {
      // Ignore clients that have already closed.
    }
  }
}

function shareTargetRedirect(errorCode = '') {
  const url = new URL('/s', self.location.origin);

  if (errorCode) {
    url.searchParams.set('shareError', errorCode);
  }

  return Response.redirect(url.href, 303);
}

async function handleShareTargetRequest(request) {
  let formData;

  try {
    formData = await request.formData();
  } catch (error) {
    console.error('Share target form error:', error);
    return shareTargetRedirect('request');
  }

  const files = formData.getAll('files');
  const fileList = [];
  let readFailed = false;

  for (const file of files) {
    if (!(file instanceof File)) {
      continue;
    }

    try {
      const arrayBuffer = await file.arrayBuffer();
      fileList.push({
        id: createSharedId(),
        name: file.name,
        type: file.type,
        size: file.size,
        lastModified: file.lastModified,
        data: arrayBuffer,
        createdAt: Date.now(),
      });
    } catch (error) {
      // Keep processing the remaining files. The redirect reports that at
      // least one file could not be read, so the application can notify the
      // user instead of silently dropping it.
      readFailed = true;
      console.error('Share target file read error:', error);
    }
  }

  if (fileList.length > 0) {
    try {
      await appendSharedFiles(fileList);
      await notifyClientsOfSharedFiles();
    } catch (error) {
      // The transaction aborts atomically. Previously pending records are
      // untouched and remain available for the next import attempt.
      console.error('Share target storage error:', error);
      return shareTargetRedirect('storage');
    }
  }

  return shareTargetRedirect(readFailed ? 'read' : '');
}

async function networkFirstNavigation(request) {
  const cache = await caches.open(CACHE_NAME);

  try {
    const response = await fetch(request);

    if (response.ok) {
      await cache.put('/index.html', response.clone());
    }

    return response;
  } catch {
    const cached = await cache.match('/index.html') || await cache.match('/');

    if (cached) {
      return cached;
    }

    return new Response(
      '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Twindrop</title></head><body><h1>Twindrop</h1><p>Нет подключения к сети. Откройте приложение снова, когда соединение восстановится.</p></body></html>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    );
  }
}

async function cacheFirstAsset(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  if (cached) {
    return cached;
  }

  const response = await fetch(request);

  if (response.ok) {
    cache.put(request, response.clone());
  }

  return response;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response.ok) {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch((error) => {
      if (cached) {
        return cached;
      }
      throw error;
    });

  return cached || network;
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(
        CACHE_URLS.map((url) =>
          cache.add(url).catch((error) => {
            console.warn(`Failed to precache ${url}:`, error);
          })
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  if (isShareTargetRequest(request)) {
    event.respondWith(handleShareTargetRequest(request));
    return;
  }

  if (request.method !== 'GET') {
    return;
  }

  if (shouldBypassCache(request)) {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  const url = new URL(request.url);

  if (url.pathname.startsWith('/assets/')) {
    // Vite emits content-hashed asset names, so these files are immutable.
    event.respondWith(cacheFirstAsset(request));
    return;
  }

  event.respondWith(staleWhileRevalidate(request));
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') {
    self.skipWaiting();
  }
});
