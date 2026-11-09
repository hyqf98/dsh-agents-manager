/**
 * Retry monitor: turns live `llm/retry` / `llm/retry-started` session events
 * plus plugin-miss failures into the monitoring surface the settings page and
 * AI tools read.
 *
 * `llm/retry` is a non-surface event both this plugin's engine and the
 * built-in dsh-llm-retry executor append to the session log: it records the
 * durable scheduling of a wait (before any timer starts). The monitor keeps
 * a bounded ring of recent entries plus the set of waits still in flight
 * (scheduled but not yet started, per the log), and evicts them on
 * `turn/end` / `agent/disposed`.
 *
 * Failures the retry rules passed on (no rules, no match, exhausted budget)
 * are recorded through `recordFailure` as `kind: 'failure'` rows — without
 * them "why didn't it retry" has no visible answer. Consecutive identical
 * misses fold into one row with a `count`.
 *
 * The recent ring persists to a plugin-owned JSON file (atomic write, bounded,
 * fail-soft) so a DSH restart no longer blanks the settings page's history;
 * `active` stays memory-only because a restart kills the waits anyway. Loaded
 * retry rows without a terminal phase are marked `expired` — the host that
 * scheduled their waits is gone, and they must never resurrect as active.
 *
 * @module
 */
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Ring size for the recent-events list. */
export const RECENT_LIMIT = 100;
/** Oldest kept entry age (ms) — entries older than this drop from `active`. */
export const ACTIVE_TTL_MS = 24 * 60 * 60 * 1000;
/** Longest failure text kept in a row (monitor rows are display records). */
const MAX_MESSAGE_CHARS = 500;

/**
 * Create the monitor.
 *
 * @param {object} [options]
 * @param {() => number} [options.now] - injectable clock.
 * @param {string | null} [options.persistPath] - plugin-owned JSON file the
 *        recent ring survives restarts in; null/omitted keeps everything
 *        in memory (tests, headless compositions).
 * @param {(message: string) => void} [options.log] - diagnostic sink.
 * @returns {object} monitor handle: `{ init, observe, recordFailure, dropSession, snapshot, dispose }`.
 */
