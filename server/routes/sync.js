// Offline sync API (/api/sync) and the replay engine behind it.
//
// Devices keep a full SQLite replica and run the same route handlers locally while
// offline (see client/src/offline/). Every local write is queued as an *operation*:
//   { op_id, method, path, body, ts, ids: { table: [id, …] }, files? }
// `ids` are the primary keys the device's local run gave to the rows it inserted. They
// come from a range private to the device (negative numbers, see client idAllocator), so
// two devices can never pick the same id and the server's own max(id)+1 never moves.
//
// POST /push replays each operation through the very same Express router the HTTP API
// uses, inside one transaction per op, with:
//   • the inserted rows forced to the device's ids (so later queued ops that reference an
//     offline-created meal / workout / set land on the right row, with no id rewriting),
//   • the clock frozen to when the user actually did it (SQL 'now' and JS Date),
//   • sync_ctx.replay = 1 so the field-clock triggers apply last-writer-wins,
//   • the op id recorded in sync_ops, so a retried push is answered, never re-applied.
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('../db/index');
const mounts = require('./mounts');
const { syncedTables, columnsOf, schemaHash, compactChanges } = require('../db/sync-schema');

const router = express.Router();
const UPLOADS_DIR = path.join(__dirname, '../../data/uploads');
const SCHEMA = schemaHash(db);
const SERVER_ID = db.prepare("SELECT value FROM sync_meta WHERE key = 'server_id'").get().value;
const MAX_FEED_ROWS = 20000;

// Old op records are only needed to answer retries; a device that has been offline for
// longer than this re-pushes ops that are then treated as new (documented limitation).
db.prepare("DELETE FROM sync_ops WHERE applied_at < datetime('now', '-120 days')").run();

const maxSeq = () => db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM sync_changes').get().s;

// ─── Write context read by the sync triggers ─────────────────────────────────
const setCtxStmt = db.prepare('UPDATE sync_ctx SET replay = ?, ts = ?, device_id = ?, op_id = ? WHERE id = 1');
const setCtx = (replay, ts, deviceId, opId) => setCtxStmt.run(replay, ts ?? null, deviceId ?? null, opId ?? null);
const resetCtx = () => setCtxStmt.run(0, null, null, null);

