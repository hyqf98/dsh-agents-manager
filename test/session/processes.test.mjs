import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createProcessStore,
  createRootResolver,
  sessionIdOfAgent,
  STALE_NO_HANDLE_MS,
} from '../../src/host/session/processes.js';
import { buildProcessReportTool } from '../../src/host/session/process-tools.js';

/** An error carrying a Node errno-style code, as process.kill throws. */
function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

/** Injectable clock/sleep/kill harness around one store. */
function makeStore(options = {}) {
  let tick = 1000;
  const now = () => (tick += 1);
  const killCalls = [];
  const sleepWaits = [];
  let killBehavior = () => {};
  const store = createProcessStore({
    now,
    kill(pid, signal) {
      killCalls.push([pid, signal]);
      killBehavior(pid, signal);
    },
    sleep(ms) {
      sleepWaits.push(ms);
      return Promise.resolve();
    },
    log: options.log ?? (() => {}),
  });
  return {
    store, now, killCalls, sleepWaits,
    behave(next) { killBehavior = next; },
    async flush() { await Promise.resolve(); await Promise.resolve(); },
  };
}

// ---------------------------------------------------------------------------
// record(): normalization and validation
// ---------------------------------------------------------------------------

test('record validates name, ports, pid, and status', async () => {
  const f = makeStore();
  assert.equal((await f.store.record('s', 's', { name: '' })).error, 'bad-name');
  assert.equal((await f.store.record('s', 's', { name: 'x'.repeat(81) })).error, 'bad-name');
  assert.equal((await f.store.record('s', 's', { name: 'a', port: 0 })).error, 'bad-port');
  assert.equal((await f.store.record('s', 's', { name: 'a', port: 70000 })).error, 'bad-port');
  assert.equal((await f.store.record('s', 's', { name: 'a', ports: [1, 2, 3, 4, 5, 6, 7, 8, 9] })).error, 'too-many-ports');
  assert.equal((await f.store.record('s', 's', { name: 'a', pid: 0 })).error, 'bad-pid');
  assert.equal((await f.store.record('s', 's', { name: 'a', status: 'zombie' })).error, 'bad-status');
  assert.equal((await f.store.record('', 'x', { name: 'a' })).error, 'bad-session');
});