export function createRetryMonitor(options = {}) {
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? (() => {});
  const persistPath = typeof options.persistPath === 'string' && options.persistPath !== ''
    ? options.persistPath
    : null;

  /** @type {Array<object>} most-recent-first ring of retry/failure events. */
  let recent = [];
  /** @type {Map<string, object>} active waits keyed by `${sessionId}:${retryId}`. */
  const active = new Map();
  /** @type {Map<string, number>} session → last-seen time, for cleanup. */
  const sessions = new Map();
  /** Serialize concurrent persistence writes (last write wins). */
  let persisting = Promise.resolve();

  /** Stable identity of a failure row for adjacent-dedupe. */
  function failureFingerprint(entry) {
    return `${entry.sessionId}\u0000${entry.turn}\u0000${entry.step}\u0000${entry.code}\u0000${entry.reason}`;
  }

  /** Persist the recent ring (fail-soft, atomic tmp+rename, serialized). */
  function persistRecent() {
    if (persistPath === null) return;
    const body = `${JSON.stringify({ recent }, null, 2)}\n`;
    persisting = persisting.then(async () => {
      try {
        await mkdir(dirname(persistPath), { recursive: true });
        const temp = `${persistPath}.tmp`;
        await writeFile(temp, body, 'utf8');
        await rename(temp, persistPath);
      } catch (error) {
        log(`agents-manager: retry monitor persist failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }).catch(() => { /* the chain must never reject */ });
  }

  /**
   * Load the persisted recent ring at startup. Invalid or absent files start
   * empty. Retry rows without a terminal phase are marked `expired`: the
   * previous host's waits died with it, and nothing loaded from disk may
   * re-enter the active set.
   *
   * @returns {Promise<void>}
   */
  async function init() {
    if (persistPath === null) return;
    let text;
    try {
      text = await readFile(persistPath, 'utf8');
    } catch {
      return; // absent or unreadable: start empty
    }
    try {
      const parsed = JSON.parse(text);
      const rows = Array.isArray(parsed?.recent) ? parsed.recent : [];
      recent = rows
        .filter((entry) => entry !== null && typeof entry === 'object')
        .slice(0, RECENT_LIMIT)
        .map((entry) => (entry.kind !== 'failure' && entry.phase === undefined
          ? { ...entry, phase: 'expired' }
          : entry));
    } catch (error) {
      log(`agents-manager: retry monitor history unreadable (${error instanceof Error ? error.message : String(error)}); starting empty`);
      recent = [];
    }
  }

  /**
   * Record one failure the retry rules passed on (`kind: 'failure'` row).
   * Adjacent identical misses fold into the previous row's `count`.
   *
   * @param {{ sessionId?: string, turn?: number, step?: number, provider?: string,
   *           code?: string, status?: number | null, message?: string, reason?: string,
   *           ruleName?: string | null, ruleCount?: number }} record
   */
  function recordFailure(record) {
    const entry = {
      kind: 'failure',
      sessionId: typeof record?.sessionId === 'string' ? record.sessionId : '',
      retryId: `miss-${record?.turn ?? 0}-${record?.step ?? 0}`,
      time: now(),
      turn: typeof record?.turn === 'number' ? record.turn : null,
      step: typeof record?.step === 'number' ? record.step : null,
      provider: String(record?.provider ?? ''),
      mode: 'none',
      ruleName: typeof record?.ruleName === 'string' && record.ruleName !== '' ? record.ruleName : null,
      reason: String(record?.reason ?? 'no-match'),
      delayMs: null,
      retry: null,
      maxRetries: null,
      failure: {
        message: String(record?.message ?? '').slice(0, MAX_MESSAGE_CHARS),
        code: String(record?.code ?? ''),
        ...(typeof record?.status === 'number' ? { status: record.status } : {}),
      },
      count: 1,
    };
    const previous = recent[0];
    if (previous !== undefined && previous.kind === 'failure' && failureFingerprint(previous) === failureFingerprint(entry)) {
      previous.count = (typeof previous.count === 'number' ? previous.count : 1) + 1;
      previous.time = entry.time;
      persistRecent();
      return;
    }
    recent = [entry, ...recent].slice(0, RECENT_LIMIT);
    if (entry.sessionId !== '') sessions.set(entry.sessionId, entry.time);
    persistRecent();
  }

  /**
   * Observe one committed session event (wired from `session/event`).
   *
   * @param {object} session - the session the event belongs to.
   * @param {object} event - the committed event (`type`, `data`, `time`).
   */
  function observe(session, event) {
    const type = event?.type;
    if (type === 'llm/retry') {
      const data = event.data ?? {};
      const entry = {
        kind: 'retry',
        sessionId: typeof session?.id === 'string' ? session.id : '',
        retryId: String(data.retryId ?? ''),
        time: typeof event.time === 'number' ? event.time : now(),
        provider: String(data.provider ?? ''),
        mode: String(data.mode ?? 'normal'),
        ruleName: typeof data.ruleName === 'string' ? data.ruleName : null,
        delayMs: typeof data.delayMs === 'number' ? data.delayMs : null,
        retry: typeof data.retry === 'number' ? data.retry : null,
        maxRetries: typeof data.maxRetries === 'number' ? data.maxRetries : null,
        failure: data.failure ?? null,
      };
      recent = [entry, ...recent].slice(0, RECENT_LIMIT);
      if (entry.sessionId !== '') sessions.set(entry.sessionId, entry.time);
      if (entry.delayMs !== null && entry.delayMs > 0) {
        active.set(`${entry.sessionId}:${entry.retryId}`, { ...entry, phase: 'waiting' });
      }
      persistRecent();
      return;
    }
    if (type === 'llm/retry-started') {
      const data = event.data ?? {};
      const key = `${typeof session?.id === 'string' ? session.id : ''}:${String(data.retryId ?? '')}`;
      const entry = active.get(key);
      if (entry !== undefined) {
        active.delete(key);
        recent = [{ ...entry, phase: 'started', time: typeof event.time === 'number' ? event.time : now() }, ...recent.filter((r) => r !== entry)].slice(0, RECENT_LIMIT);
        persistRecent();
      }
      return;
    }
    if (type === 'turn/end') {
      const id = typeof session?.id === 'string' ? session.id : '';
      for (const key of [...active.keys()]) {
        if (key.startsWith(`${id}:`)) active.delete(key);
      }
    }
  }

  /**
   * Forget one session's live state (agent/disposed): its in-flight waits and
   * cleanup tracking go. Recent history rows stay — a closed session's retry
   * story must remain inspectable in the settings page.
   *
   * @param {string} sessionId
   */
  function dropSession(sessionId) {
    sessions.delete(sessionId);
    for (const key of [...active.keys()]) {
      if (key.startsWith(`${sessionId}:`)) active.delete(key);
    }
  }

  /** Drop active entries whose wait window has long passed (crash residue). */
  function sweep() {
    const cutoff = now() - ACTIVE_TTL_MS;
    for (const [key, entry] of [...active.entries()]) {
      const deadline = (entry.time ?? 0) + (entry.delayMs ?? 0);
      if (deadline < cutoff) active.delete(key);
    }
    for (const [id, lastSeen] of sessions) {
      if (lastSeen < cutoff) sessions.delete(id);
    }
  }

  /**
   * The monitoring snapshot served by /retry/state and the AI tool.
   *
   * @returns {{ active: Array<object>, recent: Array<object> }}
   */
  function snapshot() {
    sweep();
    const nowMs = now();
    return {
      active: [...active.values()].map((entry) => ({
        ...entry,
        remainingMs: Math.max(0, (entry.time ?? 0) + (entry.delayMs ?? 0) - nowMs),
      })),
      recent,
    };
  }

  /** Flush any pending persistence write (best-effort, for disposal). */
  async function dispose() {
    await persisting.catch(() => { /* advisory */ });
  }

  return { init, observe, recordFailure, dropSession, snapshot, dispose };
}
