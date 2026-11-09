/**
 * Wait-duration extractors for the retry-rule engine.
 *
 * Each extractor pulls "how long until this failure recovers" out of one
 * provider failure: either the provider's own `providerRetryAfterMs`, a
 * duration written in the error text (English compound units, Go duration
 * format, Chinese units), an absolute reset time (with or without a zone),
 * an embedded unix timestamp, or structured JSON fields inside the message.
 *
 * The grammars are ported from production systems that solved the same
 * problem (yetone/magpie `routing.go`, NousResearch/hermes-agent
 * `retry_utils.py`, openai/codex `api_bridge.rs`) and are exercised against
 * real vendor payloads in test/retry/samples.test.mjs.
 *
 * @module
 */

/** Largest delay Node schedules without clamping to 1ms (dsh-timeout parity). */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Parse one ISO-like zone offset into minutes, or null when absent/invalid. */
function parseZoneOffset(text) {
  const m = /(?:UTC|GMT)?([+-])(\d{1,2})(?::?(\d{2}))?\s*$/.exec(text);
  if (m === null) return null;
  const sign = m[1] === '-' ? -1 : 1;
  const hours = Number(m[2]);
  const minutes = m[3] === undefined ? 0 : Number(m[3]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || hours > 14 || minutes > 59) return null;
  return sign * (hours * 60 + minutes);
}

/**
 * Parse an absolute local date-time with an optional zone offset.
 *
 * @param {string} text - like `2026-09-22 13:45:14`, `2026-09-22T13:45`, or
 *        `2026-09-22 13:45:14 +0800`.
 * @param {number} defaultZoneMinutes - zone used when the text names none
 *        (Zhipu writes Beijing times without a marker).
 * @param {number} nowMs - reference clock.
 * @returns {number | null} milliseconds until that instant, or null when the
 *          text is not a complete date-time or lies in the past.
 */
export function parseResetAt(text, defaultZoneMinutes, nowMs) {
  const m = /(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*(.*)$/.exec(text);
  if (m === null) return null;
  const [, y, mo, d, h, mi, sec, rest] = m;
  const offset = parseZoneOffset(rest.trim()) ?? defaultZoneMinutes;
  const seconds = sec === undefined ? 0 : Number(sec);
  const utcMs = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), seconds)
    - offset * 60_000;
  if (!Number.isFinite(utcMs)) return null;
  const wait = utcMs - nowMs;
  return wait > 0 ? wait : null;
}

/**
 * Extract an epoch-seconds timestamp from text such as Claude Code's
 * `usage limit reached|1760000000`.
 *
 * @param {string} message
 * @param {number} nowMs
 * @returns {number | null} milliseconds until the timestamp, or null.
 */
export function parseUnixSeconds(message, nowMs) {
  const m = /(?:\|\s*|resets[_\s]?at[":\s]+|resetsAt[":\s]+)(\d{10})\b/.exec(message);
  if (m === null) return null;
  const at = Number(m[1]) * 1000;
  const wait = at - nowMs;
  return wait > 0 ? wait : null;
}

/** Convert d/h/m/s capture groups into milliseconds; null when all empty. */
function dhmsToMs(days, hours, minutes, seconds, millis) {
  const d = days === undefined || days === '' ? 0 : Number(days);
  const h = hours === undefined || hours === '' ? 0 : Number(hours);
  const min = minutes === undefined || minutes === '' ? 0 : Number(minutes);
  const s = seconds === undefined || seconds === '' ? 0 : Number(seconds);
  const ms = millis === undefined || millis === '' ? 0 : Number(`0.${millis}`) * 1000;
  if (d === 0 && h === 0 && min === 0 && s === 0 && ms === 0) return null;
  if (![d, h, min, s].every(Number.isFinite)) return null;
  return d * 86_400_000 + h * 3_600_000 + min * 60_000 + s * 1000 + ms;
}

