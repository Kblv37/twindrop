const SHARE_TARGET_DB = 'twindrop-share-target';
const SHARE_TARGET_STORE = 'files';
const SHARE_TARGET_KEY = 'shared-files';

async function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SHARE_TARGET_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SHARE_TARGET_STORE)) {
        db.createObjectStore(SHARE_TARGET_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveSharedFiles(files) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(SHARE_TARGET_STORE, 'readwrite');
    const store = transaction.objectStore(SHARE_TARGET_STORE);
    const request = store.put(files, SHARE_TARGET_KEY);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function getSharedFiles() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(SHARE_TARGET_STORE, 'readonly');
    const store = transaction.objectStore(SHARE_TARGET_STORE);
    const request = store.get(SHARE_TARGET_KEY);
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

async function clearSharedFiles() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(SHARE_TARGET_STORE, 'readwrite');
    const store = transaction.objectStore(SHARE_TARGET_STORE);
    const request = store.delete(SHARE_TARGET_KEY);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function isShareTargetRequest(request) {
  const url = new URL(request.url);
  return request.method === 'POST' && url.pathname === '/send.html';
}

async function notifyClientsOfSharedFiles() {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clients) {
    if (client.url.includes('/send.html')) {
      client.postMessage({ type: 'SHARED_FILES_AVAILABLE' });
    }
  }
}

async function handleShareTargetRequest(request) {
  try {
    const formData = await request.formData();
    const files = formData.getAll('files');

    const fileList = [];
    for (const file of files) {
      if (file instanceof File && file.size > 0) {
        const arrayBuffer = await file.arrayBuffer();
        fileList.push({
          name: file.name,
          type: file.type,
          size: file.size,
          lastModified: file.lastModified,
          data: arrayBuffer,
        });
      }
    }

    if (fileList.length > 0) {
      await saveSharedFiles(fileList);
      await notifyClientsOfSharedFiles();
    }

    return Response.redirect('/send.html', 303);
  } catch (error) {
    console.error('Share target error:', error);
    return Response.redirect('/send.html', 303);
  }
}

const CACHE_NAME = 'twindrop-v1';
const CACHE_URLS = [
  '/',
  '/send.html',
  '/index.html',
  '/manifest.json',
  '/styles.css',
  '/images/icon.png',
  '/images/pwd.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CACHE_URLS))
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

  event.respondWith(
    caches.match(request).then((cached) => {
      const networkFetch = fetch(request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => cached);

      return cached || networkFetch;
    })
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') {
    self.skipWaiting();
  }
});