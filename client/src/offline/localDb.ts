// A better-sqlite3-compatible facade over sql.js, so the server's route handlers can run
// unchanged against the device's local replica. Implements exactly the surface they use:
// prepare(sql).run/get/all, transaction(fn), exec, pragma.
//
// While an operation executes (see `withOp`), two things happen to every statement — the
// same two things the server does when it replays that operation (server/routes/sync.js):
//   • INSERTs get an explicit primary key from the device's private id range, recorded on
//     the op so the server reuses it (offline-created rows keep one id everywhere);
//   • SQL 'now' is frozen to the op's timestamp, so replaying an op later (after an app
//     restart, or on the server) gives the same timestamps the user saw.
import type { Database as SqlJsDatabase, Statement as SqlJsStatement, SqlValue } from 'sql.js';

const INSERT_RE = /^(\s*INSERT\s+(?:OR\s+\w+\s+)?INTO\s+)("?)(\w+)\2(\s*)\(([^)]*)\)(\s*VALUES\s*)\(/i;

export interface OpContext {
  nowSql: string;
  /** ids recorded so far for this op, per table, in insert order */
  ids: Record<string, number[]>;
  /** ids from a previous run of this op (replay) — reused in order */
  given?: Record<string, number[]>;
  alloc: () => number;
}

function toSql(v: unknown): SqlValue {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' || typeof v === 'string') return v;
  if (v instanceof Uint8Array) return v;
  if (typeof v === 'bigint') return Number(v);
  return String(v);
}

function flatParams(params: unknown[]): SqlValue[] {
  const out: SqlValue[] = [];
  for (const p of params) {
    if (Array.isArray(p)) out.push(...p.map(toSql));
    else out.push(toSql(p));
  }
  return out;
}

export class LocalDb {
  private db: SqlJsDatabase | null = null;
  private cache = new Map<string, SqlJsStatement>();
  private spDepth = 0;
  op: OpContext | null = null;

  get raw(): SqlJsDatabase {
    if (!this.db) throw new Error('Local database not loaded');
    return this.db;
  }

  get loaded() { return !!this.db; }

  /** Swap in a new underlying database (after a pull / rebuild). */
  swap(next: SqlJsDatabase | null) {
    for (const s of this.cache.values()) { try { s.free(); } catch { /* already freed */ } }
    this.cache.clear();
    if (this.db && this.db !== next) { try { this.db.close(); } catch { /* ignore */ } }
    this.db = next;
    this.spDepth = 0;
  }

  private compile(sql: string): { stmt: SqlJsStatement; temp: boolean } {
    if (this.op) return { stmt: this.raw.prepare(sql), temp: true };
    let stmt = this.cache.get(sql);
    if (!stmt) {
      if (this.cache.size > 300) this.swapCacheOut();
      stmt = this.raw.prepare(sql);
      this.cache.set(sql, stmt);
    }
    return { stmt, temp: false };
  }

  private swapCacheOut() {
    for (const s of this.cache.values()) { try { s.free(); } catch { /* ignore */ } }
    this.cache.clear();
  }

  private timed(sql: string) {
    return this.op ? sql.replace(/'now'/gi, `'${this.op.nowSql}'`) : sql;
  }

  prepare(sql: string) {
    const self = this;
    const run1 = <T>(finalSql: string, params: SqlValue[], fn: (s: SqlJsStatement) => T): T => {
      const { stmt, temp } = self.compile(finalSql);
      try {
        stmt.bind(params);
        return fn(stmt);
      } finally {
        if (temp) stmt.free(); else stmt.reset();
      }
    };
    return {
      run(...params: unknown[]) {
        let finalSql = self.timed(sql);
        let p = flatParams(params);
        let forcedId: number | null = null;
        const op = self.op;
        const m = op ? finalSql.match(INSERT_RE) : null;
        if (op && m) {
          const cols = m[5].split(',').map(c => c.trim().replace(/"/g, ''));
          if (!cols.includes('id')) {
            const table = m[3];
            const list = (op.ids[table] ||= []);
            forcedId = op.given?.[table]?.[list.length] ?? op.alloc();
            list.push(forcedId);
            finalSql = finalSql.replace(INSERT_RE, (_a, a, qt, t, sp, c, v) => `${a}${qt}${t}${qt}${sp}(id, ${c})${v}(?, `);
            p = [forcedId, ...p];
          }
        }
        run1(finalSql, p, s => { s.step(); });
        const changes = self.raw.getRowsModified();
        let lastInsertRowid = forcedId;
        if (lastInsertRowid == null) {
          const r = self.raw.exec('SELECT last_insert_rowid()');
          lastInsertRowid = Number(r[0]?.values[0]?.[0] ?? 0);
        }
        return { changes, lastInsertRowid };
      },
      get(...params: unknown[]) {
        return run1(self.timed(sql), flatParams(params), s => (s.step() ? s.getAsObject() : undefined)) as any;
      },
      all(...params: unknown[]) {
        return run1(self.timed(sql), flatParams(params), s => {
          const rows: Record<string, SqlValue>[] = [];
          while (s.step()) rows.push(s.getAsObject());
          return rows;
        }) as any[];
      },
    };
  }

  exec(sql: string) { this.raw.exec(this.timed(sql)); return this; }

  pragma(source: string, options?: { simple?: boolean }) {
    const res = this.raw.exec(`PRAGMA ${source}`);
    if (!res.length) return options?.simple ? undefined : [];
    const { columns, values } = res[0];
    if (options?.simple) return values[0]?.[0];
    return values.map(v => Object.fromEntries(columns.map((c, i) => [c, v[i]])));
  }

  /** Same semantics as better-sqlite3: returns a function that runs fn atomically. Nests via savepoints. */
  transaction<A extends unknown[], R>(fn: (...args: A) => R) {
    return (...args: A): R => {
      const name = `sp_${++this.spDepth}`;
      this.raw.exec(`SAVEPOINT ${name}`);
      try {
        const r = fn(...args);
        this.raw.exec(`RELEASE ${name}`);
        return r;
      } catch (e) {
        try { this.raw.exec(`ROLLBACK TO ${name}`); this.raw.exec(`RELEASE ${name}`); } catch { /* ignore */ }
        throw e;
      } finally {
        this.spDepth--;
      }
    };
  }
}

export const localDb = new LocalDb();