test('record merges port+ports with dedupe and truncates long text fields', async () => {
  const f = makeStore();
  const long = 'x'.repeat(9000);
  const result = await f.store.record('s', 's', {
    name: '  vite  ',
    port: 5173,
    ports: [5173, 3000],
    url: 'http://127.0.0.1:5173' + long,
    command: 'pnpm dev' + long,
    output: long,
    message: 'note' + long,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.record.ports, [5173, 3000]);
  assert.equal(result.record.name, 'vite');
  assert.equal(result.record.url.length, 500);
  assert.equal(result.record.command.length, 500);
  assert.equal(result.record.output.length, 4000);
  assert.equal(result.record.message.length, 300);
  assert.equal(result.record.status, 'running');
  assert.equal(result.record.source, 'main');
});

test('record with the same name updates in place and keeps startedAt', async () => {
  const f = makeStore();
  const first = await f.store.record('s', 's', { name: 'vite', port: 5173, pid: 42 });
  const second = await f.store.record('s', 's', { name: 'vite', port: 5174, status: 'stopped', message: 'done' });
  assert.equal(second.created, false);
  assert.equal(second.record.startedAt, first.record.startedAt);
  assert.deepEqual(second.record.ports, [5174]);
  assert.equal(second.record.status, 'stopped');
  const listed = f.store.list('s');
  assert.equal(listed.length, 1);
  assert.equal(listed[0].pid, 42, 'fields not resupplied survive the update');
});

test('record marks subagent source for a foreign caller and caps sessions FIFO', async () => {
  const f = makeStore();
  const sub = await f.store.record('root', 'child', { name: 'api', port: 8080 });
  assert.equal(sub.record.source, 'subagent');
  const main = await f.store.record('root', 'root', { name: 'web', port: 3000 });
  assert.equal(main.record.source, 'main');

  // Fill the session to the cap with running records.
  for (let i = 0; i < 50; i += 1) await f.store.record('cap', 'cap', { name: `p${i}` });
  assert.equal(f.store.list('cap').length, 50);
  // At the cap a new insert evicts the oldest running record (plain FIFO)…
  await f.store.record('cap', 'cap', { name: 'late' });
  let listed = f.store.list('cap');
  assert.equal(listed.length, 50);
  assert.equal(listed.find((item) => item.name === 'p0'), undefined);
  // …but once a stopped record exists, it is evicted first.
  await f.store.record('cap', 'cap', { name: 'stopped-one', status: 'stopped' });
  await f.store.record('cap', 'cap', { name: 'overflow' });
  listed = f.store.list('cap');
  assert.equal(listed.length, 50);
  assert.equal(listed.find((item) => item.name === 'stopped-one'), undefined, 'stopped records evict first');
  assert.equal(listed.find((item) => item.name === 'overflow') !== undefined, true);
});

// ---------------------------------------------------------------------------
// list(): liveness probing
// ---------------------------------------------------------------------------

test('list flips a dead pid to exited and leaves unprovable records alone', async () => {
  const f = makeStore();
  await f.store.record('s', 's', { name: 'alive', pid: 1 });
  await f.store.record('s', 's', { name: 'dead', pid: 2 });
  await f.store.record('s', 's', { name: 'nopid', port: 9 });
  f.behave((pid, signal) => {
    if (signal === 0 && pid === 2) throw codedError('ESRCH');
  });
  const listed = f.store.list('s');
  const byName = Object.fromEntries(listed.map((item) => [item.name, item]));
  assert.equal(byName.alive.status, 'running');
  assert.equal(byName.dead.status, 'exited');
  assert.equal(byName.nopid.status, 'running', 'records without a pid stay as reported');
  // Sorted oldest-start first.
  assert.deepEqual(listed.map((item) => item.name), ['alive', 'dead', 'nopid']);
});

test('list tolerates EPERM while probing and keeps the reported status', async () => {
  const f = makeStore();
  await f.store.record('s', 's', { name: 'locked', pid: 7 });
  f.behave(() => { throw codedError('EPERM'); });
  assert.equal(f.store.list('s')[0].status, 'running');
});

// ---------------------------------------------------------------------------
// stop(): SIGTERM → grace → SIGKILL
// ---------------------------------------------------------------------------

test('stop answers not-found and no-pid without touching signals', async () => {
  const f = makeStore();
  assert.equal((await f.store.stop('s', 'ghost')).error, 'not-found');
  await f.store.record('s', 's', { name: 'port-only', port: 80 });
  assert.equal((await f.store.stop('s', 'port-only')).error, 'no-pid');
  assert.deepEqual(f.killCalls, []);
});

test('stop marks stopped when SIGTERM settles the process within the grace window', async () => {
  const f = makeStore();
  await f.store.record('s', 's', { name: 'vite', pid: 42 });
  let terminated = false;
  f.behave((pid, signal) => {
    if (signal === 'SIGTERM') terminated = true;
    if (signal === 0 && terminated) throw codedError('ESRCH');
  });
  const result = await f.store.stop('s', 'vite');
  assert.equal(result.ok, true);
  assert.equal(result.record.status, 'stopped');
  assert.deepEqual(f.killCalls[0], [42, 'SIGTERM']);
  assert.equal(f.killCalls.some(([pid, signal]) => signal === 'SIGKILL'), false);
  assert.equal(f.sleepWaits.length > 0, true);
});

test('stop escalates to SIGKILL after the grace window', async () => {
  const f = makeStore();
  await f.store.record('s', 's', { name: 'stubborn', pid: 9 });
  f.behave(() => { /* probe always succeeds: the process ignores SIGTERM */ });
  const result = await f.store.stop('s', 'stubborn');
  assert.equal(result.ok, true);
  assert.equal(result.record.status, 'stopped');
  assert.equal(f.sleepWaits.length, 6, 'six 250ms grace steps');
  assert.deepEqual(f.killCalls[f.killCalls.length - 1], [9, 'SIGKILL']);
});

test('stop surfaces kill failures', async () => {
  const f = makeStore();
  await f.store.record('s', 's', { name: 'alien', pid: 5 });
  f.behave(() => { throw codedError('EPERM'); });
  const result = await f.store.stop('s', 'alien');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'kill-failed');
  assert.equal(typeof result.detail, 'string');
});