// ─── Replay mode: forced ids + frozen clock ──────────────────────────────────
// Route handlers call db.prepare() inline, so wrapping prepare while an op replays is
// enough to reach every statement they run. Outside a replay this is a passthrough.
const INSERT_RE = /^(\s*INSERT\s+(?:OR\s+\w+\s+)?INTO\s+)("?)(\w+)\2(\s*)\(([^)]*)\)(\s*VALUES\s*)\(/i;
let replay = null; // { ids: {table: [..]}, used: {table: [..]}, nowSql }

function rewriteInsert(sql) {
  const m = sql.match(INSERT_RE);
  if (!m) return null;
  const cols = m[5].split(',').map(c => c.trim().replace(/"/g, ''));
  if (cols.includes('id')) return null;
  const table = m[3];
  const rewritten = sql.replace(INSERT_RE, (_all, a, qt, t, sp, c, v) => `${a}${qt}${t}${qt}${sp}(id, ${c})${v}(?, `);
  return { table, sql: rewritten };
}

function sqlTime(ms) { return new Date(ms).toISOString().replace('T', ' ').slice(0, 19); }

function withFrozenClock(ms, fn) {
  const RealDate = Date;
  class FrozenDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(ms); else super(...args); }
    static now() { return ms; }
  }
  global.Date = FrozenDate;
  try { return fn(); } finally { global.Date = RealDate; }
}

const origPrepare = db.prepare.bind(db);
db.prepare = function prepare(sql) {
  if (!replay) return origPrepare(sql);
  const timed = sql.replace(/'now'/gi, `'${replay.nowSql}'`);
  const ins = rewriteInsert(timed);
  if (!ins) return origPrepare(timed);
  const stmt = origPrepare(ins.sql);
  const ctx = replay;
  return {
    run(...params) {
      const queue = ctx.ids[ins.table] || [];
      const used = (ctx.used[ins.table] ||= []);
      const id = queue[used.length] ?? null; // null → SQLite picks the id as usual
      used.push(id);
      return stmt.run(id, ...params);
    },
    get: (...p) => stmt.get(...p),
    all: (...p) => stmt.all(...p),
  };
};

// ─── In-process dispatch through the real routers ────────────────────────────
function findMount(pathname) {
  return mounts.find(m => pathname === m.path || pathname.startsWith(m.path + '/'));
}

function dispatch({ method, path: fullPath, body, files }) {
  const [pathname, qs = ''] = fullPath.split('?');
  const mount = findMount(pathname);
  if (!mount || mount.offline === false) return { status: 404, body: { error: 'Not found' } };
  const handler = require('./' + mount.module);
  const req = {
    method: method.toUpperCase(),
    url: (pathname.slice(mount.path.length) || '/') + (qs ? `?${qs}` : ''),
    originalUrl: '/api' + fullPath,
    baseUrl: '',
    headers: {},
    query: Object.fromEntries(new URLSearchParams(qs)),
    body: body ?? {},
    files,
    params: {},
    get: () => undefined,
    header: () => undefined,
  };
  let result = null;
  let error = null;
  const res = {
    statusCode: 200,
    headersSent: false,
    status(c) { this.statusCode = c; return this; },
    json(b) { result = { status: this.statusCode, body: b === undefined ? null : JSON.parse(JSON.stringify(b)) }; return this; },
    send(b) { result = { status: this.statusCode, body: b ?? null }; return this; },
    end() { result ||= { status: this.statusCode, body: null }; return this; },
    set() { return this; }, setHeader() {}, type() { return this; },
  };
  handler.handle(req, res, err => { error = err || Object.assign(new Error('Not found'), { status: 404 }); });
  if (error) {
    if (error.status && error.status < 500) return { status: error.status, body: { error: error.message } };
    throw error;
  }
  if (!result) throw new Error(`Handler for ${method} ${fullPath} did not respond synchronously`);
  return result;
}

// ─── Applying one queued op ──────────────────────────────────────────────────
const getOpStmt = db.prepare('SELECT * FROM sync_ops WHERE op_id = ?');
const insOpStmt = db.prepare(`
  INSERT OR REPLACE INTO sync_ops (op_id, device_id, method, path, client_ts, source, status, http_status, response, seq)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const insConflict = db.prepare(`
  INSERT INTO sync_conflicts (kind, tbl, row_id, device_id, op_id, op_ts, detail) VALUES (?, ?, ?, ?, ?, ?, ?)`);

class Rejected extends Error { constructor(r) { super(r.body?.error || `HTTP ${r.status}`); this.result = r; } }

function describe(op) { return `${op.method} ${op.path}`; }

function opResult(row, extra = {}) {
  let response = null;
  try { response = row.response ? JSON.parse(row.response) : null; } catch { response = null; }
  return { op_id: row.op_id, status: row.status, http_status: row.http_status, response, ...extra };
}

function conflictsForOp(opId) {
  return db.prepare('SELECT * FROM sync_conflicts WHERE op_id = ? ORDER BY id').all(opId);
}

function applyOp(deviceId, op) {
  const prev = getOpStmt.get(op.op_id);
  if (prev) return opResult(prev, { duplicate: true, conflicts: conflictsForOp(op.op_id) });

  const method = String(op.method || '').toUpperCase();
  const ts = Number.isFinite(op.ts) ? op.ts : Date.now();
  let files;
  if (Array.isArray(op.files)) {
    files = op.files.map(f => ({ ...f, filename: path.basename(String(f.filename)) }));
    const missing = files.filter(f => !fs.existsSync(path.join(UPLOADS_DIR, f.filename)));
    if (missing.length) return { op_id: op.op_id, status: 'retry', error: 'image files not uploaded yet' };
  }

  try {
    const result = db.transaction(() => {
      setCtx(1, ts, deviceId, op.op_id);
      replay = { ids: op.ids || {}, used: {}, nowSql: sqlTime(ts) };
      let r;
      try {
        r = withFrozenClock(ts, () => dispatch({ method, path: op.path, body: op.body, files }));
      } finally {
        replay = null;
      }
      // A 404 on an edit means its target was deleted (on another device, or by an earlier
      // op): deletes win, so the edit is dropped — recorded, not retried.
      const targetGone = r.status === 404 || ((method === 'PUT' || method === 'PATCH') && r.status < 400 && r.body === null);
      if (targetGone) {
        if (method !== 'DELETE') {
          insConflict.run('target_deleted', null, null, deviceId, op.op_id, ts,
            `${describe(op)} — the item was deleted on another device, so this change was dropped`);
        }
        insOpStmt.run(op.op_id, deviceId, method, op.path, ts, 'push', 'noop', r.status, JSON.stringify(r.body), maxSeq());
        return { ...r, status_label: 'noop' };
      }
      if (r.status >= 400) throw new Rejected(r);
      insOpStmt.run(op.op_id, deviceId, method, op.path, ts, 'push', 'applied', r.status, JSON.stringify(r.body), maxSeq());
      return { ...r, status_label: 'applied' };
    })();
    return {
      op_id: op.op_id, status: result.status_label, http_status: result.status, response: result.body,
      conflicts: conflictsForOp(op.op_id),
    };
  } catch (e) {
    // Adding something to a row another device deleted (an item to a deleted meal, a set
    // to a deleted workout) fails the foreign key: same rule — the delete wins.
    if (!(e instanceof Rejected) && /FOREIGN KEY constraint failed/i.test(e.message || '')) {
      db.transaction(() => {
        insOpStmt.run(op.op_id, deviceId, method, op.path, ts, 'push', 'noop', 404, JSON.stringify({ error: 'target deleted' }), maxSeq());
        insConflict.run('target_deleted', null, null, deviceId, op.op_id, ts,
          `${describe(op)} — what this was added to was deleted on another device, so it was dropped`);
      })();
      return { op_id: op.op_id, status: 'noop', http_status: 404, conflicts: conflictsForOp(op.op_id) };
    }
    const status = e instanceof Rejected ? e.result.status : 500;
    const message = e instanceof Rejected ? e.message : (e.message || 'Server error');
    if (!(e instanceof Rejected)) console.error('[sync] op failed', describe(op), e);
    db.transaction(() => {
      insOpStmt.run(op.op_id, deviceId, method, op.path, ts, 'push', 'rejected', status, JSON.stringify({ error: message }), maxSeq());
      insConflict.run('rejected', null, null, deviceId, op.op_id, ts, `${describe(op)} — the server refused this change: ${message}`);
    })();
    return { op_id: op.op_id, status: 'rejected', http_status: status, error: message, conflicts: conflictsForOp(op.op_id) };
  } finally {
    resetCtx();
  }
}

// ─── Middleware for direct (online) writes ───────────────────────────────────
// Online, the app calls the API directly as it always has. The client tags each write with
// an op id; recording it means that if the response is lost and the device falls back to
// queueing the same op, the push recognises it instead of applying it twice. The write is
// also stamped with the current time and device so later replays of older offline edits
// lose to it (field-level last-writer-wins).
function middleware(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS' || req.path.startsWith('/sync')) {
    return next();
  }
  const opId = req.get('X-Ascent-Op-Id') || null;
  const deviceId = parseInt(req.get('X-Ascent-Device'), 10) || null;
  if (opId) {
    const prev = getOpStmt.get(opId);
    if (prev) return res.status(prev.http_status || 200).type('json').send(prev.response ?? 'null');
    const origJson = res.json.bind(res);
    res.json = body => {
      try {
        const ok = res.statusCode < 400;
        insOpStmt.run(opId, deviceId, req.method, req.originalUrl.replace(/^\/api/, ''), Date.now(), 'direct',
          ok ? 'applied' : 'rejected', res.statusCode, JSON.stringify(body ?? null), maxSeq());
      } catch (e) { console.error('[sync] could not record op', e.message); }
      return origJson(body);
    };
  }
  setCtx(0, Date.now(), deviceId, opId);
  try { next(); } finally { resetCtx(); }
}

// ─── Endpoints ───────────────────────────────────────────────────────────────
router.get('/info', (req, res) => {
  res.json({ server_id: SERVER_ID, schema: SCHEMA, seq: maxSeq(), now: Date.now() });
});

// POST /api/sync/register { uuid, name } → { device_id }
router.post('/register', (req, res) => {
  const { uuid, name } = req.body || {};
  if (!uuid || typeof uuid !== 'string') return res.status(400).json({ error: 'uuid required' });
  db.prepare('INSERT OR IGNORE INTO sync_devices (uuid, name) VALUES (?, ?)').run(uuid, name ?? null);
  if (name) db.prepare('UPDATE sync_devices SET name = ? WHERE uuid = ?').run(name, uuid);
  const row = db.prepare('SELECT id FROM sync_devices WHERE uuid = ?').get(uuid);
  res.json({ device_id: row.id, server_id: SERVER_ID });
});

// GET /api/sync/snapshot → the whole database as a SQLite file, minus sync bookkeeping.
// Used for a device's first sync and whenever the feed can't bring it up to date.
router.get('/snapshot', (req, res) => {
  const seq = maxSeq();
  const raw = db.serialize();
  // The live file is in WAL mode; an in-memory copy can't open with a WAL header, so mark
  // the copy as a rollback-journal database (header bytes 18/19 = file format versions).
  raw[18] = 1; raw[19] = 1;
  const Database = require('better-sqlite3');
  const copy = new Database(raw);
  try {
    for (const { name } of copy.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'sync\\_%' ESCAPE '\\'").all()) {
      copy.exec(`DROP TRIGGER "${name}"`);
    }
    for (const t of ['sync_changes', 'sync_ops', 'sync_field_clock', 'sync_conflicts', 'sync_devices']) {
      copy.exec(`DELETE FROM ${t}`);
    }
    copy.exec('VACUUM');
    const out = copy.serialize();
    out[18] = 1; out[19] = 1;
    res.set({
      'Content-Type': 'application/x-sqlite3',
      'X-Sync-Seq': String(seq),
      'X-Sync-Server-Id': SERVER_ID,
      'X-Sync-Schema': SCHEMA,
      'Access-Control-Expose-Headers': 'X-Sync-Seq, X-Sync-Server-Id, X-Sync-Schema',
      'Cache-Control': 'no-store',
    });
    res.send(out);
  } finally {
    copy.close();
  }
});

// GET /api/sync/changes?since=N&device=D → current state of every row changed after N.
router.get('/changes', (req, res) => {
  const since = Math.max(0, parseInt(req.query.since, 10) || 0);
  const deviceId = parseInt(req.query.device, 10) || null;
  const seq = maxSeq();
  const base = { server_id: SERVER_ID, schema: SCHEMA, seq };
  if (since > seq) return res.json({ ...base, reset: true });

  const changed = db.prepare(`
    SELECT tbl, row_id FROM sync_changes WHERE seq > ? AND seq <= ? GROUP BY tbl, row_id
  `).all(since, seq);
  if (changed.length > MAX_FEED_ROWS) return res.json({ ...base, reset: true });

  const known = new Set(syncedTables(db));
  const byTable = {};
  for (const { tbl, row_id } of changed) {
    if (!known.has(tbl)) continue;
    (byTable[tbl] ||= []).push(row_id);
  }
  const tables = {};
  for (const [tbl, ids] of Object.entries(byTable)) {
    const rows = [];
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      rows.push(...db.prepare(`SELECT * FROM "${tbl}" WHERE id IN (${chunk.map(() => '?').join(',')})`).all(...chunk));
    }
    const present = new Set(rows.map(r => r.id));
    tables[tbl] = { columns: columnsOf(db, tbl), rows, deleted: ids.filter(id => !present.has(id)) };
  }
  if (deviceId) {
    db.prepare("UPDATE sync_devices SET last_seen_at = datetime('now'), last_pull_seq = ? WHERE id = ?").run(seq, deviceId);
  }
  res.json({ ...base, tables });
});

// POST /api/sync/push { device_id, ops: [...] } → per-op results, in order.
let pushesSinceCompaction = 0;
router.post('/push', (req, res) => {
  const { device_id, ops } = req.body || {};
  const deviceId = parseInt(device_id, 10);
  if (!deviceId || !db.prepare('SELECT 1 FROM sync_devices WHERE id = ?').get(deviceId)) {
    return res.status(400).json({ error: 'unknown device — register first' });
  }
  if (!Array.isArray(ops)) return res.status(400).json({ error: 'ops must be an array' });
  const results = [];
  for (const op of ops) {
    if (!op || typeof op.op_id !== 'string' || typeof op.path !== 'string' || !op.method) {
      results.push({ op_id: op?.op_id ?? null, status: 'rejected', error: 'malformed op' });
      continue;
    }
    const r = applyOp(deviceId, op);
    results.push(r);
    if (r.status === 'retry') break; // keep order: nothing after it may apply first
  }
  db.prepare("UPDATE sync_devices SET last_seen_at = datetime('now') WHERE id = ?").run(deviceId);
  if (++pushesSinceCompaction >= 50) { pushesSinceCompaction = 0; compactChanges(db); }
  res.json({ results, seq: maxSeq(), server_id: SERVER_ID });
});

// POST /api/sync/blobs (multipart "files") — photos taken offline, uploaded before the push
// that creates their images rows. Filenames are chosen by the device (o-<uuid>.<ext>).
const BLOB_NAME = /^o-[0-9a-f-]{36}\.(jpe?g|png|gif|webp|heic|heif|avif)$/i;
const blobUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => { fs.mkdirSync(UPLOADS_DIR, { recursive: true }); cb(null, UPLOADS_DIR); },
    filename: (_req, file, cb) => cb(null, path.basename(file.originalname)),
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, BLOB_NAME.test(path.basename(file.originalname)) && file.mimetype.startsWith('image/')),
});
router.post('/blobs', blobUpload.array('files', 20), (req, res) => {
  res.json({ stored: (req.files || []).map(f => f.filename) });
});

// GET /api/sync/conflicts?device=D — recent, undismissed conflicts for this device's writes.
router.get('/conflicts', (req, res) => {
  const deviceId = parseInt(req.query.device, 10) || null;
  const rows = db.prepare(`
    SELECT c.*, d.name AS winner_device_name FROM sync_conflicts c
    LEFT JOIN sync_devices d ON d.id = c.winner_device_id
    WHERE c.dismissed = 0 AND (? IS NULL OR c.device_id = ?)
    ORDER BY c.id DESC LIMIT 100
  `).all(deviceId, deviceId);
  res.json(rows);
});

// POST /api/sync/conflicts/dismiss { ids: [...] }
router.post('/conflicts/dismiss', (req, res) => {
  const ids = (req.body?.ids || []).map(Number).filter(Number.isFinite);
  const stmt = db.prepare('UPDATE sync_conflicts SET dismissed = 1 WHERE id = ?');
  db.transaction(() => ids.forEach(id => stmt.run(id)))();
  res.json({ ok: true });
});

router.middleware = middleware;
router.applyOp = applyOp;
router.dispatch = dispatch;
module.exports = router;
