/**
 * Retry-rule validation and matching.
 *
 * A rule is pure data: a `when` regex over the failure text, optional
 * provider/code/status pre-filters, and a `wait` extractor describing how to
 * recover "how long until this failure heals" from the match. Validation is
 * shared by every entry point (settings page, HTTP API, the AI tools) so a
 * rule can never reach the engine half-built.
 *
 * @module
 */
import { WAIT_KINDS, MAX_TIMER_DELAY_MS, extractWait, clampWait } from './extractors.js';

/** Longest accepted rule name. */
export const MAX_RULE_NAME = 48;
/** Default per-rule retry budget (per turn). */
export const DEFAULT_MAX_RETRIES = 5;
/** Default wait floor: a rule never schedules a sub-second retry loop. */
export const DEFAULT_MIN_WAIT_MS = 1000;
/** Default wait ceiling, also the default fallback clamp. */
export const DEFAULT_MAX_WAIT_MS = 6 * 60 * 60 * 1000;
/** Hard ceiling on any configured clamp (one day; hand-slip guard). */
export const HARD_MAX_WAIT_MS = 24 * 60 * 60 * 1000;
/** Codes a rule may pre-filter on (harness taxonomy + the pi-ai catch-all). */
export const KNOWN_CODES = [
  'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE',
  'QUOTA', 'ACCOUNT_QUOTA', 'AUTH', 'INVALID_CREDENTIAL', 'INVALID_REQUEST',
  'CONTEXT_WINDOW_EXCEEDED', 'PI_AI_ERROR',
];

/**
 * Compile a rule's `when` pattern once.
 *
 * @param {object} rule - normalized rule.
 * @returns {RegExp | null} compiled regex, or null when it does not compile.
 */
export function compileWhen(rule) {
  if (typeof rule.when !== 'string' || rule.when === '') return null;
  try {
    return new RegExp(rule.when, rule.flags ?? 'i');
  } catch {
    return null;
  }
}

/** Count capture groups in a regex source (non-capturing groups excluded). */
function countGroups(source) {
  let count = 0;
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\\') { i += 1; continue; }
    if (inClass) {
      if (ch === ']') inClass = false;
      continue;
    }
    if (ch === '[') { inClass = true; continue; }
    if (ch === '(') {
      if (source[i + 1] === '?') {
        const named = /^<[a-zA-Z][a-zA-Z0-9]*>/.exec(source.slice(i + 2));
        if (named !== null) count += 1;
        continue;
      }
      count += 1;
    }
  }
  return count;
}

/**
 * Validate one raw rule object. Returns `{ ok: true, rule }` with a
 * normalized record, or `{ ok: false, error }` with a stable code.
 *
 * @param {unknown} raw
 * @returns {{ ok: true, rule: object } | { ok: false, error: string }}
 */
