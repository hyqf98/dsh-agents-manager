/**
 * Engine tests: waterfall pass-through, rule-hit scheduling, budgets,
 * abort cancellation, turn resets — with a fake waterfall harness.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRetryEngine } from '../../src/host/retry/engine.js';

/** Deterministic clock. */
let clock = 0;
const now = () => clock;
const ZHIPU_RULE = {
  name: 'zhipu-5h',
  when: '已达到\\s*5\\s*小时的?使用上限',
  flags: 'i',
  codes: ['RATE_LIMIT', 'QUOTA', 'PI_AI_ERROR'],
  wait: { kind: 'reset-at', tz: '+08:00' },
  maxRetries: 2,
};

/** Fake rules snapshot holder. */
function makeRules(rules) {
  let current = { rules, fallback: { maxDelayMs: 6 * 60 * 60 * 1000 } };
  return { get: () => current, set: (next) => { current = next; } };
}

/** Collect retry-event records. */
function makeRecorder() {
  /** @type {Array<object>} */
  const events = [];
  return { events, onRetry: (record) => { events.push({ ...record }); } };
}

/** Collect miss records (failures the rules passed on). */
function makeMissCollector() {
  /** @type {Array<object>} */
  const misses = [];
  return { misses, onMiss: (record) => { misses.push({ ...record }); } };
}

const FAILURE = {
  provider: 'magpie-anthropic',
  message: '已达到 5 小时的使用上限。您的限额将在 2026-09-22 13:45:14 重置。',
  code: 'PI_AI_ERROR',
};

function makePayload(overrides = {}) {
  return {
    agent: { session: { id: 'sess-1', append: () => {} } },
    turn: 1,
    step: 1,
    provider: FAILURE.provider,
    failure: { ...FAILURE },
    signal: new AbortController().signal,
    ...overrides,
  };
}

test('no rules: the listener passes through untouched', async () => {
  const rules = makeRules([]);
  const recorder = makeRecorder();
  const miss = makeMissCollector();
  const engine = createRetryEngine({ rules: rules.get, onRetry: recorder.onRetry, onMiss: miss.onMiss, now });
  let calledNext = false;
  const outcome = await engine.onRequestError(makePayload(), async () => {
    calledNext = true;
    return { kind: 'retry' };
  });
  assert.ok(calledNext);
  assert.deepEqual(outcome, { kind: 'retry' });
  assert.equal(recorder.events.length, 0);
  engine.dispose();
});

test('onMiss: no rules reports reason no-rules with the failure text', async () => {
  const rules = makeRules([]);
  const miss = makeMissCollector();
  const engine = createRetryEngine({ rules: rules.get, onRetry: () => {}, onMiss: miss.onMiss, now });
  await engine.onRequestError(makePayload(), async () => undefined);
  assert.equal(miss.misses.length, 1);
  assert.equal(miss.misses[0].reason, 'no-rules');
  assert.equal(miss.misses[0].sessionId, 'sess-1');
  assert.equal(miss.misses[0].ruleCount, 0);
  assert.equal(miss.misses[0].code, FAILURE.code);
  assert.ok(miss.misses[0].message.includes('使用上限'));
  engine.dispose();
});

test('onMiss: rule mismatch reports reason no-match with the rule count', async () => {
  const rules = makeRules([ZHIPU_RULE]);
  const miss = makeMissCollector();
  const engine = createRetryEngine({ rules: rules.get, onRetry: () => {}, onMiss: miss.onMiss, now });
  clock = Date.UTC(2026, 8, 22, 5, 0, 0);
  await engine.onRequestError(
    makePayload({ failure: { message: 'unrelated error', code: 'AUTH' } }),
    async () => undefined,
  );
  assert.equal(miss.misses.length, 1);
  assert.equal(miss.misses[0].reason, 'no-match');
  assert.equal(miss.misses[0].ruleCount, 1);
  assert.equal(miss.misses[0].code, 'AUTH');
  engine.dispose();
});

test('onMiss: exhausted budget reports reason budget-exhausted with the rule name', async () => {
  const rules = makeRules([{ ...ZHIPU_RULE, maxRetries: 1, wait: { kind: 'retry-after', defaultMs: 30_000 } }]);
  const miss = makeMissCollector();
  const engine = createRetryEngine({ rules: rules.get, onRetry: () => {}, onMiss: miss.onMiss, now });
  clock = Date.UTC(2026, 8, 22, 5, 0, 0);
  // First hit consumes the budget (1 per turn); abort the wait afterwards.
  const controller = new AbortController();
  const first = engine.onRequestError(makePayload({ signal: controller.signal }), async () => undefined);
  controller.abort();
  await first;
  assert.equal(miss.misses.length, 0);
  // Second failure on the same turn passes on with the budget reason.
  await engine.onRequestError(makePayload(), async () => undefined);
  assert.equal(miss.misses.length, 1);
  assert.equal(miss.misses[0].reason, 'budget-exhausted');
  assert.equal(miss.misses[0].ruleName, 'zhipu-5h');
  engine.dispose();
});

