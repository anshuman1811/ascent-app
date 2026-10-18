#!/usr/bin/env node
// End-to-end test of offline mode and multi-device sync.
//
// Starts a throwaway server on a copy of a database, opens several "devices" (separate
// Chrome browser contexts = separate IndexedDB storage) against it, takes them on and
// offline and checks that every device and the server converge.
//
//   cd client && npm run build                      # the server serves client/dist
//   mkdir -p /tmp/pw && (cd /tmp/pw && npm i playwright-core)
//   DB_SOURCE=/path/to/copy-of-fitness.db PLAYWRIGHT_CORE=/tmp/pw/node_modules/playwright-core \
//     node server/scripts/offline-sync-test.js
//
// DB_SOURCE must have at least two users and one routine with exercises (a copy of the
// live database is ideal — it is copied again, never written).
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const assert = require('assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const Database = require(path.join(__dirname, '../node_modules/better-sqlite3'));

const PORT = Number(process.env.PORT || 3081);
const URL = `http://localhost:${PORT}`;
const DB = `/tmp/ascent-sync-test-${PORT}.db`;
const SRC = process.env.DB_SOURCE;
if (!SRC || !fs.existsSync(SRC)) { console.error('Set DB_SOURCE to a copy of an Ascent database'); process.exit(2); }

const results = [];
async function step(name, fn) {
  const t = Date.now();
  try { await fn(); results.push(['PASS', name]); console.log(`  ✓ ${name} (${Date.now() - t} ms)`); }
  catch (e) { results.push(['FAIL', name]); console.log(`  ✗ ${name}\n    ${e.stack.split('\n').slice(0, 4).join('\n    ')}`); }
}

let server;
async function startServer(fresh = true) {
  if (fresh) {
    for (const ext of ['', '-wal', '-shm']) fs.rmSync(DB + ext, { force: true });
    fs.copyFileSync(SRC, DB);
  }
  server = spawn(process.execPath, [path.join(__dirname, '../index.js')], {
    env: { ...process.env, DB_PATH: DB, PORT: String(PORT), ANTHROPIC_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', d => { log += d; });
  server.stderr.on('data', d => { log += d; });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${URL}/api/health`)).ok) return; } catch { /* not yet */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not start:\n' + log);
}

const serverDb = () => new Database(DB, { readonly: true, fileMustExist: true });
const api = async (method, p, body) => {
  const r = await fetch(`${URL}/api${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(`${method} ${p}: ${j.error}`);
  return j;
};

async function device(browser, name) {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const d = {
    name, ctx, page, errors,
    async open(p = '/dashboard') {
      await d.page.goto(URL + p);
      await d.page.waitForFunction(() => window.__ascentSync?.state.phase === 'ready', null, { timeout: 30000 });
    },
    req: (method, p, body) => d.page.evaluate(([m, pp, b]) => window.__ascentSync.request(m, pp, b), [method, p, body]),
    state: () => d.page.evaluate(() => ({ ...window.__ascentSync.state, queue: window.__ascentSync.queue.length })),
    sql: q => d.page.evaluate(qq => window.__ascentSync.sql(qq).map(r => r.values), q).then(v => v[0] ?? []),
    async offline() {
      await ctx.setOffline(true);
      await d.page.waitForFunction(() => !window.__ascentSync.state.online, null, { timeout: 15000 });
    },
    async online() {
      await ctx.setOffline(false);
      await d.sync();
    },
    async sync() {
      // Push + pull until nothing is waiting (the engine also does this on its own timer).
      for (let i = 0; i < 20; i++) {
        await d.page.evaluate(() => window.__ascentSync.syncNow());
        const s = await d.state();
        if (s.online && s.pending === 0 && !s.syncing) return s;
        await d.page.waitForTimeout(250);
      }
      throw new Error(`${name} did not finish syncing: ${JSON.stringify(await d.state())}`);
    },
    async reloadPage(p = '/dashboard') {
      await d.page.close();
      d.page = await ctx.newPage();
      d.page.on('pageerror', e => errors.push(e.message));
      await d.open(p);
    },
  };
  await d.open();
  return d;
}

const SYNCED = ['users', 'user_profiles', 'weight_log', 'foods', 'food_ingredients', 'meals', 'meal_items',
  'exercises', 'routines', 'routine_exercises', 'workout_regimes', 'regime_days', 'workout_sessions',
  'session_exercises', 'set_logs', 'personal_bests', 'images', 'bug_reports'];

async function assertConverged(...devices) {
  const sdb = serverDb();
  try {
    for (const t of SYNCED) {
      const server = sdb.prepare(`SELECT * FROM ${t} ORDER BY id`).raw().all();
      for (const d of devices) {
        const local = await d.sql(`SELECT * FROM ${t} ORDER BY id`);
        assert.deepEqual(local, server, `${d.name}: table ${t} differs from the server`);
      }
    }
  } finally { sdb.close(); }
}

(async () => {
  console.log('Starting test server…');
  await startServer();
  const browser = await chromium.launch({ channel: 'chrome' });
  const sdb0 = serverDb();
  const [u1, u2] = sdb0.prepare('SELECT id FROM users ORDER BY id LIMIT 2').all().map(r => r.id);
  const routine = sdb0.prepare(`SELECT r.id FROM routines r WHERE r.user_id = ? AND
      (SELECT COUNT(*) FROM routine_exercises re JOIN exercises e ON e.id = re.exercise_id
       WHERE re.routine_id = r.id AND e.exercise_type = 'reps' AND e.category NOT IN ('warmup','cooldown')) > 0
      ORDER BY r.id LIMIT 1`).get(u1).id;
  const food = sdb0.prepare("SELECT id, calories FROM foods WHERE calories > 50 ORDER BY id LIMIT 1").get();
  sdb0.close();
  const today = new Date().toLocaleDateString('en-CA');

  // Shared records both devices will fight over.
  const shared = await api('POST', '/meals', { user_id: u1, meal_type: 'dinner', notes: 'original' });
  const doomed = await api('POST', '/meals', { user_id: u2, meal_type: 'snack', notes: 'to be deleted' });
  await api('POST', `/meals/${doomed.id}/items`, { food_id: food.id, quantity: 1 });

  const A = await device(browser, 'device A');
  const B = await device(browser, 'device B');

  let aMeal, aSession, bMeal, aSetIds = [];

  await step('online: reads and writes go to the server directly (no queue)', async () => {
    const w = await A.req('POST', `/users/${u1}/weight-log`, { weight_value: 180.4, weight_unit: 'lb' });
    assert.ok(w.id > 0, 'server-assigned positive id');
    assert.equal((await A.state()).queue, 0);
  });

  await step('both devices go offline; writes show up immediately from the local replica', async () => {
    await A.offline();
    await B.offline();
    // B edits the shared meal first, A edits it later → A's edit is the newer one.
    await B.req('PUT', `/meals/${shared.id}`, { notes: 'edited on B (older)' });
    await B.page.waitForTimeout(30);
    await A.req('PUT', `/meals/${shared.id}`, { notes: 'edited on A (newer)' });

    aMeal = await A.req('POST', '/meals', { user_id: u1, meal_type: 'lunch' });
    assert.ok(aMeal.id < 0, 'offline-created id comes from the device range');
    await A.req('POST', `/meals/${aMeal.id}/items`, { food_id: food.id, quantity: 2 });

    aSession = await A.req('POST', '/workouts/start', { user_id: u1, routine_id: routine });
    assert.ok(aSession.id < 0 && aSession.exercises.length > 0);
    const se = aSession.exercises.find(e => e.exercise_type === 'reps' && !['warmup', 'cooldown'].includes(e.category));
    for (const reps of [8, 10]) {
      const s = await A.req('POST', `/workouts/session-exercises/${se.id}/sets`, { actual_reps: reps, actual_weight_value: 999, actual_weight_unit: 'lb' });
      aSetIds.push(s.id);
    }
    const sess = await A.req('GET', `/workouts/${aSession.id}`);
    const sets = sess.exercises.find(e => e.id === se.id).sets;
    assert.deepEqual(sets.map(s => s.set_number), [1, 2]);
    assert.equal(sets[1].is_pb, 1, 'PR flag computed offline by the same PB logic');
    await A.req('PUT', `/workouts/${aSession.id}/finish`, { total_rest_seconds: 120 });

    bMeal = await B.req('POST', '/meals', { user_id: u2, meal_type: 'breakfast' });
    await B.req('POST', `/meals/${bMeal.id}/items`, { food_id: food.id, quantity: 1 });
    await B.req('DELETE', `/meals/${doomed.id}`);
    await A.req('POST', `/meals/${doomed.id}/items`, { food_id: food.id, quantity: 3 });

    const daily = await A.req('GET', `/dashboard/${u1}/daily?date=${today}`);
    assert.ok(daily.meals.calories >= food.calories * 2 - 1, 'dashboard (server-computed view) includes the offline meal');
    assert.ok(daily.exercise.session_count >= 1, 'offline-finished workout counted');
    assert.equal((await A.state()).queue, 8);
    const fromServer = serverDb();
    assert.equal(fromServer.prepare('SELECT COUNT(*) c FROM meals WHERE id = ?').get(aMeal.id).c, 0, 'nothing reached the server yet');
    fromServer.close();
  });

  await step('app restart with a non-empty queue (offline reload keeps every queued change)', async () => {
    await A.reloadPage('/food-log');
    const s = await A.state();
    assert.equal(s.queue, 8);
    const meals = await A.req('GET', `/meals/user/${u1}?date=${today}`);
    assert.ok(meals.some(m => m.id === aMeal.id && m.items.length === 1), 'offline meal still there after restart');
    const text = await A.page.textContent('body');
    assert.ok(text.length > 100, 'food log rendered offline');
  });

  await step('A reconnects: queue pushed in order, offline ids kept, server recomputes PRs', async () => {
    await A.online();
    const sdb = serverDb();
    const m = sdb.prepare('SELECT * FROM meals WHERE id = ?').get(aMeal.id);
    assert.ok(m, 'offline meal exists on the server under the same id');
    assert.equal(sdb.prepare('SELECT COUNT(*) c FROM meal_items WHERE meal_id = ?').get(aMeal.id).c, 1, 'item landed on the offline-created meal');
    const sess = sdb.prepare('SELECT * FROM workout_sessions WHERE id = ?').get(aSession.id);
    assert.equal(sess.status, 'completed');
    const sets = sdb.prepare('SELECT * FROM set_logs WHERE id IN (?, ?) ORDER BY set_number').all(...aSetIds);
    assert.deepEqual(sets.map(s => s.set_number), [1, 2], 'sets logged into the offline-started workout');
    assert.equal(sets[1].is_pb, 1, 'server-side PR recomputation flagged the PR');
    assert.ok(sdb.prepare('SELECT 1 FROM personal_bests WHERE session_id = ?').get(aSession.id), 'personal_bests row points at the offline workout');
    assert.equal(sdb.prepare('SELECT notes FROM meals WHERE id = ?').get(shared.id).notes, 'edited on A (newer)');
    sdb.close();
  });

  await step('B reconnects: field-level last-writer-wins + deletes win, conflicts reported', async () => {
    await B.online();
    const sdb = serverDb();
    assert.equal(sdb.prepare('SELECT notes FROM meals WHERE id = ?').get(shared.id).notes, 'edited on A (newer)', 'older offline edit lost to the newer one');
    assert.equal(sdb.prepare('SELECT COUNT(*) c FROM meals WHERE id = ?').get(doomed.id).c, 0, 'deleted meal stays deleted');
    assert.equal(sdb.prepare('SELECT COUNT(*) c FROM meal_items WHERE meal_id = ?').get(doomed.id).c, 0, 'A’s item on the deleted meal is gone with it');
    assert.ok(sdb.prepare('SELECT 1 FROM meals WHERE id = ?').get(bMeal.id), 'B’s own offline meal kept');
    sdb.close();
    const s = await B.state();
    assert.ok(s.conflicts.some(c => c.kind === 'field' && c.col === 'notes'), 'B is told its edit was superseded');
    await A.sync();
    assert.ok((await A.state()).conflicts.length === 0, 'A lost nothing');
  });

  await step('both devices and the server converge to identical data', async () => {
    await A.sync();
    await B.sync();
    await assertConverged(A, B);
  });

  await step('a retried push is not applied twice', async () => {
    const dev = await api('POST', '/sync/register', { uuid: 'retry-test', name: 'retry' });
    const id = -(dev.device_id * 2 ** 32 + 1);
    const ops = [
      { op_id: 'retry-1', method: 'POST', path: '/meals', body: { user_id: u1, meal_type: 'snack' }, ts: Date.now(), ids: { meals: [id] } },
      { op_id: 'retry-2', method: 'POST', path: `/meals/${id}/items`, body: { food_id: food.id, quantity: 1 }, ts: Date.now(), ids: { meal_items: [id - 1] } },
    ];
    const r1 = await api('POST', '/sync/push', { device_id: dev.device_id, ops });
    const r2 = await api('POST', '/sync/push', { device_id: dev.device_id, ops });
    assert.deepEqual(r1.results.map(r => r.status), ['applied', 'applied']);
    assert.deepEqual(r2.results.map(r => r.duplicate), [true, true]);
    const sdb = serverDb();
    assert.equal(sdb.prepare('SELECT COUNT(*) c FROM meal_items WHERE meal_id = ?').get(id).c, 1);
    sdb.close();
  });

  await step('push whose response is lost is retried by the device without duplicating', async () => {
    await A.offline();
    const m = await A.req('POST', '/meals', { user_id: u1, meal_type: 'snack', notes: 'lost ack' });
    let dropped = 0;
    await A.page.route('**/api/sync/push', async route => {
      const res = await route.fetch(); // the server applies it…
      if (dropped++ === 0) return route.abort('connectionreset'); // …but the device never hears back
      return route.fulfill({ response: res });
    });
    await A.ctx.setOffline(false);
    await A.page.evaluate(() => window.__ascentSync.syncNow());
    assert.equal((await A.state()).queue, 1, 'still queued after the lost response');
    await A.sync();
    await A.page.unroute('**/api/sync/push');
    const sdb = serverDb();
    assert.equal(sdb.prepare("SELECT COUNT(*) c FROM meals WHERE notes = 'lost ack'").get().c, 1);
    assert.ok(sdb.prepare('SELECT 1 FROM meals WHERE id = ?').get(m.id));
    sdb.close();
  });

  await step('direct online write whose response is lost falls back to the queue without duplicating', async () => {
    let first = true;
    await A.page.route('**/api/users/*/weight-log', async route => {
      if (route.request().method() !== 'POST' || !first) return route.continue();
      first = false;
      await route.fetch();            // reaches the server…
      return route.abort('timedout'); // …response lost
    });
    const r = await A.req('POST', `/users/${u1}/weight-log`, { weight_value: 177.7, weight_unit: 'lb' });
    assert.ok(r.id < 0, 'answered locally after the network error');
    await A.page.unroute('**/api/users/*/weight-log');
    await A.sync();
    const sdb = serverDb();
    assert.equal(sdb.prepare('SELECT COUNT(*) c FROM weight_log WHERE weight_value = 177.7').get().c, 1);
    sdb.close();
    await assertConverged(A);
  });

  await step('a device offline for a long time catches up from the change feed', async () => {
    const C = await device(browser, 'device C');
    await C.offline();
    for (let i = 0; i < 150; i++) {
      const meal = await api('POST', '/meals', { user_id: u2, meal_type: 'snack', notes: `bulk ${i}` });
      await api('POST', `/meals/${meal.id}/items`, { food_id: food.id, quantity: 1 });
      if (i % 10 === 0) await api('DELETE', `/meals/${meal.id}`);
    }
    await api('PUT', `/users/${u2}/profile`, { calorie_target: 1999 });
    const before = await C.sql("SELECT COUNT(*) FROM meals WHERE notes LIKE 'bulk %'");
    assert.equal(before[0][0], 0);
    const cMeal = await C.req('POST', '/meals', { user_id: u2, meal_type: 'dinner', notes: 'from C' });
    await C.online();
    await assertConverged(C);
    const sdb = serverDb();
    assert.ok(sdb.prepare('SELECT 1 FROM meals WHERE id = ?').get(cMeal.id));
    sdb.close();
    await C.ctx.close();
  });

  await step('live features: rest timer set on one device is seen by another', async () => {
    const s = await A.req('POST', '/workouts/start', { user_id: u2, routine_id: null, name: 'Live test' });
    await A.req('PUT', `/workouts/${s.id}/rest`, { restTargetSeconds: 90, sessionExerciseId: null });
    await B.sync();
    const seen = await B.req('GET', `/workouts/${s.id}`);
    assert.equal(seen.rest_target_seconds, 90);
    assert.ok(seen.rest_started_at);
    await A.req('PUT', `/workouts/${s.id}/abandon`, {});
  });

  await step('photo taken offline: shown from the device, queued, uploaded with the same image id', async () => {
    await A.offline();
    const img = await A.page.evaluate(async foodId => {
      // 1×1 PNG
      const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
      const fd = new FormData();
      fd.append('entity_type', 'food');
      fd.append('entity_id', String(foodId));
      fd.append('images', new File([bytes], 'tiny.png', { type: 'image/png' }));
      const created = await window.__ascentSync.upload('/images', fd);
      const listed = await window.__ascentSync.request('GET', `/images/food/${foodId}`);
      return { created, listed };
    }, food.id);
    assert.ok(img.created[0].id < 0);
    assert.ok(img.listed.some(i => i.id === img.created[0].id && i.url.startsWith('blob:')), 'offline photo displayed from local storage');
    await A.online();
    const sdb = serverDb();
    const row = sdb.prepare('SELECT * FROM images WHERE id = ?').get(img.created[0].id);
    sdb.close();
    assert.ok(row, 'images row created on the server with the device id');
    const file = path.join(__dirname, '../../data/uploads', row.filename);
    assert.ok(fs.existsSync(file), 'photo bytes uploaded');
    const res = await fetch(`${URL}/uploads/${row.filename}`);
    assert.equal(res.status, 200);
    await api('DELETE', `/images/${row.id}`); // also removes the file from data/uploads
    await A.sync();
  });

  await step('server restarts with a migration + boot-time row changes while a device is offline with queued work', async () => {
    const ex = await api('POST', '/exercises', { name: 'Sync Test Temp Exercise', exercise_type: 'reps' });
    await A.sync();
    assert.equal((await A.sql(`SELECT COUNT(*) FROM exercises WHERE id = ${ex.id}`))[0][0], 1);
    await A.offline();
    const m = await A.req('POST', '/meals', { user_id: u1, meal_type: 'snack', notes: 'queued across a migration' });
    // Server goes down; its database changes outside any request (a migration adds a column,
    // seeding removes a row and edits another), then it comes back.
    server.kill();
    await new Promise(r => server.once('exit', r));
    const w = new Database(DB);
    w.exec('ALTER TABLE foods ADD COLUMN sync_test_note TEXT');
    w.prepare('DELETE FROM exercises WHERE id = ?').run(ex.id);
    w.prepare("UPDATE exercises SET description = 'changed at boot' WHERE id = (SELECT MIN(id) FROM exercises)").run();
    w.close();
    await startServer(false);
    await A.online();
    assert.equal((await A.sql(`SELECT COUNT(*) FROM exercises WHERE id = ${ex.id}`))[0][0], 0, 'row deleted outside the op stream is gone on the device');
    assert.ok((await A.sql("PRAGMA table_info(foods)")).some(c => c[1] === 'sync_test_note'), 'device re-downloaded after the schema change');
    const sdb = serverDb();
    assert.ok(sdb.prepare('SELECT 1 FROM meals WHERE id = ?').get(m.id), 'queued op survived the re-download and was pushed');
    sdb.close();
    await assertConverged(A);
  });

  await step('no page errors on any device', async () => {
    assert.deepEqual([...A.errors, ...B.errors], []);
  });

  await browser.close();
  server.kill();
  const failed = results.filter(r => r[0] === 'FAIL');
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error(e); server?.kill(); process.exit(1); });