/** English compound duration grammars vendors actually write. */
const DURATION_PATTERNS = [
  // "resets in 4hr 5min", "resets in 2 hours 5 minutes", "resets in 30s",
  // "Try again in 23h 59m"
  new RegExp(
    '(?:\\bresets?\\s+in\\b|\\bretry\\s+(?:after|in)\\b|\\btry\\s+again\\s+in\\b)\\s*'
    + '(?:(\\d+(?:\\.\\d+)?)\\s*d(?:ays?)?\\b\\s*)?'
    + '(?:(\\d+(?:\\.\\d+)?)\\s*h(?:ours?|rs?|r)?\\b\\s*)?'
    + '(?:(\\d+(?:\\.\\d+)?)\\s*m(?:in(?:utes?|s)?|)?\\b\\s*)?'
    + '(?:(\\d+(?:\\.\\d+)?)\\s*s(?:ec(?:onds?|s)?|)?\\b)?',
    'i',
  ),
  // Gemini's quotaResetDelay field, quoted or bare: quotaResetDelay: 33s / "quotaResetDelay":"33s"
  /quotaResetDelay[":\s]+["']?(\d+(?:\.\d+)?)\s*(ms|s)["']?/i,
  // Antigravity's Go duration: "quota will reset after 3h19m30s"
  /\b(?:reset|retry|try\s+again)\s+(?:after|in)\s+(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?\b(?![-\d])/i,
];

/**
 * Extract an English duration from the message text.
 *
 * @param {string} message
 * @returns {number | null} milliseconds, or null when no duration grammar matches.
 */
export function parseDurationText(message) {
  for (const pattern of DURATION_PATTERNS) {
    const m = pattern.exec(message);
    if (m === null) continue;
    if (pattern === DURATION_PATTERNS[1]) {
      const value = Number(m[1]);
      if (!Number.isFinite(value) || value <= 0) continue;
      return m[2] === 'ms' ? value : value * 1000;
    }
    const ms = pattern === DURATION_PATTERNS[0]
      ? dhmsToMs(m[1], m[2], m[3], m[4], undefined)
      : dhmsToMs(undefined, m[1], m[2], String(Math.floor(Number(m[3] ?? 0))), String(Math.round((Number(m[3] ?? 0) % 1) * 1000)));
    if (ms !== null && ms > 0) return ms;
  }
  return null;
}

/**
 * Extract a Chinese duration: `请 1 分钟后重试`、`30秒后再试`、`2小时后恢复`。
 *
 * @param {string} message
 * @returns {number | null} milliseconds, or null.
 */
export function parseDurationCn(message) {
  const m = /(\d+(?:\.\d+)?)\s*(毫秒|秒钟?|分钟?|小时|时|天|日)\s*(?:之?后|后)(?:再(?:试|重试)|重试|恢复|开放)?/.exec(message);
  if (m === null) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  switch (m[2]) {
    case '毫秒': return value;
    case '秒钟':
    case '秒': return value * 1000;
    case '分钟':
    case '分': return value * 60_000;
    case '小时':
    case '时': return value * 3_600_000;
    case '天':
    case '日': return value * 86_400_000;
    default: return null;
  }
}

/**
 * Extract "wait until the next HH:mm" (today, or tomorrow when already
 * passed): `请于 17:00 后重试`, `available at 09:00`.
 *
 * @param {string} message
 * @param {number} nowMs
 * @returns {number | null} milliseconds, or null.
 */
export function parseClockTime(message, nowMs) {
  const m = /(?:请于|at|至|到)\s*(\d{1,2}):(\d{2})\s*(?:后|之后|后再?试)?/.exec(message);
  if (m === null) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return null;
  const date = new Date(nowMs);
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hours, minutes, 0, 0).getTime();
  let wait = target - nowMs;
  if (wait <= 0) wait += 86_400_000;
  return wait;
}

/**
 * Read structured reset fields out of a message that carries JSON:
 * `{"error":{"resets_at":<unix>,"resets_in_seconds":<n>}}` (Codex/ChatGPT),
 * tolerating stringified bodies (`'resets_in_seconds': 30995`).
 *
 * @param {string} message
 * @param {number} nowMs
 * @returns {number | null} milliseconds, or null.
 */