export function normalizeRule(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'not-object' };
  }
  const source = /** @type {Record<string, unknown>} */ (raw);

  const name = typeof source.name === 'string' ? source.name.trim() : '';
  if (name === '') return { ok: false, error: 'missing-name' };
  if (name.length > MAX_RULE_NAME) return { ok: false, error: 'name-too-long' };
  if (!/^[^\s].*$/.test(name)) return { ok: false, error: 'missing-name' };

  const when = typeof source.when === 'string' ? source.when.trim() : '';
  if (when === '') return { ok: false, error: 'missing-when' };
  if (when.length > 2048) return { ok: false, error: 'when-too-long' };

  const flags = typeof source.flags === 'string' && source.flags !== '' ? source.flags : 'i';
  if (!/^[dgimsuvy]+$/.test(flags) || flags.includes('g')) {
    return { ok: false, error: 'bad-flags' };
  }
  let probe;
  try {
    probe = new RegExp(when, flags);
    probe.test('');
  } catch {
    return { ok: false, error: 'bad-when' };
  }

  /** @type {Record<string, unknown>} */
  const rule = { name, when, flags, enabled: source.enabled === undefined ? true : source.enabled === true };

  if (source.providers !== undefined && source.providers !== null) {
    if (!Array.isArray(source.providers) || source.providers.some((p) => typeof p !== 'string' || p.trim() === '')) {
      return { ok: false, error: 'bad-providers' };
    }
    const providers = source.providers.map((p) => String(p).trim());
    if (providers.length > 0) rule.providers = providers;
  }

  if (source.codes !== undefined && source.codes !== null) {
    if (!Array.isArray(source.codes) || source.codes.length === 0) return { ok: false, error: 'bad-codes' };
    for (const code of source.codes) {
      if (typeof code !== 'string' || code === '') return { ok: false, error: 'bad-codes' };
    }
    if (new Set(source.codes).size !== source.codes.length) return { ok: false, error: 'duplicate-codes' };
    rule.codes = [...source.codes];
  }

  if (source.status !== undefined && source.status !== null) {
    if (!Array.isArray(source.status) || source.status.length === 0) return { ok: false, error: 'bad-status' };
    for (const status of source.status) {
      if (!Number.isInteger(status) || status < 100 || status > 599) return { ok: false, error: 'bad-status' };
    }
    rule.status = [...source.status];
  }

  const waitRaw = source.wait;
  if (waitRaw === null || typeof waitRaw !== 'object' || Array.isArray(waitRaw)) {
    return { ok: false, error: 'missing-wait' };
  }
  const wait = /** @type {Record<string, unknown>} */ (waitRaw);
  if (typeof wait.kind !== 'string' || !WAIT_KINDS.includes(wait.kind)) {
    return { ok: false, error: 'bad-wait-kind' };
  }
  /** @type {Record<string, unknown>} */
  const waitOut = { kind: wait.kind };
  if (wait.kind === 'retry-after' && wait.defaultMs !== undefined) {
    if (typeof wait.defaultMs !== 'number' || !Number.isFinite(wait.defaultMs) || wait.defaultMs <= 0 || wait.defaultMs > MAX_TIMER_DELAY_MS) {
      return { ok: false, error: 'bad-default-ms' };
    }
    waitOut.defaultMs = wait.defaultMs;
  }
  if (wait.kind === 'fixed') {
    if (typeof wait.ms !== 'number' || !Number.isFinite(wait.ms) || wait.ms <= 0 || wait.ms > MAX_TIMER_DELAY_MS) {
      return { ok: false, error: 'bad-fixed-ms' };
    }
    waitOut.ms = wait.ms;
  }
  if (wait.kind === 'reset-at' && wait.tz !== undefined) {
    if (typeof wait.tz !== 'string' || !/^[+-]\d{1,2}(?::?\d{2})?$/.test(wait.tz)) {
      return { ok: false, error: 'bad-tz' };
    }
    waitOut.tz = wait.tz;
  }
  if (wait.kind !== 'retry-after' && wait.kind !== 'fixed' && wait.group !== undefined) {
    if (!Number.isInteger(wait.group) || wait.group < 1) return { ok: false, error: 'bad-group' };
    if (wait.group > countGroups(when)) return { ok: false, error: 'group-out-of-range' };
    waitOut.group = wait.group;
  }
  rule.wait = waitOut;

  // 0 is "retry forever within the turn" (the engine maps it to an unlimited
  // budget); 1..100 is a finite per-turn attempt count.
  if (source.maxRetries !== undefined && source.maxRetries !== null) {
    if (!Number.isInteger(source.maxRetries) || source.maxRetries < 0 || source.maxRetries > 100) {
      return { ok: false, error: 'bad-max-retries' };
    }
    rule.maxRetries = source.maxRetries;
  }

  if (source.clampMs !== undefined && source.clampMs !== null) {
    if (!Number.isInteger(source.clampMs) || source.clampMs < DEFAULT_MIN_WAIT_MS || source.clampMs > HARD_MAX_WAIT_MS) {
      return { ok: false, error: 'bad-clamp' };
    }
    rule.clampMs = source.clampMs;
  }

  return { ok: true, rule };
}

/**
 * Validate a full rules document: `{ rules: [...], fallback: { maxDelayMs } }`.
 *
 * @param {unknown} parsed
 * @returns {{ ok: true, rules: Array<object>, fallback: object } | { ok: false, error: string }}
 */
export function normalizeDocument(parsed) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'not-object' };
  }
  const doc = /** @type {Record<string, unknown>} */ (parsed);
  if (!Array.isArray(doc.rules)) return { ok: false, error: 'bad-rules' };
  if (doc.rules.length > 100) return { ok: false, error: 'too-many-rules' };
  /** @type {Array<object>} */
  const rules = [];
  const names = new Set();
  for (const raw of doc.rules) {
    const normalized = normalizeRule(raw);
    if (!normalized.ok) return { ok: false, error: normalized.error };
    if (names.has(normalized.rule.name)) return { ok: false, error: 'duplicate-name' };
    names.add(normalized.rule.name);
    rules.push(normalized.rule);
  }
  /** @type {Record<string, unknown>} */
  const fallback = {};
  const rawFallback = doc.fallback;
  if (rawFallback !== undefined && rawFallback !== null) {
    if (typeof rawFallback !== 'object' || Array.isArray(rawFallback)) return { ok: false, error: 'bad-fallback' };
    const source = /** @type {Record<string, unknown>} */ (rawFallback);
    if (source.maxDelayMs !== undefined) {
      if (!Number.isInteger(source.maxDelayMs) || source.maxDelayMs < DEFAULT_MIN_WAIT_MS || source.maxDelayMs > HARD_MAX_WAIT_MS) {
        return { ok: false, error: 'bad-fallback-max' };
      }
      fallback.maxDelayMs = source.maxDelayMs;
    }
  }
  if (fallback.maxDelayMs === undefined) fallback.maxDelayMs = DEFAULT_MAX_WAIT_MS;
  return { ok: true, rules, fallback };
}