// ---------------------------------------------------------------------------
// createRootResolver(): subagent → root attribution
// ---------------------------------------------------------------------------

/** Registry-backed sessions service stub. */
function sessionsOf(registry) {
  return { get: (id) => registry[id] };
}

const logs = [];
function resolverOf(registry, parentHintOf) {
  return createRootResolver({
    resolveSessions: () => sessionsOf(registry),
    ...(parentHintOf === undefined ? {} : { parentHintOf }),
    log: (message) => logs.push(message),
  });
}

test('resolveRoot keeps a main session as its own root', () => {
  const registry = { main: { header: { origin: undefined, id: 'main' } } };
  const resolveRoot = resolverOf(registry);
  assert.deepEqual(resolveRoot({ session: { id: 'main', header: registry.main.header } }),
    { rootId: 'main', callerId: 'main', subagent: false });
});

test('resolveRoot walks a subagent chain up to the main session', () => {
  const registry = {
    main: { header: { id: 'main' } },
    mid: { header: { id: 'mid', origin: 'subagent', parentSession: 'main' } },
    leaf: { header: { id: 'leaf', origin: 'subagent', parentSession: 'mid' } },
  };
  const resolveRoot = resolverOf(registry);
  assert.deepEqual(resolveRoot({ session: { id: 'leaf', header: registry.leaf.header } }),
    { rootId: 'main', callerId: 'leaf', subagent: true });
});

test('resolveRoot survives parent cycles and unknown parents', () => {
  logs.length = 0;
  const registry = {
    a: { header: { id: 'a', origin: 'subagent', parentSession: 'b' } },
    b: { header: { id: 'b', origin: 'subagent', parentSession: 'a' } },
    orphan: { header: { id: 'orphan', origin: 'subagent', parentSession: 'gone' } },
  };
  const resolveRoot = resolverOf(registry);
  assert.equal(resolveRoot({ session: { id: 'a', header: registry.a.header } }).rootId, 'b');
  const orphan = resolveRoot({ session: { id: 'orphan', header: registry.orphan.header } });
  assert.equal(orphan.rootId, 'orphan', 'unresolvable parent keeps the record reachable');
  assert.equal(orphan.subagent, false);
  assert.equal(logs.some((line) => line.includes('orphan')), true, 'the fallback logs once');
});

test('resolveRoot uses the parent hint when the header carries no parent', () => {
  const registry = {
    main: { header: { id: 'main' } },
    hinted: { header: { id: 'hinted', origin: 'subagent' } },
  };
  const resolveRoot = resolverOf(registry, (id) => (id === 'hinted' ? 'main' : undefined));
  assert.deepEqual(resolveRoot({ session: { id: 'hinted', header: registry.hinted.header } }),
    { rootId: 'main', callerId: 'hinted', subagent: true });
});

test('resolveRoot answers empty for an agent without a session id', () => {
  const resolveRoot = resolverOf({});
  assert.deepEqual(resolveRoot({}), { rootId: '', callerId: '', subagent: false });
  assert.equal(sessionIdOfAgent({ session: { id: 7 } }), '7');
  assert.equal(sessionIdOfAgent(undefined), '');
});

// ---------------------------------------------------------------------------
// buildProcessReportTool()
// ---------------------------------------------------------------------------

function toolFixture() {
  const f = makeStore();
  let resolveRootResult = { rootId: 'main', callerId: 'main', subagent: false };
  const tool = buildProcessReportTool({
    store: f.store,
    resolveRoot: () => resolveRootResult,
  });
  return { f, tool, setRoot(next) { resolveRootResult = next; } };
}

test('the tool records a main-session report and echoes the session list', async () => {
  const { f, tool } = toolFixture();
  const text = await tool.execute({ name: 'vite', port: 5173, pid: 42, output: 'ready' }, { agent: { session: { id: 'main' } } });
  assert.match(text, /Recorded service "vite"/);
  assert.match(text, /port 5173/);
  assert.match(text, /pid 42/);
  assert.match(text, /Session processes \(1\):/);
  assert.equal(f.store.list('main')[0].output, 'ready');
});

