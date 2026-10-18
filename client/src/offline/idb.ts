// Minimal promise wrapper over IndexedDB. Three stores:
//   kv     — meta (device id, base seq, id counter…) and the base replica bytes
//   queue  — pending operations, keyed by a local monotonic sequence number `n`
//   blobs  — photos taken offline, keyed by filename, until the server has them
//
// One IndexedDB database per server address: pointing the Android app at a different
// server (Settings → reload) gives it a separate replica, queue and device registration,
// and pointing it back finds the old ones — unsynced changes are never pushed to the
// wrong server. In the browser the base is '' (same origin), so the name is fixed.
import { getServerBase } from '../api/serverUrl';

const VERSION = 1;

let dbp: Promise<IDBDatabase> | null = null;

export function dbName() {
  const base = getServerBase();
  return base ? `ascent-offline:${base}` : 'ascent-offline';
}

function open(): Promise<IDBDatabase> {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName(), VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('queue')) db.createObjectStore('queue', { keyPath: 'n' });
        if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs', { keyPath: 'filename' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('IndexedDB blocked'));
    });
  }
  return dbp;
}

function done(tx: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

function req<T>(r: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  const db = await open();
  return req(db.transaction('kv').objectStore('kv').get(key)) as Promise<T | undefined>;
}

export async function kvSet(entries: Record<string, unknown>) {
  const db = await open();
  const tx = db.transaction('kv', 'readwrite');
  const s = tx.objectStore('kv');
  for (const [k, v] of Object.entries(entries)) s.put(v, k);
  return done(tx);
}

/** Atomically read-modify-write one kv entry (used to reserve id blocks across tabs). */
export async function kvUpdate<T>(key: string, fn: (cur: T | undefined) => T): Promise<T> {
  const db = await open();
  const tx = db.transaction('kv', 'readwrite');
  const s = tx.objectStore('kv');
  let next!: T;
  const r = s.get(key);
  r.onsuccess = () => { next = fn(r.result as T | undefined); s.put(next, key); };
  await done(tx);
  return next;
}

export async function queueAll<T>(): Promise<T[]> {
  const db = await open();
  return req(db.transaction('queue').objectStore('queue').getAll()) as Promise<T[]>;
}

export async function queuePut(ops: unknown[]) {
  const db = await open();
  const tx = db.transaction('queue', 'readwrite');
  for (const op of ops) tx.objectStore('queue').put(op);
  return done(tx);
}

export async function queueDelete(keys: number[]) {
  if (!keys.length) return;
  const db = await open();
  const tx = db.transaction('queue', 'readwrite');
  for (const k of keys) tx.objectStore('queue').delete(k);
  return done(tx);
}

export interface StoredBlob { filename: string; type: string; blob: Blob }

export async function blobPut(items: StoredBlob[]) {
  const db = await open();
  const tx = db.transaction('blobs', 'readwrite');
  for (const b of items) tx.objectStore('blobs').put(b);
  return done(tx);
}

export async function blobAll(): Promise<StoredBlob[]> {
  const db = await open();
  return req(db.transaction('blobs').objectStore('blobs').getAll()) as Promise<StoredBlob[]>;
}

export async function blobDelete(names: string[]) {
  if (!names.length) return;
  const db = await open();
  const tx = db.transaction('blobs', 'readwrite');
  for (const n of names) tx.objectStore('blobs').delete(n);
  return done(tx);
}
