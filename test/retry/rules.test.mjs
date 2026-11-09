/**
 * Rules tests: validation, pre-filters, first-match evaluation, budgets.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRule, normalizeDocument, testRule, evaluateRules, compileWhen,
} from '../../src/host/retry/rules.js';

const NOW = Date.UTC(2026, 8, 22, 5, 0, 0);

const GOOD_RULE = {
  name: 'zhipu-5h',
  when: '已达到\\s*5\\s*小时的?使用上限',
  flags: 'i',
  codes: ['RATE_LIMIT', 'QUOTA', 'PI_AI_ERROR'],
  wait: { kind: 'reset-at', tz: '+08:00' },
  maxRetries: 4,
};

test('normalizeRule accepts a complete rule and fills defaults', () => {
  const result = normalizeRule(GOOD_RULE);
  assert.ok(result.ok);
  assert.equal(result.rule.name, 'zhipu-5h');
  assert.equal(result.rule.enabled, true);
  assert.deepEqual(result.rule.wait, { kind: 'reset-at', tz: '+08:00' });
});

test('normalizeRule rejects bad shapes with stable codes', () => {
  assert.equal(normalizeRule(null).error, 'not-object');
  assert.equal(normalizeRule({ when: 'x', wait: { kind: 'retry-after' } }).error, 'missing-name');
  assert.equal(normalizeRule({ name: 'r', wait: { kind: 'retry-after' } }).error, 'missing-when');
  assert.equal(normalizeRule({ name: 'r', when: '(', wait: { kind: 'retry-after' } }).error, 'bad-when');
  assert.equal(normalizeRule({ name: 'r', when: 'x', wait: { kind: 'nope' } }).error, 'bad-wait-kind');
  assert.equal(normalizeRule({ name: 'r', when: 'x', wait: null }).error, 'missing-wait');
  assert.equal(normalizeRule({ name: 'r', when: 'x', wait: { kind: 'retry-after' }, codes: [] }).error, 'bad-codes');
  assert.equal(normalizeRule({ name: 'r', when: 'x', wait: { kind: 'retry-after' }, codes: ['A', 'A'] }).error, 'duplicate-codes');
  assert.equal(normalizeRule({ name: 'r', when: 'x', wait: { kind: 'retry-after' }, status: [42] }).error, 'bad-status');
  assert.equal(normalizeRule({ name: 'r', when: 'x', wait: { kind: 'retry-after' }, flags: 'gg' }).error, 'bad-flags');
  assert.equal(normalizeRule({ name: 'r', when: 'x', wait: { kind: 'retry-after' }, maxRetries: -1 }).error, 'bad-max-retries');
  assert.equal(normalizeRule({ name: 'r', when: 'x', wait: { kind: 'retry-after' }, maxRetries: 101 }).error, 'bad-max-retries');
  assert.equal(normalizeRule({ name: 'r', when: 'x', wait: { kind: 'retry-after' }, maxRetries: Number.POSITIVE_INFINITY }).error, 'bad-max-retries');
  assert.equal(normalizeRule({ name: 'r', when: 'x', wait: { kind: 'retry-after' }, clampMs: 10 }).error, 'bad-clamp');
});

test('normalizeRule treats maxRetries 0 as the unlimited budget', () => {
  const result = normalizeRule({ ...GOOD_RULE, maxRetries: 0 });
  assert.ok(result.ok);
  assert.equal(result.rule.maxRetries, 0);
});

test('normalizeRule validates the fixed wait kind', () => {
  const ok = normalizeRule({ ...GOOD_RULE, wait: { kind: 'fixed', ms: 60000 }, maxRetries: 0 });
  assert.ok(ok.ok);
  assert.deepEqual(ok.rule.wait, { kind: 'fixed', ms: 60000 });
  assert.equal(normalizeRule({ ...GOOD_RULE, wait: { kind: 'fixed' } }).error, 'bad-fixed-ms');
  assert.equal(normalizeRule({ ...GOOD_RULE, wait: { kind: 'fixed', ms: 0 } }).error, 'bad-fixed-ms');
  assert.equal(normalizeRule({ ...GOOD_RULE, wait: { kind: 'fixed', ms: '60s' } }).error, 'bad-fixed-ms');
});

test('a catch-all fixed rule matches any failure text and waits the constant ms', () => {
  const workBuddy = '429: {"code":null,"message":"WorkBuddy AI: usage exceeds frequency limit, but don\'t worry, your usage will reset at 2026-11-05 17:16:57 UTC+8, alternatively, you can switch to the other models to continue using it.","param":null,"type":"rate_limit_error"}';
  const rule = normalizeRule({ name: 'catch-all', when: '[\\s\\S]+', wait: { kind: 'fixed', ms: 60000 }, maxRetries: 0 }).rule;
  const outcome = testRule(rule, { message: workBuddy, provider: 'magpie', code: 'RATE_LIMIT' }, NOW);
  assert.ok(outcome.matched);
  assert.equal(outcome.waitMs, 60000);
});

test('normalizeRule rejects group indices beyond the pattern', () => {
  const noGroup = normalizeRule({ name: 'r', when: 'abc', wait: { kind: 'duration-text', group: 1 } });
  assert.equal(noGroup.error, 'group-out-of-range');
  const withGroup = normalizeRule({ name: 'r', when: 'abc (\\d+)s', wait: { kind: 'duration-text', group: 1 } });
  assert.ok(withGroup.ok);
});

test('normalizeDocument deduplicates names and validates fallback', () => {
  const doc = normalizeDocument({ rules: [GOOD_RULE, { ...GOOD_RULE }], fallback: { maxDelayMs: 3600000 } });
  assert.equal(doc.error, 'duplicate-name');
  assert.ok(normalizeDocument({ rules: [], fallback: { maxDelayMs: 99_999_999_999 } }) === undefined ? false : true);
  const badFallback = normalizeDocument({ rules: [], fallback: { maxDelayMs: 99 } });
  assert.equal(badFallback.error, 'bad-fallback-max');
  const empty = normalizeDocument({ rules: [] });
  assert.ok(empty.ok);
  assert.equal(empty.fallback.maxDelayMs, 6 * 60 * 60 * 1000);
});

test('testRule matches the real Zhipu payload and extracts the wait', () => {
  const rule = normalizeRule(GOOD_RULE).rule;
  const outcome = testRule(rule, {
    message: '{"error":{"code":"1308","message":"已达到 5 小时的使用上限。您的限额将在 2026-09-22 13:45:14 重置。"}}',
    provider: 'magpie-anthropic',
    code: 'PI_AI_ERROR',
  }, NOW);
  assert.ok(outcome.matched);
  assert.ok(outcome.waitMs > 0);
  assert.equal(outcome.waitMs, Date.UTC(2026, 8, 22, 5, 45, 14) - NOW);
});

test('testRule reports why a miss happened', () => {
  const rule = normalizeRule({ ...GOOD_RULE, codes: ['RATE_LIMIT'] }).rule;
  assert.equal(testRule(rule, { message: '已达到 5 小时的使用上限', code: 'QUOTA' }, NOW).reason, 'code-filter');
  const disabled = normalizeRule({ ...GOOD_RULE, enabled: false }).rule;
  assert.equal(testRule(disabled, { message: 'x', code: 'RATE_LIMIT' }, NOW).reason, 'disabled');
  const noMatch = normalizeRule(GOOD_RULE).rule;
  assert.equal(testRule(noMatch, { message: 'totally unrelated', code: 'RATE_LIMIT' }, NOW).reason, 'no-match');
});

test('evaluateRules returns the first hit only', () => {
  const first = normalizeRule({ name: 'a', when: 'overloaded', wait: { kind: 'retry-after', defaultMs: 1000 } }).rule;
  const second = normalizeRule({ name: 'b', when: 'overloaded', wait: { kind: 'retry-after', defaultMs: 999999 } }).rule;
  const hit = evaluateRules([first, second], { provider: 'p', message: 'server overloaded', code: 'SERVER' }, NOW);
  assert.equal(hit?.rule.name, 'a');
  assert.equal(hit?.waitMs, 1000);
  assert.equal(evaluateRules([], { provider: 'p', message: 'x', code: 'x' }, NOW), null);
});

test('compileWhen caches nothing but never throws for valid input', () => {
  assert.ok(compileWhen({ when: 'a', flags: 'i' }) instanceof RegExp);
  assert.equal(compileWhen({ when: '[' }), null);
});