test('the tool rolls a subagent report up to the root session', async () => {
  const { f, tool, setRoot } = toolFixture();
  setRoot({ rootId: 'main', callerId: 'child', subagent: true });
  const text = await tool.execute({ name: 'api', port: 8080 }, { agent: { session: { id: 'child' } } });
  assert.match(text, /rolled up to the main session panel/);
  const listed = f.store.list('main');
  assert.equal(listed.length, 1);
  assert.equal(listed[0].source, 'subagent');
  assert.match(text, /\(subagent\)/);
});

test('the tool reports updates and rejects invalid payloads or missing agents', async () => {
  const { tool } = toolFixture();
  const agent = { session: { id: 'main' } };
  const first = await tool.execute({ name: 'vite', port: 1 }, { agent });
  assert.match(first, /Recorded/);
  const second = await tool.execute({ name: 'vite', status: 'stopped' }, { agent });
  assert.match(second, /Updated service "vite"/);
  await assert.rejects(() => tool.execute({ name: 'x', port: 99999 }, { agent }), /bad-port/);
  await assert.rejects(() => tool.execute({ name: 'x' }, {}), /exec\.agent/);
  await assert.rejects(() => tool.execute({ name: 'x' }), /exec\.agent/);
});

test('dispose clears records without signalling anything', async () => {
  const f = makeStore();
  await f.store.record('s', 's', { name: 'a', pid: 1 });
  f.store.dispose();
  assert.deepEqual(f.store.list('s'), []);
  assert.deepEqual(f.killCalls, []);
});

// ---------------------------------------------------------------------------
// jobId: the jobs-registry stop handle for auto-registered services
// ---------------------------------------------------------------------------

/** makeStore plus an injectable killJob recorder. */
function makeJobStore(killJobImpl) {
  const f = makeStore();
  const killJobCalls = [];
  let killJobThrows = null;
  const store = createProcessStore({
    now: f.now,
    kill(pid, signal) { f.killCalls.push([pid, signal]); },
    sleep: () => Promise.resolve(),
    killJob: killJobImpl ?? (async (jobId, owner, reason) => {
      if (killJobThrows !== null) throw new Error(killJobThrows);
      killJobCalls.push([jobId, owner, reason]);
    }),
    log: () => {},
  });
  return {
    store, killJobCalls, killCalls: f.killCalls,
    failJobWith(message) { killJobThrows = message; },
  };
}

test('record keeps a jobId supplied by the auto bridge', async () => {
  const f = makeJobStore();
  const result = await f.store.record('s1', '', { name: 'vite dev', source: 'auto', jobId: 'bash-abc123' });
  assert.equal(result.ok, true);
  assert.equal(result.record.jobId, 'bash-abc123');
  assert.equal(f.store.list('s1')[0].jobId, 'bash-abc123');
});

test('record inherits the previous jobId when an update omits it', async () => {
  const f = makeJobStore();
  await f.store.record('s1', '', { name: 'svc', source: 'auto', jobId: 'bash-1' });
  const updated = await f.store.record('s1', '', { name: 'svc', status: 'running' });
  assert.equal(updated.record.jobId, 'bash-1');
});

test('record sanitizes blank and oversized jobIds', async () => {
  const f = makeJobStore();
  assert.equal((await f.store.record('s1', '', { name: 'a', jobId: '   ' })).record.jobId, undefined);
  assert.equal((await f.store.record('s1', '', { name: 'b', jobId: 'x'.repeat(65) })).record.jobId, undefined);
});

test('stop uses killJob when the record has a jobId and no pid', async () => {
  const f = makeJobStore();
  await f.store.record('s1', '', { name: 'svc', source: 'auto', jobId: 'bash-9' });
  const result = await f.store.stop('s1', 'svc');
  assert.equal(result.ok, true);
  assert.equal(result.record.status, 'stopped');
  assert.deepEqual(f.killJobCalls, [['bash-9', 's1', 'process panel stop']]);
  assert.deepEqual(f.killCalls, []);
});