test('onMiss: a rule hit never reports a miss', async () => {
  const rules = makeRules([{ ...ZHIPU_RULE, wait: { kind: 'retry-after', defaultMs: 10 } }]);
  const miss = makeMissCollector();
  const engine = createRetryEngine({ rules: rules.get, onRetry: () => {}, onMiss: miss.onMiss, now });
  clock = Date.UTC(2026, 8, 22, 5, 0, 0);
  const outcome = await engine.onRequestError(makePayload(), async () => undefined);
  assert.deepEqual(outcome, { kind: 'retry' });
  assert.equal(miss.misses.length, 0);
  engine.dispose();
});

test('rule miss: passes through to the downstream executor', async () => {
  const rules = makeRules([ZHIPU_RULE]);
  const recorder = makeRecorder();
  const engine = createRetryEngine({ rules: rules.get, onRetry: recorder.onRetry, now });
  clock = Date.UTC(2026, 8, 22, 5, 0, 0);
  const outcome = await engine.onRequestError(
    makePayload({ failure: { message: 'unrelated error', code: 'AUTH' } }),
    async () => undefined,
  );
  assert.equal(outcome, undefined);
  assert.equal(recorder.events.length, 0);
  engine.dispose();
});

test('rule hit: schedules the extracted wait and returns retry', async () => {
  const rules = makeRules([{ ...ZHIPU_RULE, wait: { kind: 'retry-after', defaultMs: 20 } }]);
  const recorder = makeRecorder();
  const engine = createRetryEngine({ rules: rules.get, onRetry: recorder.onRetry, now });
  clock = Date.UTC(2026, 8, 22, 5, 0, 0);
  // A short wait completes: the engine returns { kind: 'retry' } and records
  // the scheduling event before its timer starts (durable-before-wait).
  const pending = engine.onRequestError(makePayload(), async () => undefined);
  const outcome = await pending;
  assert.deepEqual(outcome, { kind: 'retry' });
  assert.equal(recorder.events.length >= 1, true);
  assert.equal(recorder.events[0].ruleName, 'zhipu-5h');
  assert.equal(recorder.events[0].waitMs, 1000);
  engine.dispose();
});

test('budget: exhausted rule defers downstream', async () => {
  const rules = makeRules([{ ...ZHIPU_RULE, maxRetries: 1, wait: { kind: 'retry-after', defaultMs: 30000 } }]);
  const recorder = makeRecorder();
  const engine = createRetryEngine({ rules: rules.get, onRetry: recorder.onRetry, now });
  clock = Date.UTC(2026, 8, 22, 5, 0, 0);
  // First hit consumes the budget (1 per turn): schedule, then abort the wait.
  const firstController = new AbortController();
  const firstPending = engine.onRequestError(makePayload({ signal: firstController.signal }), async () => undefined);
  firstController.abort();
  const first = await firstPending;
  assert.equal(first, undefined);
  assert.equal(recorder.events.length, 1);
  // Second hit on the same turn defers downstream.
  let downstreamRan = false;
  const second = await engine.onRequestError(makePayload(), async () => {
    downstreamRan = true;
    return undefined;
  });
  assert.ok(downstreamRan);
  assert.equal(second, undefined);
  engine.dispose();
});

test('turn advance resets the per-rule budget', async () => {
  const rules = makeRules([{ ...ZHIPU_RULE, maxRetries: 1, wait: { kind: 'retry-after', defaultMs: 30000 } }]);
  const recorder = makeRecorder();
  const engine = createRetryEngine({ rules: rules.get, onRetry: recorder.onRetry, now, abortWaitsOnDispose: true });
  clock = Date.UTC(2026, 8, 22, 5, 0, 0);
  // Turn 1: consume the budget; cancel the wait after scheduling.
  const turnOneController = new AbortController();
  const turnOnePending = engine.onRequestError(makePayload({ signal: turnOneController.signal }), async () => undefined);
  turnOneController.abort();
  await turnOnePending;
  // Turn 2: same rule, fresh budget — schedule then cancel via disposal.
  const pendingTurnTwo = engine.onRequestError(makePayload({ turn: 2 }), async () => undefined);
  assert.equal(engine.status().waiting, 1);
  await engine.dispose();
  await pendingTurnTwo;
});