export function parseEpochJson(message, nowMs) {
  /** @type {any} */
  let parsed;
  try {
    parsed = JSON.parse(message);
  } catch {
    parsed = undefined;
  }
  const container = parsed !== undefined && typeof parsed === 'object' && parsed !== null
    ? parsed.error ?? parsed
    : undefined;
  if (container !== undefined && container !== null && typeof container === 'object') {
    const at = container.resets_at ?? container.resetsAt;
    if (typeof at === 'number' && Number.isFinite(at)) {
      const wait = at * 1000 - nowMs;
      if (wait > 0) return wait;
    }
    const seconds = container.resets_in_seconds ?? container.resetsInSeconds;
    if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0) {
      return seconds * 1000;
    }
  }
  // Stringified-body form: `'resets_in_seconds': 30995`
  const m = /['"]?resets_in_seconds['"]?\s*[:=]\s*['"]?(\d+(?:\.\d+)?)['"]?/.exec(message);
  if (m !== null) {
    const seconds = Number(m[1]);
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  }
  const atText = /['"]?resets_at['"]?\s*[:=]\s*['"]?(\d{10})['"]?/.exec(message);
  if (atText !== null) {
    const wait = Number(atText[1]) * 1000 - nowMs;
    if (wait > 0) return wait;
  }
  return null;
}

/**
 * Clamp a candidate wait into the engine's safety rails.
 *
 * @param {number | null | undefined} waitMs - candidate duration.
 * @param {number} minMs - floor (never busy-loop a 0ms wait).
 * @param {number} maxMs - ceiling (guard against hand-slip rules).
 * @returns {number | null} clamped duration, or null when there was none.
 */
export function clampWait(waitMs, minMs, maxMs) {
  if (waitMs === null || waitMs === undefined || !Number.isFinite(waitMs) || waitMs <= 0) return null;
  const ceiling = Number.isFinite(maxMs) ? Math.min(maxMs, MAX_TIMER_DELAY_MS) : DEFAULT_MAX_WAIT_MS;
  return Math.min(Math.max(Math.round(waitMs), minMs), ceiling);
}

/**
 * Run one extractor by kind over a regex match + failure.
 *
 * @param {string} kind - extractor kind (see WAIT_KINDS).
 * @param {object} wait - the rule's `wait` configuration.
 * @param {RegExpMatchArray | null} match - `when` match on the failure text.
 * @param {{ message: string, providerRetryAfterMs?: number }} failure
 * @param {number} nowMs
 * @returns {number | null} raw milliseconds (unclamped), or null.
 */
export function extractWait(kind, wait, match, failure, nowMs) {
  const text = failure.message ?? '';
  switch (kind) {
    case 'retry-after': {
      if (Number.isFinite(failure.providerRetryAfterMs) && failure.providerRetryAfterMs > 0) {
        return failure.providerRetryAfterMs;
      }
      const fallback = wait.defaultMs;
      return typeof fallback === 'number' && Number.isFinite(fallback) && fallback > 0 ? fallback : null;
    }
    case 'fixed': {
      // A constant interval the user chose: unlike retry-after it ignores any
      // provider Retry-After hint and always waits exactly `wait.ms`.
      const ms = wait.ms;
      return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : null;
    }
    case 'duration-text':
      return match === null ? parseDurationText(text) : parseDurationText(match[0]) ?? parseDurationText(text);
    case 'duration-cn':
      return match === null ? parseDurationCn(text) : parseDurationCn(match[0]) ?? parseDurationCn(text);
    case 'reset-at': {
      const source = match !== null ? match[0] : text;
      const zone = typeof wait.tz === 'string' ? parseZoneOffset(wait.tz) : undefined;
      return parseResetAt(source, zone ?? DEFAULT_ZONE_MINUTES, nowMs)
        ?? parseResetAt(text, zone ?? DEFAULT_ZONE_MINUTES, nowMs);
    }
    case 'unix-seconds':
      return parseUnixSeconds(match !== null ? match[0] : text, nowMs) ?? parseUnixSeconds(text, nowMs);
    case 'epoch-json':
      return parseEpochJson(text, nowMs) ?? parseEpochJson(match !== null ? match[0] : '', nowMs);
    case 'clock-time':
      return parseClockTime(match !== null ? match[0] : text, nowMs) ?? parseClockTime(text, nowMs);
    default:
      return null;
  }
}

/** Zone used for reset times that name none: Zhipu/bigmodel write Beijing time. */
export const DEFAULT_ZONE_MINUTES = 8 * 60;

/** Default wait ceiling when a caller passes no fallback (6 hours). */
export const DEFAULT_MAX_WAIT_MS = 6 * 60 * 60 * 1000;

/** The extractor kinds a rule may name. */
export const WAIT_KINDS = ['retry-after', 'fixed', 'duration-text', 'duration-cn', 'reset-at', 'unix-seconds', 'epoch-json', 'clock-time'];