/**
 * Match one failure against one compiled rule (pre-filters + regex).
 *
 * @param {object} rule - normalized rule.
 * @param {RegExp | null} compiled - compiled `when`.
 * @param {{ provider: string, message: string, code: string, status?: number }} failure
 * @returns {RegExpExecArray | null} the match, or null.
 */
export function matchRule(rule, compiled, failure) {
  if (rule.enabled === false) return null;
  if (Array.isArray(rule.providers) && !rule.providers.includes(failure.provider)) return null;
  if (Array.isArray(rule.codes) && !rule.codes.includes(failure.code)) return null;
  if (Array.isArray(rule.status) && !rule.status.includes(failure.status)) return null;
  if (compiled === null) return null;
  compiled.lastIndex = 0;
  return compiled.exec(failure.message ?? '');
}

/**
 * Test one rule against a sample failure and describe the outcome — the pure
 * heart of the settings-page tester and the `test_retry_rule` AI tool.
 *
 * @param {object} rule - normalized rule.
 * @param {{ provider?: string, message: string, code?: string, status?: number, providerRetryAfterMs?: number }} failure
 * @param {number} nowMs
 * @param {object} [fallback] - `{ maxDelayMs }` clamp fallback.
 * @returns {{
 *   matched: boolean,
 *   rule?: object,
 *   matchText?: string,
 *   waitMs?: number | null,
 *   reason?: 'no-match' | 'provider-filter' | 'code-filter' | 'status-filter' | 'disabled' | 'no-wait'
 * }}
 */
export function testRule(rule, failure, nowMs, fallback = { maxDelayMs: DEFAULT_MAX_WAIT_MS }) {
  const full = {
    provider: failure.provider ?? '',
    message: failure.message ?? '',
    code: failure.code ?? '',
    status: failure.status,
  };
  if (rule.enabled === false) return { matched: false, reason: 'disabled' };
  if (Array.isArray(rule.providers) && !rule.providers.includes(full.provider)) {
    return { matched: false, reason: 'provider-filter' };
  }
  if (Array.isArray(rule.codes) && !rule.codes.includes(full.code)) {
    return { matched: false, reason: 'code-filter' };
  }
  if (Array.isArray(rule.status) && !rule.status.includes(full.status)) {
    return { matched: false, reason: 'status-filter' };
  }
  const compiled = compileWhen(rule);
  const match = compiled === null ? null : compiled.exec(full.message);
  if (match === null) return { matched: false, reason: 'no-match' };
  const group = typeof rule.wait.group === 'number' && rule.wait.group >= 1
    ? (typeof match[rule.wait.group] === 'string' ? match[rule.wait.group] : null)
    : null;
  // Hand the extractor the group text when named; otherwise pass the full
  // message (many rules match a trigger phrase while the time lives later
  // in the text — reset-at/duration extractors re-scan the whole message).
  const matchLike = group !== null
    ? /** @type {RegExpExecArray} */ (Object.assign([group], { index: match.index, input: group }))
    : /** @type {RegExpExecArray} */ (Object.assign([full.message], { index: 0, input: full.message }));
  const raw = extractWait(rule.wait.kind, rule.wait, matchLike, { ...failure, message: full.message }, nowMs);
  const maxMs = rule.clampMs ?? fallback.maxDelayMs;
  const waitMs = clampWait(raw, DEFAULT_MIN_WAIT_MS, maxMs);
  if (waitMs === null) return { matched: true, rule, matchText: match[0], waitMs: null, reason: 'no-wait' };
  return { matched: true, rule, matchText: match[0], waitMs };
}

/**
 * Evaluate every rule in order and return the first hit with its clamped wait.
 *
 * @param {Array<object>} rules - normalized rules.
 * @param {{ provider: string, message: string, code: string, status?: number, providerRetryAfterMs?: number }} failure
 * @param {number} nowMs
 * @param {object} [fallback] - `{ maxDelayMs }`.
 * @returns {{ rule: object, matchText: string, waitMs: number | null } | null}
 */
export function evaluateRules(rules, failure, nowMs, fallback = { maxDelayMs: DEFAULT_MAX_WAIT_MS }) {
  for (const rule of rules) {
    const outcome = testRule(rule, failure, nowMs, fallback);
    if (outcome.matched && outcome.waitMs !== null && outcome.waitMs !== undefined) {
      return { rule, matchText: outcome.matchText ?? '', waitMs: outcome.waitMs };
    }
  }
  return null;
}
