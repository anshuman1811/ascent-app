// Offline-first sync engine.
//
// The device keeps two things in IndexedDB:
//   • the *base*: a byte-for-byte SQLite copy of the server database as of change-feed
//     sequence `baseSeq` (downloaded once, then kept current from GET /sync/changes);
//   • the *queue*: every write made while offline (or while earlier writes are still
//     waiting), as operations { method, path, body, ts, ids }.
// In memory, the working database = base + queue replayed through the same route handlers
// the server runs (localServer.ts). Reads offline are answered from it, so every screen —
// including server-computed views like the dashboard, PRs and progress — works offline
// with the server's own logic. When the server is reachable the queue is pushed in order,
// the feed is pulled, and the working copy is rebuilt from the new base.
//
// Online with nothing queued, requests go straight to the server exactly as before (the
// web app on the laptop behaves as it always has); the replica is just kept warm.
import initSqlJs, { type SqlJsStatic, type Database } from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import type { QueryClient } from '@tanstack/react-query';
import { apiUrl, getServerBase } from '../api/serverUrl';
import { isNative } from '../native/platform';
import { localDb } from './localDb';
import { dispatch, uuid, type LocalResult } from './localServer';
import * as idb from './idb';

// ─── Types ───────────────────────────────────────────────────────────────────
interface FileMeta { filename: string; originalname: string; mimetype: string }

export interface QueuedOp {
  n: number;
  op_id: string;
  method: string;
  path: string;
  body?: unknown;
  ts: number;
  ids: Record<string, number[]>;
  files?: FileMeta[];
}

interface Meta {
  deviceUuid: string;
  deviceId?: number;
  serverId?: string;
  schema?: string;
  baseSeq?: number;
  lastSyncAt?: number;
}

export interface SyncConflict {
  id: number;
  kind: 'field' | 'target_deleted' | 'rejected' | string;
  tbl: string | null;
  row_id: number | null;
  col: string | null;
  kept_value: unknown;
  discarded_value: unknown;
  winner_device_name?: string | null;
  detail: string | null;
  created_at: string;
}

export interface SyncState {
  phase: 'starting' | 'ready' | 'no-replica' | 'unsupported';
  online: boolean;
  syncing: boolean;
  pending: number;
  lastSyncAt: number | null;
  lastError: string | null;
  conflicts: SyncConflict[];
}

export class NetworkError extends Error {}

// ─── State + subscriptions (for the status indicator) ────────────────────────
let state: SyncState = {
  phase: 'starting', online: typeof navigator === 'undefined' ? true : navigator.onLine,
  syncing: false, pending: 0, lastSyncAt: null, lastError: null, conflicts: [],
};
const listeners = new Set<() => void>();
function setState(patch: Partial<SyncState>) {
  state = { ...state, ...patch };
  listeners.forEach(l => l());
}
export const getSyncState = () => state;
export function subscribeSync(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }

// ─── Module state ────────────────────────────────────────────────────────────
let SQL: SqlJsStatic | null = null;
let meta: Meta = { deviceUuid: '' };
let baseBytes: Uint8Array | null = null;
let queue: QueuedOp[] = [];
let replicaReady = false;
let queryClient: QueryClient | null = null;
const blobUrls = new Map<string, string>();
let idNext = 0;
let idEnd = 0;
const ID_BLOCK = 10_000;
const DEVICE_SPAN = 2 ** 32;
const channel: BroadcastChannel | null = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('ascent-sync') : null;

let metaReady: Promise<void> = Promise.resolve();
let replicaLoad: Promise<void> = Promise.resolve();
let started = false;

export function setQueryClient(qc: QueryClient) { queryClient = qc; }

function invalidateAll() { queryClient?.invalidateQueries(); }

// ─── Helpers ─────────────────────────────────────────────────────────────────
const sqlTime = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

function withFrozenClock<T>(ms: number, fn: () => T): T {
  const Real = Date;
  class Frozen extends Real {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(ms);
      else super(...(args as [string]));
    }
    static now() { return ms; }
  }
  (globalThis as { Date: DateConstructor }).Date = Frozen as unknown as DateConstructor;
  try { return fn(); } finally { (globalThis as { Date: DateConstructor }).Date = Real; }
}

