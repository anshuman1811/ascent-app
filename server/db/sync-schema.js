// ─── Offline sync bookkeeping ────────────────────────────────────────────────
// Additive only: new sync_* tables plus triggers on the app tables. No existing row or
// column is changed. Safe to run on every boot (CREATE … IF NOT EXISTS; the triggers are
// dropped and regenerated from the live schema each boot so new columns are picked up).
//
//   sync_changes      change feed: one row per insert/update/delete of an app-table row,
//                     with a monotonic seq. Devices pull "everything with seq > N".
//   sync_ops          every operation applied with an op id (queued offline ops and direct
//                     online writes) → a retried push is answered from here, never re-run.
//   sync_devices      registered devices; the id seeds each device's private id range.
//   sync_field_clock  (table, row, column) → time + device of the last write. Used for
//                     field-level last-writer-wins when an offline op is replayed late.
//   sync_conflicts    writes that lost (field LWW, target deleted, rejected op) → UI.
//   sync_ctx          one-row "who is writing right now" context read by the triggers.
//   sync_meta         server id (changes if the DB is replaced → devices re-download).
const crypto = require('crypto');

// Columns that are recomputed by the server (or are pure bookkeeping), so they never take
// part in last-writer-wins: the replayed handler's own recomputation always stands.
const NO_LWW_TABLES = new Set(['personal_bests']);
const NO_LWW_COLS = {
  '*': ['id', 'created_at', 'updated_at'],
  set_logs: ['is_pb', 'set_number'],
};

const NOW_MS = `CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)`;

function syncedTables(db) {
  return db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'sync_%'
    ORDER BY name
  `).all().map(r => r.name).filter(t =>
    db.prepare(`PRAGMA table_info(${t})`).all().some(c => c.name === 'id' && c.pk === 1));
}

function columnsOf(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
}

function schemaHash(db) {
  return crypto.createHash('sha1').update(schemaKey(db)).digest('hex').slice(0, 16);
}

function q(name) { return `"${name.replace(/"/g, '""')}"`; }

function buildTriggers(db, table) {
  const cols = columnsOf(db, table);
  const skip = new Set([...(NO_LWW_COLS['*']), ...(NO_LWW_COLS[table] || [])]);
  const tracked = NO_LWW_TABLES.has(table) ? [] : cols.filter(c => !skip.has(c));
  const T = `'${table}'`;
  const changedAny = cols.map(c => `OLD.${q(c)} IS NOT NEW.${q(c)}`).join(' OR ');

  // "A newer write by someone else already set this field" — only enforced while a queued
  // offline op is being replayed (sync_ctx.replay = 1). Ties break on device id so the
  // outcome never depends on arrival order.
  const newer = c => `
    FROM sync_ctx x JOIN sync_field_clock k
      ON k.tbl = ${T} AND k.row_id = NEW.id AND k.col = '${c}'
    WHERE x.id = 1 AND x.replay = 1 AND OLD.${q(c)} IS NOT NEW.${q(c)}
      AND (k.ts > x.ts OR (k.ts = x.ts AND k.device_id > COALESCE(x.device_id, 0)))`;

  const perCol = tracked.map(c => `
    INSERT INTO sync_conflicts (kind, tbl, row_id, col, kept_value, discarded_value,
        device_id, op_id, op_ts, winner_device_id, winner_ts, created_at)
      SELECT 'field', ${T}, NEW.id, '${c}', OLD.${q(c)}, NEW.${q(c)},
        x.device_id, x.op_id, x.ts, k.device_id, k.ts, datetime('now') ${newer(c)};
    UPDATE ${q(table)} SET ${q(c)} = OLD.${q(c)}
      WHERE id = NEW.id AND EXISTS (SELECT 1 ${newer(c)});
    INSERT OR REPLACE INTO sync_field_clock (tbl, row_id, col, ts, device_id)
      SELECT ${T}, NEW.id, '${c}', COALESCE(x.ts, ${NOW_MS}), COALESCE(x.device_id, 0)
      FROM sync_ctx x
      WHERE x.id = 1 AND OLD.${q(c)} IS NOT NEW.${q(c)} AND NOT EXISTS (SELECT 1 ${newer(c)});`).join('\n');

  return [
    `CREATE TRIGGER sync_ai_${table} AFTER INSERT ON ${q(table)} BEGIN
       DELETE FROM sync_field_clock WHERE tbl = ${T} AND row_id = NEW.id;
       INSERT INTO sync_changes (tbl, row_id, op) VALUES (${T}, NEW.id, 'I');
     END`,
    `CREATE TRIGGER sync_au_${table} AFTER UPDATE ON ${q(table)} WHEN ${changedAny} BEGIN
       ${perCol}
       INSERT INTO sync_changes (tbl, row_id, op) VALUES (${T}, NEW.id, 'U');
     END`,
    `CREATE TRIGGER sync_ad_${table} AFTER DELETE ON ${q(table)} BEGIN
       DELETE FROM sync_field_clock WHERE tbl = ${T} AND row_id = OLD.id;
       INSERT INTO sync_changes (tbl, row_id, op) VALUES (${T}, OLD.id, 'D');
     END`,
  ];
}

function installSyncSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS sync_changes (
      seq    INTEGER PRIMARY KEY AUTOINCREMENT,
      tbl    TEXT NOT NULL,
      row_id INTEGER NOT NULL,
      op     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sync_changes_row ON sync_changes(tbl, row_id);
    CREATE TABLE IF NOT EXISTS sync_devices (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid          TEXT NOT NULL UNIQUE,
      name          TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at  TEXT,
      last_pull_seq INTEGER
    );
    CREATE TABLE IF NOT EXISTS sync_ops (
      op_id       TEXT PRIMARY KEY,
      device_id   INTEGER,
      method      TEXT,
      path        TEXT,
      client_ts   INTEGER,
      source      TEXT NOT NULL DEFAULT 'push',
      status      TEXT NOT NULL,
      http_status INTEGER,
      response    TEXT,
      seq         INTEGER,
      applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sync_field_clock (
      tbl       TEXT NOT NULL,
      row_id    INTEGER NOT NULL,
      col       TEXT NOT NULL,
      ts        INTEGER NOT NULL,
      device_id INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (tbl, row_id, col)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS sync_conflicts (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      kind             TEXT NOT NULL,
      tbl              TEXT,
      row_id           INTEGER,
      col              TEXT,
      kept_value,
      discarded_value,
      device_id        INTEGER,
      op_id            TEXT,
      op_ts            INTEGER,
      winner_device_id INTEGER,
      winner_ts        INTEGER,
      detail           TEXT,
      dismissed        INTEGER NOT NULL DEFAULT 0,
      created_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sync_conflicts_device ON sync_conflicts(device_id, id);
    CREATE TABLE IF NOT EXISTS sync_ctx (
      id        INTEGER PRIMARY KEY CHECK (id = 1),
      replay    INTEGER NOT NULL DEFAULT 0,
      ts        INTEGER,
      device_id INTEGER,
      op_id     TEXT
    );
    INSERT OR IGNORE INTO sync_ctx (id) VALUES (1);
    UPDATE sync_ctx SET replay = 0, ts = NULL, device_id = NULL, op_id = NULL;
  `);
  if (!db.prepare("SELECT value FROM sync_meta WHERE key = 'server_id'").get()) {
    db.prepare("INSERT INTO sync_meta (key, value) VALUES ('server_id', ?)").run(crypto.randomUUID());
  }

  refreshTriggers(db, true);
  compactChanges(db);
}

let installedFor = null;
// (Re)generate the triggers from the current schema. Cheap; skipped if nothing changed.
function refreshTriggers(db, force = false) {
  const key = schemaKey(db);
  if (!force && key === installedFor) return;
  db.transaction(() => {
    for (const { name } of db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'sync\\_%' ESCAPE '\\'").all()) {
      db.exec(`DROP TRIGGER ${q(name)}`);
    }
    for (const t of syncedTables(db)) for (const sql of buildTriggers(db, t)) db.exec(sql);
  })();
  installedFor = key;
}

function schemaKey(db) {
  return syncedTables(db).map(t => `${t}(${columnsOf(db, t).join(',')})`).join(';');
}

// Only the latest entry per row matters to the feed (the feed returns current rows), so
// older entries for the same row can go. Keeps the log no bigger than the set of rows.
function compactChanges(db) {
  db.prepare(`
    DELETE FROM sync_changes WHERE seq NOT IN (SELECT MAX(seq) FROM sync_changes GROUP BY tbl, row_id)
  `).run();
}

module.exports = { installSyncSchema, refreshTriggers, syncedTables, columnsOf, schemaHash, compactChanges };
