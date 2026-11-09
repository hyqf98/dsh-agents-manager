/**
 * Extractor tests: every wait grammar against real vendor payloads.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseResetAt, parseUnixSeconds, parseDurationText, parseDurationCn,
  parseClockTime, parseEpochJson, clampWait, extractWait,
} from '../../src/host/retry/extractors.js';

/** 2026-09-22 13:00:00 UTC+8 == 2026-09-22 05:00 UTC. */
const NOW = Date.UTC(2026, 8, 22, 5, 0, 0);
/** 2026-01-01 10:00 UTC — before the 1767266400 epoch target. */
const NOW2 = Date.UTC(2026, 0, 1, 10, 0, 0);

test('parseResetAt reads Zhipu Beijing times without a zone marker', () => {
  const text = '已达到 5 小时的使用上限。您的限额将在 2026-09-22 13:45:14 重置。';
  assert.equal(parseResetAt(text, 480, NOW), (13 * 60 + 45) * 60_000 + 14_000 - 8 * 3_600_000 - (NOW - Date.UTC(2026, 8, 22, 0, 0, 0)) + 0);
});

test('parseResetAt computes Beijing-local delta exactly', () => {
  const target = Date.UTC(2026, 8, 22, 5, 45, 14); // 13:45:14 UTC+8
  assert.equal(parseResetAt('您的限额将在 2026-09-22 13:45:14 重置。', 480, NOW), target - NOW);
});

test('parseResetAt reads explicit offsets', () => {
  const target = Date.UTC(2026, 9, 25, 15, 59, 59); // 23:59:59 +0800
  assert.equal(parseResetAt('将于 2026-10-25 23:59:59 +0800 重置', 480, NOW), target - NOW);
});

test('parseResetAt reads English Z.ai resets (UTC+8, no marker)', () => {
  // Magpie's verified sample: received 17:17 UTC, reset at 01:18:11 next day Beijing.
  const received = Date.UTC(2026, 8, 21, 17, 17, 32);
  const target = Date.UTC(2026, 8, 21, 17, 18, 11); // 2026-09-22 01:18:11 UTC+8
  assert.equal(parseResetAt('Your limit will reset at 2026-09-22 01:18:11', 480, received), target - received);
});

test('parseResetAt returns null for past times', () => {
  assert.equal(parseResetAt('resets at 2020-01-01 00:00:00', 480, NOW), null);
  assert.equal(parseResetAt('nothing here', 480, NOW), null);
});

test('parseUnixSeconds reads Claude Code usage-limit pipe format', () => {
  assert.equal(parseUnixSeconds('usage limit reached|1767266400', NOW2), 1767266400000 - NOW2);
});

test('parseUnixSeconds returns null without a 10-digit epoch', () => {
  assert.equal(parseUnixSeconds('usage limit reached', NOW2), null);
});

test('parseDurationText reads English compound durations', () => {
  assert.equal(parseDurationText("You've reached your weekly standard usage limit (resets in 0h 19min)"), 19 * 60_000);
  assert.equal(parseDurationText('Daily free limit reached on model x. Try again in 23h 59m'), (23 * 60 + 59) * 60_000);
  assert.equal(parseDurationText('Please retry in 30 seconds.'), 30_000);
  assert.equal(parseDurationText('resets in 4hr 5min'), (4 * 60 + 5) * 60_000);
});

test('parseDurationText reads Go duration format', () => {
  assert.equal(parseDurationText('Your quota will reset after 3h19m30s.'), 3 * 3_600_000 + 19 * 60_000 + 30_000);
});

test('parseDurationText reads Gemini quotaResetDelay', () => {
  assert.equal(parseDurationText('quotaResetDelay: 33s'), 33_000);
  assert.equal(parseDurationText('quotaResetDelay":"33s'), 33_000);
});

test('parseDurationCn reads Chinese units', () => {
  assert.equal(parseDurationCn('请 1 分钟后重试'), 60_000);
  assert.equal(parseDurationCn('30秒后再试'), 30_000);
  assert.equal(parseDurationCn('2小时后恢复'), 2 * 3_600_000);
  assert.equal(parseDurationCn('nothing'), null);
});

test('parseClockTime waits until today 17:00 or tomorrow', () => {
  const wait = parseClockTime('请于 17:00 后重试', NOW);
  assert.ok(wait === (17 - 13) * 3_600_000 || wait === ((17 - 13) + 24) * 3_600_000);
  assert.equal(parseClockTime('no time', NOW), null);
});

test('parseEpochJson reads Codex structured resets', () => {
  const body = JSON.stringify({ error: { type: 'usage_limit_reached', resets_at: 1767266400, resets_in_seconds: 30995 } });
  assert.equal(parseEpochJson(body, NOW2), 1767266400000 - NOW2);
});

test('parseEpochJson falls back to resets_in_seconds', () => {
  const body = JSON.stringify({ error: { type: 'usage_limit_reached', resets_in_seconds: 30995 } });
  assert.equal(parseEpochJson(body, 0), 30995000);
});

test('parseEpochJson reads stringified bodies', () => {
  assert.equal(parseEpochJson("{'resets_in_seconds': 30995}", 0), 30995000);
});

test('clampWait enforces floor and ceiling', () => {
  assert.equal(clampWait(50, 1000, 10000), 1000);
  assert.equal(clampWait(999_999_999, 1000, 21_600_000), 21_600_000);
  assert.equal(clampWait(null, 1000, 10000), null);
  assert.equal(clampWait(5000, 1000, 10000), 5000);
});

test('extractWait retry-after prefers the provider value', () => {
  const got = extractWait('retry-after', { kind: 'retry-after', defaultMs: 5000 }, null, { message: '', providerRetryAfterMs: 1200 }, 0);
  assert.equal(got, 1200);
  const fallback = extractWait('retry-after', { kind: 'retry-after', defaultMs: 5000 }, null, { message: '' }, 0);
  assert.equal(fallback, 5000);
  const none = extractWait('retry-after', { kind: 'retry-after' }, null, { message: '' }, 0);
  assert.equal(none, null);
});