test('maxRetries 0 is an unlimited per-turn budget and fires phase started callbacks', async () => {
  // Six failures on one turn: with the default budget of 5 the sixth would
  // defer downstream as budget-exhausted; with 0 every one schedules a wait.
  const rules = makeRules([{ name: 'catch-all', when: '[\\s\\S]+', flags: 'i', wait: { kind: 'fixed', ms: 1000 }, maxRetries: 0 }]);
  const recorder = makeRecorder();
  const miss = makeMissCollector();
  const engine = createRetryEngine({ rules: rules.get, onRetry: recorder.onRetry, onMiss: miss.onMiss, now });
  clock = Date.UTC(2026, 8, 22, 5, 0, 0);
  for (let round = 1; round <= 6; round++) {
    const outcome = await engine.onRequestError(makePayload(), async () => undefined);
    assert.deepEqual(outcome, { kind: 'retry' });
  }
  assert.equal(miss.misses.length, 0);
  const scheduled = recorder.events.filter((entry) => entry.phase === undefined);
  const started = recorder.events.filter((entry) => entry.phase === 'started');
  assert.equal(scheduled.length, 6);
  assert.equal(started.length, 6);
  assert.deepEqual(scheduled.map((entry) => entry.attempt), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(started.map((entry) => entry.attempt), [1, 2, 3, 4, 5, 6]);
  // The wait stays the rule's fixed interval (the 1s floor), and the record
  // keeps the user-facing budget value 0 (never Infinity) for JSON-safe logs.
  assert.ok(scheduled.every((entry) => entry.waitMs === 1000 && entry.budget === 0));
  engine.dispose();
});

test('abort signal cancels the wait and returns no retry', async () => {
  const rules = makeRules([{ ...ZHIPU_RULE, wait: { kind: 'retry-after', defaultMs: 1000 } }]);
  const recorder = makeRecorder();
  const engine = createRetryEngine({ rules: rules.get, onRetry: recorder.onRetry, now });
  clock = Date.UTC(2026, 8, 22, 5, 0, 0);
  const controller = new AbortController();
  const pending = engine.onRequestError(makePayload({ signal: controller.signal }), async () => undefined);
  // Abort after scheduling.
  controller.abort();
  const outcome = await pending;
  assert.equal(outcome, undefined);
  assert.equal(recorder.events.length >= 1, true);
  engine.dispose();
});

test('dispose aborts in-flight waits and drains when explicitly requested', async () => {
  const rules = makeRules([{ ...ZHIPU_RULE, wait: { kind: 'retry-after', defaultMs: 1000 } }]);
  const recorder = makeRecorder();
  const engine = createRetryEngine({ rules: rules.get, onRetry: recorder.onRetry, now, abortWaitsOnDispose: true });
  clock = Date.UTC(2026, 8, 22, 5, 0, 0);
  const pending = engine.onRequestError(makePayload(), async () => undefined);
  const drained = engine.dispose();
  const outcome = await pending;
  assert.equal(outcome, undefined);
  await drained;
});

test('status() reports waiting waits', async () => {
  const rules = makeRules([{ ...ZHIPU_RULE, wait: { kind: 'retry-after', defaultMs: 30000 } }]);
  const recorder = makeRecorder();
  const engine = createRetryEngine({ rules: rules.get, onRetry: recorder.onRetry, now });
  clock = Date.UTC(2026, 8, 22, 5, 0, 0);
  const pending = engine.onRequestError(makePayload(), async () => undefined);
  assert.equal(engine.status().waiting, 1);
  await engine.dispose();
  await pending;
  assert.equal(engine.status().waiting, 0);
});


test('dispose keeps an in-flight wait alive (plugin-row hot reload must not kill the retry)', async () => {
  const rules = makeRules([{ name: 'fixed', when: '[\\s\\S]+', flags: 'i', wait: { kind: 'fixed', ms: 1000 }, maxRetries: 2 }]);
  const recorder = makeRecorder();
  const engine = createRetryEngine({ rules: rules.get, onRetry: recorder.onRetry, now });
  const pending = engine.onRequestError(makePayload(), async () => undefined);
  assert.equal(engine.status().waiting, 1);
  // Row disposed by a loader rebuild mid-wait: the pending promise must still
  // resolve to a retry once the timer elapses.
  await engine.dispose();
  await assert.doesNotReject(pending);
  assert.deepEqual(await pending, { kind: 'retry' });
  assert.ok(recorder.events.some((event) => event.phase === 'started'), 'started phase fired after reload');
});
