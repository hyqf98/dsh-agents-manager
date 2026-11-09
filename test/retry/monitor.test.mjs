/**
 * Monitor tests: live llm/retry events → active/recent views, eviction,
 * failure rows, and the restart-surviving persistence of the recent ring.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRetryMonitor, RECENT_LIMIT } from '../../src/host/retry/monitor.js';

let clock = 1_000_000;
const now = () => clock;

function sessionOf(id) {
  return { id };
}

test('observe records llm/retry into active and recent', () => {
  const monitor = createRetryMonitor({ now });
  monitor.observe(sessionOf('s1'), {
    type: 'llm/retry',
    time: clock,
    data: { retryId: 'r1', provider: 'magpie', mode: 'plugin-rule', ruleName: 'zhipu', delayMs: 60_000, retry: 1, failure: { message: '已达到 5 小时上限', code: 'PI_AI_ERROR' } },
  });
  const snap = monitor.snapshot();
  assert.equal(snap.active.length, 1);
  assert.equal(snap.active[0].ruleName, 'zhipu');
  assert.equal(snap.active[0].remainingMs, 60_000);
  assert.equal(snap.recent.length, 1);
  assert.equal(snap.recent[0].sessionId, 's1');
  assert.equal(snap.recent[0].kind, 'retry');
});

test('llm/retry-started moves an active wait out', () => {
  const monitor = createRetryMonitor({ now });
  monitor.observe(sessionOf('s1'), { type: 'llm/retry', time: clock, data: { retryId: 'r1', provider: 'p', delayMs: 10_000 } });
  monitor.observe(sessionOf('s1'), { type: 'llm/retry-started', time: clock + 10_000, data: { retryId: 'r1' } });
  const snap = monitor.snapshot();
  assert.equal(snap.active.length, 0);
  assert.ok(snap.recent.some((entry) => entry.phase === 'started'));
});

test('turn/end clears that session\'s active waits', () => {
  const monitor = createRetryMonitor({ now });
  monitor.observe(sessionOf('s1'), { type: 'llm/retry', time: clock, data: { retryId: 'r1', provider: 'p', delayMs: 900_000 } });
  monitor.observe(sessionOf('s2'), { type: 'llm/retry', time: clock, data: { retryId: 'r2', provider: 'p', delayMs: 900_000 } });
  monitor.observe(sessionOf('s1'), { type: 'turn/end', time: clock, data: {} });
  const snap = monitor.snapshot();
  assert.equal(snap.active.length, 1);
  assert.equal(snap.active[0].sessionId, 's2');
});

test('dropSession clears live state but keeps recent history', () => {
  const monitor = createRetryMonitor({ now });
  monitor.observe(sessionOf('s1'), { type: 'llm/retry', time: clock, data: { retryId: 'r1', provider: 'p', delayMs: 900_000 } });
  monitor.dropSession('s1');
  const snap = monitor.snapshot();
  assert.equal(snap.active.length, 0);
  // History stays: a closed session's retry story must remain inspectable.
  assert.equal(snap.recent.length, 1);
});

test('recordFailure adds a kind=failure row that never becomes active', () => {
  const monitor = createRetryMonitor({ now });
  monitor.recordFailure({
    sessionId: 's1', turn: 1, step: 2, provider: 'magpie-responses',
    code: 'RATE_LIMIT', status: 429, message: 'rate_limit_exceeded: 已达到 5 小时的使用上限',
    reason: 'no-rules', ruleName: null, ruleCount: 0,
  });
  const snap = monitor.snapshot();
  assert.equal(snap.active.length, 0);
  assert.equal(snap.recent.length, 1);
  const row = snap.recent[0];
  assert.equal(row.kind, 'failure');
  assert.equal(row.reason, 'no-rules');
  assert.equal(row.failure.code, 'RATE_LIMIT');
  assert.equal(row.failure.status, 429);
  assert.equal(row.count, 1);
});

test('recordFailure folds consecutive identical misses into one counted row', () => {
  const monitor = createRetryMonitor({ now });
  const base = { sessionId: 's1', turn: 1, step: 2, provider: 'p', code: 'RATE_LIMIT', message: 'same error', reason: 'no-match', ruleCount: 3 };
  monitor.recordFailure(base);
  clock += 5_000;
  monitor.recordFailure({ ...base });
  clock += 5_000;
  monitor.recordFailure({ ...base });
  const snap = monitor.snapshot();
  assert.equal(snap.recent.length, 1);
  assert.equal(snap.recent[0].count, 3);
  assert.equal(snap.recent[0].time, clock);
  // A different step is a new row.
  monitor.recordFailure({ ...base, step: 3 });
  assert.equal(monitor.snapshot().recent.length, 2);
});

test('recent ring is bounded', () => {
  const monitor = createRetryMonitor({ now });
  for (let i = 0; i < RECENT_LIMIT + 30; i++) {
    monitor.observe(sessionOf('s'), { type: 'llm/retry', time: clock + i, data: { retryId: `r${i}`, provider: 'p', delayMs: 1 } });
  }
  assert.equal(monitor.snapshot().recent.length, RECENT_LIMIT);
});

test('remainingMs counts down with the clock', () => {
  const monitor = createRetryMonitor({ now });
  monitor.observe(sessionOf('s1'), { type: 'llm/retry', time: clock, data: { retryId: 'r1', provider: 'p', delayMs: 100_000 } });
  clock += 40_000;
  assert.equal(monitor.snapshot().active[0].remainingMs, 60_000);
});

test('persistence: the recent ring survives a fresh monitor instance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retry-monitor-'));
  const path = join(root, 'monitor.json');
  try {
    const first = createRetryMonitor({ now, persistPath: path });
    await first.init();
    first.observe(sessionOf('s1'), { type: 'llm/retry', time: clock, data: { retryId: 'r1', provider: 'p', delayMs: 900_000 } });
    first.recordFailure({ sessionId: 's2', turn: 3, step: 1, provider: 'q', code: 'SERVER', message: 'boom', reason: 'no-match' });
    await first.dispose(); // flush the serialized write

    // The file holds both rows.
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(parsed.recent.length, 2);

    const second = createRetryMonitor({ now, persistPath: path });
    await second.init();
    const snap = second.snapshot();
    assert.equal(snap.recent.length, 2);
    assert.ok(snap.recent.some((entry) => entry.kind === 'failure' && entry.reason === 'no-match'));
    // The scheduled wait died with the previous instance: loaded as expired,
    // never resurrected into the active set.
    const retryRow = snap.recent.find((entry) => entry.kind === 'retry');
    assert.equal(retryRow.phase, 'expired');
    assert.equal(snap.active.length, 0);
    await second.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('persistence: rows that already finished keep their terminal phase', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retry-monitor-'));
  const path = join(root, 'monitor.json');
  try {
    const first = createRetryMonitor({ now, persistPath: path });
    await first.init();
    first.observe(sessionOf('s1'), { type: 'llm/retry', time: clock, data: { retryId: 'r1', provider: 'p', delayMs: 10_000 } });
    first.observe(sessionOf('s1'), { type: 'llm/retry-started', time: clock + 10_000, data: { retryId: 'r1' } });
    await first.dispose();

    const second = createRetryMonitor({ now, persistPath: path });
    await second.init();
    const row = second.snapshot().recent.find((entry) => entry.kind === 'retry');
    assert.equal(row.phase, 'started');
    await second.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('persistence: unreadable files start empty without throwing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retry-monitor-'));
  const path = join(root, 'monitor.json');
  try {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, '{not json', 'utf8');
    const monitor = createRetryMonitor({ now, persistPath: path, log: () => {} });
    await monitor.init();
    assert.equal(monitor.snapshot().recent.length, 0);
    await monitor.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