const isServerOnly = (path: string) => path.startsWith('/ai/') || path.startsWith('/sync/');

function deviceLabel() {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return /Mobile/i.test(ua) ? 'Android phone' : 'Android tablet';
  if (/iPad/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/Macintosh/i.test(ua)) return 'Mac browser';
  if (/Windows/i.test(ua)) return 'Windows browser';
  return 'Browser';
}

async function rawFetch(path: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = timeoutMs ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  let res: Response;
  try {
    res = await fetch(apiUrl(path), { ...init, signal: ctrl.signal });
  } catch (e) {
    throw new NetworkError((e as Error)?.name === 'AbortError' ? 'Server did not respond' : 'Server unreachable');
  } finally {
    if (timer) clearTimeout(timer);
  }
  // A dev proxy / reverse proxy in front of a stopped server answers with these.
  if (res.status === 502 || res.status === 503 || res.status === 504) throw new NetworkError(`Server unavailable (${res.status})`);
  return res;
}

async function syncJson<T>(path: string, body?: unknown): Promise<T> {
  const res = await rawFetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }, 30_000);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Sync failed (${res.status})`);
  }
  return res.json();
}

function markOffline() {
  if (state.online) { setState({ online: false }); invalidateAll(); }
}

function markOnline() {
  if (!state.online) setState({ online: true });
}

// ─── Id ranges ───────────────────────────────────────────────────────────────
// Offline-created rows get ids -(deviceId·2³² + n): unique per device (deviceId comes
// from the server), never equal to a server id (those are positive), and they don't move
// SQLite's max(id)+1 on the server. Each tab reserves a block of n atomically in IDB.
async function ensureIds(min = 2000) {
  if (idEnd - idNext >= min) return;
  const end = await idb.kvUpdate<number>('idCounter', c => (c ?? 1) + ID_BLOCK);
  idNext = end - ID_BLOCK;
  idEnd = end;
}

function allocId() {
  if (!meta.deviceId) throw new Error('Device not registered');
  return -(meta.deviceId * DEVICE_SPAN + idNext++);
}

// ─── Running ops locally ─────────────────────────────────────────────────────
class LocalRejected extends Error { constructor(public result: LocalResult) { super(result.body?.error || `HTTP ${result.status}`); } }

function execOp(op: QueuedOp, replaying: boolean): LocalResult {
  localDb.op = { nowSql: sqlTime(op.ts), ids: {}, given: replaying ? op.ids : undefined, alloc: allocId };
  try {
    const result = withFrozenClock(op.ts, () => localDb.transaction(() => {
      const r = dispatch({ method: op.method, path: op.path, body: op.body, files: op.files });
      if (r.status >= 400) throw new LocalRejected(r);
      return r;
    })());
    op.ids = localDb.op.ids;
    return result;
  } finally {
    localDb.op = null;
  }
}

function sameIds(a: Record<string, number[]>, b: Record<string, number[]>) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** working = base + queue. Synchronous, so it never interleaves with a local write. */
function rebuild() {
  if (!SQL || !baseBytes) return;
  const db = new SQL.Database(baseBytes);
  db.exec('PRAGMA foreign_keys = ON');
  localDb.swap(db);
  const changed: QueuedOp[] = [];
  for (const op of queue) {
    const before = op.ids;
    try {
      execOp(op, true);
    } catch (e) {
      // Already applied on the server (ack lost) or its target is gone. Keep it queued:
      // the server decides, and dedupes by op id.
      op.ids = before;
      continue;
    }
    if (!sameIds(before, op.ids)) changed.push(op);
  }
  if (changed.length) idb.queuePut(changed).catch(() => {});
}

function fixImageUrls(body: unknown) {
  if (!blobUrls.size) return body;
  const fix = (x: any) => (x && typeof x.filename === 'string' && blobUrls.has(x.filename) ? { ...x, url: blobUrls.get(x.filename) } : x);
  return Array.isArray(body) ? body.map(fix) : fix(body);
}

function localRead<T>(path: string): T {
  const r = dispatch({ method: 'GET', path });
  if (r.status >= 400) throw new Error(r.body?.error || 'Request failed');
  return (path.startsWith('/images/') ? fixImageUrls(r.body) : r.body) as T;
}

let writeChain: Promise<unknown> = Promise.resolve();

function localWrite<T>(method: string, path: string, body: unknown, opId?: string, files?: FileMeta[]): Promise<T> {
  const run = async () => {
    await ensureIds();
    const ts = Date.now();
    const op: QueuedOp = {
      n: ts * 1000 + Math.floor(Math.random() * 1000), op_id: opId ?? uuid(), method, path, body, ts, ids: {}, files,
    };
    let r: LocalResult;
    try {
      r = execOp(op, false);
    } catch (e) {
      if (e instanceof LocalRejected) throw new Error(e.message);
      throw e;
    }
    queue.push(op);
    await idb.queuePut([op]); // durable before we report success
    setState({ pending: queue.length });
    channel?.postMessage({ type: 'queue' });
    scheduleSync(300);
    return (files ? fixImageUrls(r.body) : r.body) as T;
  };
  const p = writeChain.then(run, run);
  writeChain = p.catch(() => {});
  return p;
}

async function needReplica() {
  await replicaLoad;
  if (!replicaReady) {
    throw new Error(state.online
      ? 'Still downloading this device’s offline copy — try again in a moment'
      : 'You’re offline and this device has no offline copy yet');
  }
}

// ─── Direct (online) requests ────────────────────────────────────────────────
async function direct<T>(method: string, path: string, body: unknown, opId?: string, timeoutMs = 15_000): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opId) {
    headers['X-Ascent-Op-Id'] = opId;
    if (meta.deviceId) headers['X-Ascent-Device'] = String(meta.deviceId);
  }
  const res = await rawFetch(path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  }, timeoutMs);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Request failed');
  }
  return res.json();
}

function canGoDirect() {
  return state.online && queue.length === 0;
}

/** Entry point used by api.get/post/put/patch/delete. */
export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (isServerOnly(path)) {
    try { return await direct<T>(method, path, body, undefined, 0); }
    catch (e) {
      if (e instanceof NetworkError) { markOffline(); throw new Error('This needs a connection to the Ascent server'); }
      throw e;
    }
  }
  await metaReady.catch(() => {});
  if (state.phase === 'unsupported') return direct<T>(method, path, body);

  const isRead = method === 'GET';
  if (canGoDirect() || (!replicaReady && queue.length === 0)) {
    const opId = isRead ? undefined : uuid();
    try {
      const r = await direct<T>(method, path, body, opId, isRead ? 10_000 : 15_000);
      markOnline();
      if (!isRead) scheduleSync(800);
      return r;
    } catch (e) {
      if (!(e instanceof NetworkError)) throw e;
      markOffline();
      scheduleSync(5000);
      await needReplica();
      // Same op id: if the server did apply it before the connection dropped, the push
      // is recognised as a duplicate and not applied twice.
      return isRead ? localRead<T>(path) : localWrite<T>(method, path, body, opId);
    }
  }
  await needReplica();
  return isRead ? localRead<T>(path) : localWrite<T>(method, path, body);
}

/** Entry point used by api.upload (multipart image uploads). */
export async function upload<T>(path: string, fd: FormData): Promise<T> {
  await metaReady.catch(() => {});
  const viaServer = async () => {
    const opId = uuid();
    const headers: Record<string, string> = { 'X-Ascent-Op-Id': opId };
    if (meta.deviceId) headers['X-Ascent-Device'] = String(meta.deviceId);
    const res = await rawFetch(path, { method: 'POST', body: fd, headers }, 120_000);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || 'Upload failed');
    }
    scheduleSync(800);
    return res.json() as Promise<T>;
  };
  if (state.phase === 'unsupported' || path !== '/images') return viaServer();
  if (canGoDirect() || (!replicaReady && queue.length === 0)) {
    try { return await viaServer(); }
    catch (e) { if (!(e instanceof NetworkError)) throw e; markOffline(); }
  }
  await needReplica();
  // Offline: keep the photos in IndexedDB, create the images rows locally (real handler,
  // files handed over on req.files), and upload the bytes just before the queued op.
  const body: Record<string, string> = {};
  const stored: idb.StoredBlob[] = [];
  const files: FileMeta[] = [];
  fd.forEach((v, k) => {
    if (typeof v === 'string') { body[k] = v; return; }
    const ext = (/\.[a-z0-9]+$/i.exec(v.name)?.[0] ?? '.jpg').toLowerCase();
    const filename = `o-${uuid()}${ext}`;
    stored.push({ filename, type: v.type || 'image/jpeg', blob: v });
    files.push({ filename, originalname: v.name || filename, mimetype: v.type || 'image/jpeg' });
  });
  if (!files.length) throw new Error('No files uploaded');
  await idb.blobPut(stored);
  for (const s of stored) blobUrls.set(s.filename, URL.createObjectURL(s.blob));
  return localWrite<T>('POST', path, body, undefined, files);
}

// ─── Sync with the server ────────────────────────────────────────────────────
async function register() {
  const r = await syncJson<{ device_id: number; server_id: string }>('/sync/register', { uuid: meta.deviceUuid, name: deviceLabel() });
  meta.deviceId = r.device_id;
  await idb.kvSet({ meta });
}

async function downloadSnapshot() {
  const res = await rawFetch('/sync/snapshot', {}, 60_000);
  if (!res.ok) throw new Error(`Snapshot failed (${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const seq = Number(res.headers.get('X-Sync-Seq'));
  const serverId = res.headers.get('X-Sync-Server-Id');
  const schema = res.headers.get('X-Sync-Schema');
  if (!serverId || !schema || !Number.isFinite(seq)) throw new Error('Snapshot missing sync headers');
  if (meta.serverId && meta.serverId !== serverId) {
    // A different database (restored/replaced): this device's registration doesn't exist there.
    meta.deviceId = undefined;
  }
  baseBytes = bytes;
  meta = { ...meta, serverId, schema, baseSeq: seq };
  if (!meta.deviceId) await register();
  await idb.kvSet({ base: bytes, meta });
  channel?.postMessage({ type: 'base' });
}

interface FeedTable { columns: string[]; rows: Record<string, unknown>[]; deleted: number[] }
interface Feed { server_id: string; schema: string; seq: number; reset?: boolean; tables?: Record<string, FeedTable> }

/** Pull the change feed into the base. Returns true if the base changed. */
async function pull(): Promise<boolean> {
  if (!SQL || !baseBytes || !meta.deviceId) return false;
  const feed = await syncJson<Feed>(`/sync/changes?since=${meta.baseSeq ?? 0}&device=${meta.deviceId}`);
  if (feed.reset || feed.server_id !== meta.serverId || feed.schema !== meta.schema) {
    await downloadSnapshot();
    return true;
  }
  const tables = Object.entries(feed.tables ?? {});
  if (!tables.length) {
    if (feed.seq !== meta.baseSeq) { meta.baseSeq = feed.seq; await idb.kvSet({ meta }); }
    return false;
  }
  const db: Database = new SQL.Database(baseBytes);
  try {
    db.exec('PRAGMA foreign_keys = OFF; BEGIN');
    // Deletes first, then upserts: the server's state is consistent at feed time, so any
    // row a REPLACE displaces on a unique index is one the feed changes anyway.
    for (const [t, { deleted }] of tables) {
      for (let i = 0; i < deleted.length; i += 500) {
        const chunk = deleted.slice(i, i + 500);
        db.run(`DELETE FROM "${t}" WHERE id IN (${chunk.map(() => '?').join(',')})`, chunk);
      }
    }
    for (const [t, { columns, rows }] of tables) {
      if (!rows.length) continue;
      const stmt = db.prepare(`INSERT OR REPLACE INTO "${t}" (${columns.map(c => `"${c}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
      try {
        for (const row of rows) stmt.run(columns.map(c => (row[c] ?? null) as never));
      } finally { stmt.free(); }
    }
    db.exec('COMMIT');
    baseBytes = db.export();
  } finally {
    db.close();
  }
  meta.baseSeq = feed.seq;
  await idb.kvSet({ base: baseBytes, meta });
  channel?.postMessage({ type: 'base' });
  return true;
}

interface PushResult { op_id: string; status: string; http_status?: number; error?: string; conflicts?: SyncConflict[] }

/** Push the queue in order. Returns true if any op was acknowledged. */
async function flush(): Promise<boolean> {
  let any = false;
  while (queue.length && meta.deviceId) {
    const batch = queue.slice(0, 100);
    const files = batch.flatMap(op => op.files ?? []);
    if (files.length) {
      const have = new Map((await idb.blobAll()).map(b => [b.filename, b]));
      const fd = new FormData();
      let count = 0;
      for (const f of files) {
        const b = have.get(f.filename);
        if (b) { fd.append('files', new File([b.blob], f.filename, { type: b.type })); count++; }
      }
      if (count) {
        const res = await rawFetch('/sync/blobs', { method: 'POST', body: fd }, 120_000);
        if (!res.ok) throw new Error(`Photo upload failed (${res.status})`);
      }
    }
    const { results } = await syncJson<{ results: PushResult[] }>('/sync/push', {
      device_id: meta.deviceId,
      ops: batch.map(({ n: _n, ...op }) => op),
    });
    const acked = new Set<string>();
    for (const r of results) {
      if (r.status === 'retry') break;
      acked.add(r.op_id);
    }
    if (!acked.size) break;
    const done = queue.filter(op => acked.has(op.op_id));
    queue = queue.filter(op => !acked.has(op.op_id));
    await idb.queueDelete(done.map(op => op.n));
    await idb.blobDelete(done.flatMap(op => (op.files ?? []).map(f => f.filename)));
    setState({ pending: queue.length });
    channel?.postMessage({ type: 'queue' });
    any = true;
    if (acked.size < batch.length) break;
  }
  return any;
}

async function refreshConflicts() {
  if (!meta.deviceId) return;
  const conflicts = await syncJson<SyncConflict[]>(`/sync/conflicts?device=${meta.deviceId}`);
  setState({ conflicts });
}

export async function dismissConflicts(ids: number[]) {
  await syncJson('/sync/conflicts/dismiss', { ids });
  setState({ conflicts: state.conflicts.filter(c => !ids.includes(c.id)) });
}

async function bootstrap() {
  if (!SQL) return;
  if (!meta.deviceId) await register();
  await downloadSnapshot();
  await ensureIds();
  rebuild();
  replicaReady = true;
  setState({ phase: 'ready' });
}

let syncing: Promise<void> | null = null;
let lastSyncAttempt = 0;

export function syncNow(): Promise<void> {
  if (syncing) return syncing;
  lastSyncAttempt = Date.now();
  syncing = (async () => {
    await metaReady;
    await replicaLoad;
    if (!SQL) return;
    setState({ syncing: true });
    try {
      const wasLocal = !canGoDirect();
      if (!replicaReady) await bootstrap();
      const pushed = await flush();
      const pulled = await pull();
      if (pushed || pulled) {
        await ensureIds();
        rebuild();
      }
      markOnline();
      await refreshConflicts();
      setState({ lastSyncAt: Date.now(), lastError: null });
      meta.lastSyncAt = Date.now();
      await idb.kvSet({ meta });
      // Online with an empty queue the views read from the server again — refresh them
      // once when that switch happens, or whenever they were reading the local copy.
      if (pushed || (pulled && wasLocal)) invalidateAll();
    } catch (e) {
      if (e instanceof NetworkError) markOffline();
      else setState({ lastError: (e as Error).message || 'Sync failed' });
    } finally {
      setState({ syncing: false });
      syncing = null;
    }
  })();
  return syncing;
}

let syncTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSync(ms: number) {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { syncTimer = null; if (state.online || queue.length) void probeThenSync(); }, ms);
}

async function probe(): Promise<boolean> {
  try {
    const res = await rawFetch('/health', { cache: 'no-store' }, 4000);
    return res.ok;
  } catch { return false; }
}

async function probeThenSync() {
  if (!state.online) {
    if (!(await probe())) return;
    markOnline();
  }
  await syncNow();
}

function tick() {
  if (state.phase === 'unsupported') return;
  if (!state.online) { void probeThenSync(); return; }
  if (typeof document !== 'undefined' && document.hidden && !queue.length) return;
  if (queue.length || Date.now() - lastSyncAttempt > 20_000 || !replicaReady) void syncNow();
}

// ─── Startup ─────────────────────────────────────────────────────────────────
async function reloadFromIdb(kind: 'queue' | 'base') {
  if (kind === 'queue') {
    queue = (await idb.queueAll<QueuedOp>()).sort((a, b) => a.n - b.n);
    setState({ pending: queue.length });
  } else {
    const m = await idb.kvGet<Meta>('meta');
    if (m && (m.baseSeq ?? 0) > (meta.baseSeq ?? 0) && m.serverId === meta.serverId) {
      const b = await idb.kvGet<Uint8Array>('base');
      if (b) { baseBytes = b; meta = { ...meta, ...m }; }
    } else return;
  }
  if (replicaReady) { await ensureIds(); rebuild(); invalidateAll(); }
}

export function startSyncEngine() {
  if (started) return;
  // Android before a server address is entered: nothing to sync with yet, and the local
  // store is keyed by that address — wait for it (the connect screen sets it in place).
  if (isNative() && !getServerBase()) {
    const wait = setInterval(() => { if (getServerBase()) { clearInterval(wait); startSyncEngine(); } }, 500);
    return;
  }
  started = true;
  if (typeof indexedDB === 'undefined' || typeof WebAssembly === 'undefined') {
    setState({ phase: 'unsupported' });
    return;
  }
  metaReady = (async () => {
    const m = await idb.kvGet<Meta>('meta');
    meta = m ?? { deviceUuid: uuid() };
    if (!m) await idb.kvSet({ meta });
    queue = (await idb.queueAll<QueuedOp>()).sort((a, b) => a.n - b.n);
    setState({ pending: queue.length, lastSyncAt: meta.lastSyncAt ?? null });
  })().catch(e => {
    console.warn('[offline] IndexedDB unavailable — online only', e);
    setState({ phase: 'unsupported' });
  });

  replicaLoad = metaReady.then(async () => {
    if (state.phase === 'unsupported') return;
    SQL = await initSqlJs({ locateFile: () => wasmUrl });
    for (const b of await idb.blobAll()) blobUrls.set(b.filename, URL.createObjectURL(b.blob));
    const bytes = await idb.kvGet<Uint8Array>('base');
    if (bytes && meta.deviceId) {
      baseBytes = bytes;
      await ensureIds();
      rebuild();
      replicaReady = true;
      setState({ phase: 'ready' });
    } else {
      setState({ phase: 'no-replica' });
    }
  }).catch(e => {
    console.warn('[offline] could not load the local database', e);
    setState({ phase: 'unsupported', lastError: 'Offline mode unavailable on this device' });
  });

  replicaLoad.then(() => {
    if (state.phase === 'unsupported') return;
    void syncNow();
    setInterval(tick, 5000);
  });

  window.addEventListener('online', () => void probeThenSync());
  window.addEventListener('offline', () => markOffline());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void probeThenSync(); });
  channel?.addEventListener('message', ev => { void reloadFromIdb(ev.data?.type === 'base' ? 'base' : 'queue'); });
}

/** Test/debug hook (window.__ascentSync). */
export const debug = {
  get queue() { return queue; },
  get meta() { return meta; },
  get state() { return state; },
  syncNow,
  request,
  upload,
  sql: (q: string) => localDb.raw.exec(q),
};
