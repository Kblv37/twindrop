const DB_NAME = 'twindrop-share-target';
const DB_VERSION = 2;
const SHARE_TARGET_STORE = 'files';
// Legacy versions stored every pending share as one array under this key.
// New records are stored one per key (the record id) so concurrent writers
// cannot overwrite each other.
const SHARE_TARGET_KEY = 'shared-files';
const QUEUE_STORE = 'queue';

function createSharedId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  return `share-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeSharedRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return null;
  }

  const id = typeof record.id === 'string' && record.id
    ? record.id
    : createSharedId();

  return {
    ...record,
    id,
    createdAt: Number(record.createdAt) || Number(record.lastModified) || 0,
  };
}

function compareSharedRecords(left, right) {
  return (left.createdAt - right.createdAt) || left.id.localeCompare(right.id);
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

export function openShareDatabase() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('indexeddb-unavailable'));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      // Version 1 only had the Web Share Target store. Keep it intact and add
      // the queue store in place instead of creating a second database.
      if (!db.objectStoreNames.contains(SHARE_TARGET_STORE)) {
        db.createObjectStore(SHARE_TARGET_STORE);
      }

      if (!db.objectStoreNames.contains(QUEUE_STORE)) {
        db.createObjectStore(QUEUE_STORE, { keyPath: 'id' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('indexeddb-blocked'));
  });
}

export function isQuotaError(error) {
  if (!error) {
    return false;
  }

  return error.name === 'QuotaExceededError'
    || error.name === 'NS_ERROR_DOM_QUOTA_REACHED'
    || error.code === 22
    || error.code === 1014;
}

export async function getSharedFiles() {
  const db = await openShareDatabase();

  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(SHARE_TARGET_STORE, 'readwrite');
      const store = transaction.objectStore(SHARE_TARGET_STORE);
      const keysRequest = store.getAllKeys();
      const valuesRequest = store.getAll();
      const recordsById = new Map();
      let keys = null;
      let values = null;
      let processed = false;
      let settled = false;

      const fail = (error) => {
        if (settled) {
          return;
        }

        settled = true;
        try {
          transaction.abort();
        } catch {}
        reject(error);
      };

      const processRecords = () => {
        if (processed || keys === null || values === null) {
          return;
        }

        processed = true;

        try {
          for (let index = 0; index < values.length; index += 1) {
            const key = keys[index];
            const value = values[index];

            if (key === SHARE_TARGET_KEY && Array.isArray(value)) {
              for (const legacyRecord of value) {
                const record = normalizeSharedRecord(legacyRecord);

                if (!record) {
                  continue;
                }

                store.put(record, record.id);
                recordsById.set(record.id, record);
              }

              store.delete(SHARE_TARGET_KEY);
              continue;
            }

            if (Array.isArray(value)) {
              continue;
            }

            const record = normalizeSharedRecord(value);

            if (!record) {
              continue;
            }

            if (key !== record.id) {
              store.delete(key);
              store.put(record, record.id);
            }

            recordsById.set(record.id, record);
          }
        } catch (error) {
          fail(error);
        }
      };

      keysRequest.onsuccess = () => {
        keys = Array.isArray(keysRequest.result) ? keysRequest.result : [];
        processRecords();
      };
      valuesRequest.onsuccess = () => {
        values = Array.isArray(valuesRequest.result) ? valuesRequest.result : [];
        processRecords();
      };
      keysRequest.onerror = () => fail(keysRequest.error);
      valuesRequest.onerror = () => fail(valuesRequest.error);
      transaction.oncomplete = () => {
        if (settled) {
          return;
        }

        settled = true;
        resolve([...recordsById.values()].sort(compareSharedRecords));
      };
      transaction.onerror = () => fail(transaction.error);
      transaction.onabort = () => fail(transaction.error || new Error('indexeddb-aborted'));
    });
  } finally {
    db.close();
  }
}

export async function putSharedFiles(records) {
  const normalized = (Array.isArray(records) ? records : [])
    .map(normalizeSharedRecord)
    .filter(Boolean);

  if (normalized.length === 0) {
    return;
  }

  const db = await openShareDatabase();

  try {
    const transaction = db.transaction(SHARE_TARGET_STORE, 'readwrite');
    const store = transaction.objectStore(SHARE_TARGET_STORE);
    const done = transactionDone(transaction);

    try {
      for (const record of normalized) {
        store.put(record, record.id);
      }
    } catch (error) {
      try {
        transaction.abort();
      } catch {}
    }

    await done;
  } finally {
    db.close();
  }
}

export async function deleteSharedFiles(ids) {
  const uniqueIds = [...new Set(Array.isArray(ids) ? ids : [])]
    .filter((id) => typeof id === 'string' && id);

  if (uniqueIds.length === 0) {
    return;
  }

  const db = await openShareDatabase();

  try {
    const transaction = db.transaction(SHARE_TARGET_STORE, 'readwrite');
    const store = transaction.objectStore(SHARE_TARGET_STORE);
    const done = transactionDone(transaction);

    try {
      for (const id of uniqueIds) {
        store.delete(id);
      }
    } catch (error) {
      try {
        transaction.abort();
      } catch {}
    }

    await done;
  } finally {
    db.close();
  }
}

export async function markSharedFilesRejected(records, reason = 'rejected') {
  const rejectedAt = Date.now();
  const updates = (Array.isArray(records) ? records : [])
    .filter(Boolean)
    .map((record) => ({
      ...record,
      rejectedAt,
      rejectReason: String(reason || 'rejected'),
    }));

  await putSharedFiles(updates);
}

export async function clearSharedFiles() {
  const db = await openShareDatabase();

  try {
    const transaction = db.transaction(SHARE_TARGET_STORE, 'readwrite');
    const store = transaction.objectStore(SHARE_TARGET_STORE);
    const done = transactionDone(transaction);

    try {
      store.clear();
    } catch (error) {
      try {
        transaction.abort();
      } catch {}
    }

    await done;
  } finally {
    db.close();
  }
}

export function isSharedRecordUsable(record) {
  return Boolean(
    record
    && typeof record.name === 'string'
    && (record.blob || record.data),
  );
}

export function sharedRecordToFile(record) {
  return new File([record.blob || record.data], record.name, {
    type: record.type || '',
    lastModified: Number(record.lastModified) || Date.now(),
  });
}

export function sharedRecordsToFiles(records) {
  return records
    .filter(isSharedRecordUsable)
    .map(sharedRecordToFile);
}

export async function loadQueueRecords() {
  const db = await openShareDatabase();

  try {
    const transaction = db.transaction(QUEUE_STORE, 'readonly');
    const store = transaction.objectStore(QUEUE_STORE);
    const records = await requestToPromise(store.getAll());
    return Array.isArray(records) ? records : [];
  } finally {
    db.close();
  }
}

export async function putQueueRecord(record) {
  const db = await openShareDatabase();

  try {
    const transaction = db.transaction(QUEUE_STORE, 'readwrite');
    transaction.objectStore(QUEUE_STORE).put(record);
    await transactionDone(transaction);
  } finally {
    db.close();
  }
}

export async function deleteQueueRecord(id) {
  const db = await openShareDatabase();

  try {
    const transaction = db.transaction(QUEUE_STORE, 'readwrite');
    transaction.objectStore(QUEUE_STORE).delete(id);
    await transactionDone(transaction);
  } finally {
    db.close();
  }
}

export async function clearQueueRecords() {
  const db = await openShareDatabase();

  try {
    const transaction = db.transaction(QUEUE_STORE, 'readwrite');
    transaction.objectStore(QUEUE_STORE).clear();
    await transactionDone(transaction);
  } finally {
    db.close();
  }
}

export async function replaceQueueRecords(records) {
  const db = await openShareDatabase();

  try {
    const transaction = db.transaction(QUEUE_STORE, 'readwrite');
    const store = transaction.objectStore(QUEUE_STORE);
    store.clear();

    for (const record of records) {
      store.put(record);
    }

    await transactionDone(transaction);
  } finally {
    db.close();
  }
}
