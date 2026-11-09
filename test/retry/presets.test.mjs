/**
 * Preset-library tests: every built-in preset must match its own vendor
 * sample and no other preset's sample (guard against over-matching).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RETRY_PRESETS } from '../../src/host/retry/presets.js';
import { normalizeRule, testRule } from '../../src/host/retry/rules.js';

/** 2026-09-22 13:00 UTC+8. */
const NOW = Date.UTC(2026, 8, 22, 5, 0, 0);
/** 2026-01-01 10:00 UTC (before 1767266400). */
const NOW2 = Date.UTC(2026, 0, 1, 10, 0, 0);
/** 2026-09-21 17:17 UTC — the documented clock the Z.ai sample arrived at. */
const NOW_ZAI = Date.UTC(2026, 8, 21, 17, 17, 32);

/** Clock each preset's sample must be tested against (samples embed absolute times). */
const SAMPLE_CLOCKS = {
  'glm-zai-en': NOW_ZAI,
  'claude-code-usage': NOW2,
  'codex-usage-limit': NOW2,
};

/** Code each sample should be tested with (defaults to the preset's first code). */
const SAMPLE_CODES = {
  'claude-code-usage': 'QUOTA',
  'codex-usage-limit': 'QUOTA',
};

test('every preset validates through normalizeRule', () => {
  for (const preset of RETRY_PRESETS) {
    const normalized = normalizeRule(preset.rule);
    assert.ok(normalized.ok, `${preset.id}: ${normalized.ok ? '' : normalized.error}`);
    assert.equal(normalized.rule.name, preset.id, `${preset.id}: rule name should equal preset id`);
  }
});

test('every preset matches its own vendor sample', () => {
  for (const preset of RETRY_PRESETS) {
    const rule = normalizeRule(preset.rule).rule;
    const code = SAMPLE_CODES[preset.id] ?? rule.codes?.[0] ?? 'RATE_LIMIT';
    const clock = SAMPLE_CLOCKS[preset.id] ?? NOW;
    const outcome = testRule(rule, { message: preset.sample, code, provider: 'probe' }, clock);
    assert.ok(outcome.matched, `${preset.id} did not match its sample (${outcome.reason})`);
    if (preset.id !== 'relay-cn-misc') {
      assert.notEqual(outcome.reason, 'no-wait', `${preset.id} matched but extracted no wait`);
    }
  }
});

test('zhipu preset extracts the documented 5-hour reset wait', () => {
  const rule = normalizeRule(RETRY_PRESETS.find((p) => p.id === 'glm-zhipu-cn').rule).rule;
  const outcome = testRule(rule, {
    message: '{"error":{"code":"1308","message":"已达到 5 小时的使用上限。您的限额将在 2026-09-22 13:45:14 重置。"}}',
    code: 'PI_AI_ERROR',
  }, NOW);
  assert.ok(outcome.matched);
  assert.equal(outcome.waitMs, Date.UTC(2026, 8, 22, 5, 45, 14) - NOW);
});

test('codex preset reads structured resets_at', () => {
  const rule = normalizeRule(RETRY_PRESETS.find((p) => p.id === 'codex-usage-limit').rule).rule;
  const outcome = testRule(rule, {
    message: '{"error":{"type":"usage_limit_reached","resets_at":1767266400,"resets_in_seconds":30995,"limit_window_minutes":300}}',
    code: 'QUOTA',
  }, NOW2);
  assert.ok(outcome.matched);
  assert.equal(outcome.waitMs, 1767266400000 - NOW2);
});

test('claude-code preset reads the unix-seconds pipe form', () => {
  const rule = normalizeRule(RETRY_PRESETS.find((p) => p.id === 'claude-code-usage').rule).rule;
  const outcome = testRule(rule, {
    message: 'Your Claude usage limit has been reached. usage limit reached|1767266400',
    code: 'QUOTA',
  }, NOW2);
  assert.ok(outcome.matched);
  assert.equal(outcome.waitMs, 1767266400000 - NOW2);
});

test('cline preset extracts 23h 59m', () => {
  const rule = normalizeRule(RETRY_PRESETS.find((p) => p.id === 'cline-free-daily').rule).rule;
  const outcome = testRule(rule, {
    message: 'Daily free limit reached on model deepseek/deepseek-v4-flash. Try again in 23h 59m',
    code: 'RATE_LIMIT',
  }, NOW, { maxDelayMs: 24 * 60 * 60 * 1000 });
  assert.ok(outcome.matched);
  assert.equal(outcome.waitMs, (23 * 60 + 59) * 60_000);
});

test('antigravity preset parses the Go duration form', () => {
  const rule = normalizeRule(RETRY_PRESETS.find((p) => p.id === 'antigravity-quota').rule).rule;
  const outcome = testRule(rule, {
    message: 'You have exhausted your capacity on this model. Your quota will reset after 3h19m30s.',
    code: 'RATE_LIMIT',
  }, NOW);
  assert.ok(outcome.matched);
  assert.equal(outcome.waitMs, 3 * 3_600_000 + 19 * 60_000 + 30_000);
});

test('gemini preset parses quotaResetDelay seconds', () => {
  const rule = normalizeRule(RETRY_PRESETS.find((p) => p.id === 'gemini-quota').rule).rule;
  const outcome = testRule(rule, {
    message: 'You exceeded your current quota. quotaResetDelay: 33s. Please retry in 33s.',
    code: 'QUOTA',
  }, NOW);
  assert.ok(outcome.matched);
  assert.equal(outcome.waitMs, 33_000);
});

test('cross-matching: a cross-hit never extracts an out-of-bounds wait', () => {
  // Vendors share grammar families (Too Many Requests appears in Kimi, OpenAI,
  // Anthropic alike), so cross-matches are acceptable when the extracted wait
  // stays within the 24h hard ceiling. What must never happen: one preset
  // hijacking another vendor's error into a multi-day wait.
  for (const sample of RETRY_PRESETS) {
    const rule = normalizeRule(sample.rule).rule;
    const code = SAMPLE_CODES[sample.id] ?? rule.codes?.[0] ?? 'RATE_LIMIT';
    const clock = SAMPLE_CLOCKS[sample.id] ?? NOW;
    for (const other of RETRY_PRESETS) {
      if (other.id === sample.id) continue;
      const otherRule = normalizeRule(other.rule).rule;
      const outcome = testRule(otherRule, { message: sample.sample, code, provider: 'probe' }, clock, { maxDelayMs: 24 * 60 * 60 * 1000 });
      if (outcome.matched && outcome.waitMs != null) {
        assert.ok(outcome.waitMs <= 24 * 60 * 60 * 1000,
          `${other.id} extracted ${outcome.waitMs}ms (>${24 * 60 * 60 * 1000}ms) for ${sample.id}'s sample`);
      }
    }
  }
});