test('stop without pid and without jobId reports no-pid', async () => {
  const f = makeJobStore();
  await f.store.record('s1', '', { name: 'bare' });
  const result = await f.store.stop('s1', 'bare');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'no-pid');
});

test('stop with a jobId but no killJob service reports no-pid', async () => {
  const bare = createProcessStore({ now: () => 0, log: () => {} });
  await bare.record('s1', '', { name: 'svc', jobId: 'bash-2' });
  const result = await bare.stop('s1', 'svc');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'no-pid');
});

test('stop surfaces killJob failures as kill-failed', async () => {
  const f = makeJobStore();
  f.failJobWith('registry says no');
  await f.store.record('s1', '', { name: 'svc', jobId: 'bash-3' });
  const result = await f.store.stop('s1', 'svc');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'kill-failed');
  assert.match(result.detail, /registry says no/);
});

test('stop prefers the pid path and never calls killJob', async () => {
  const f = makeJobStore();
  await f.store.record('s1', '', { name: 'svc', pid: 4242, jobId: 'bash-4' });
  // SIGTERM succeeds, then every probe reports ESRCH so the grace loop ends.
  let signalCount = 0;
  const store = createProcessStore({
    now: () => 0,
    kill(pid, signal) {
      signalCount += 1;
      f.killCalls.push([pid, signal]);
      if (signal !== 'SIGTERM' && signal !== 'SIGKILL') throw codedError('ESRCH');
    },
    sleep: () => Promise.resolve(),
    killJob: async () => { throw new Error('killJob must not run when a pid exists'); },
    log: () => {},
  });
  await store.record('s1', '', { name: 'svc', pid: 4242, jobId: 'bash-4' });
  const result = await store.stop('s1', 'svc');
  assert.equal(result.ok, true);
  assert.equal(result.record.status, 'stopped');
});

// ---------------------------------------------------------------------------
// liveness: dead jobs and stale handle-less records leave the panel
// ---------------------------------------------------------------------------

test('list flips a jobId record to exited when the job is no longer alive', async () => {
  const f = makeJobStore();
  f.store['#alive'] = true; // marker unused; see closure below
  let alive = true;
  const store = createProcessStore({
    now: () => 0,
    kill: () => {},
    sleep: () => Promise.resolve(),
    killJob: async () => {},
    jobAlive: () => alive,
    log: () => {},
  });
  await store.record('s1', '', { name: 'svc', source: 'auto', jobId: 'bash-x' });
  assert.equal(store.list('s1')[0].status, 'running');
  alive = false;
  const flipped = store.list('s1');
  assert.equal(flipped[0].status, 'exited');
  assert.match(flipped[0].message, /no longer running/);
});

test('list keeps a jobId record when the registry is unavailable', async () => {
  const store = createProcessStore({
    now: () => 0,
    kill: () => {},
    sleep: () => Promise.resolve(),
    killJob: async () => {},
    jobAlive: () => { throw new Error('registry down'); },
    log: () => {},
  });
  await store.record('s1', '', { name: 'svc', source: 'auto', jobId: 'bash-x' });
  assert.equal(store.list('s1')[0].status, 'running');
});

test('a handle-less running record ages out after STALE_NO_HANDLE_MS', async () => {
  let tick = 0;
  const store = createProcessStore({
    now: () => tick,
    kill: () => {},
    sleep: () => Promise.resolve(),
    log: () => {},
  });
  await store.record('s1', '', { name: 'bare' });
  assert.equal(store.list('s1')[0].status, 'running');
  tick = STALE_NO_HANDLE_MS + 1;
  const flipped = store.list('s1');
  assert.equal(flipped[0].status, 'exited');
  assert.match(flipped[0].message, /stale/);
});

test('a handle-less record refreshed before the deadline stays running', async () => {
  let tick = 0;
  const store = createProcessStore({
    now: () => tick,
    kill: () => {},
    sleep: () => Promise.resolve(),
    log: () => {},
  });
  await store.record('s1', '', { name: 'bare' });
  tick = STALE_NO_HANDLE_MS - 1000;
  await store.record('s1', '', { name: 'bare', output: 'still alive' }); // refresh bumps updatedAt
  assert.equal(store.list('s1')[0].status, 'running');
});
