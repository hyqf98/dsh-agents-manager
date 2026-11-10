/**
 * The retry engine: one prepend listener on the `agent/request-error`
 * waterfall that evaluates the user's rules before the built-in
 * `dsh-llm-retry` executor.
 *
 * Ordering: the plugin fiber registers after `dsh-base` mounted the executor,
 * so its listener would run innermost (later listeners wrap earlier ones and
 * run first); `prepend: true` is belt-and-braces for any future loader
 * change. A rule hit schedules a durable wait exactly like the built-in
 * executor: the `llm/retry` event lands in the session log BEFORE the timer
 * starts (crash-consistent history), the wait is cancellable by both the
 * turn's abort signal and plugin disposal, and `{ kind: 'retry' }` makes the
 * loop re-run the failed step inside the same open turn. A miss passes the
 * decision downstream untouched — the built-in executor keeps its normal /
 * always semantics byte-for-byte.
 *
 * Rule-hit accounting is per (session, rule, turn): a rule's `maxRetries`
 * budget resets when the turn ends, so a long multi-step conversation gets a
 * fresh budget per turn while a single stuck step can never loop forever.
 *
 * @module
 */
import { evaluateRules, DEFAULT_MAX_RETRIES } from './rules.js';

/** Wait floor for every rule hit (dsh-llm-retry parity: never busy-loop). */
const MIN_WAIT_MS = 1000;

/**
 * A cancellable delay that resolves true when it elapsed, false when aborted.
 *
 * @param {number} delayMs
 * @param {AbortSignal} signal
 * @returns {Promise<boolean>}
 */
function cancellableDelay(delayMs, signal) {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, delayMs);
    function onAbort() {
      clearTimeout(timer);
      resolve(false);
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Create the retry engine.
 *
 * @param {object} options
 * @param {() => { rules: Array<object>, fallback: object }} options.rules - compiled snapshot source.
 * @param {(event: object) => void} options.onRetry - durable-event hook
 *        (monitor + session log append, wired by the caller).
 * @param {(record: { sessionId: string, turn: number, step: number, provider: string, code: string,
 *          status: number | null, message: string, reason: 'no-rules' | 'no-match' | 'budget-exhausted',
 *          ruleName: string | null, ruleCount: number }) => void} [options.onMiss] - advisory hook for
 *        failures the rules did NOT convert into a retry (the monitoring
 *        surface shows them with the reason, so "why didn't it retry" stays
 *        answerable). Called synchronously right before the pass-through.
 * @param {(message: string) => void} [options.log] - diagnostic sink.
 * @param {() => number} [options.now] - injectable clock.
 * @param {boolean} [options.abortWaitsOnDispose] - abort in-flight waits when the
 *        row is disposed. Default false: a loader hot-reload (plugin-market
 *        update of ANY plugin rebuilds rows) must not kill a scheduled retry
 *        that the agent loop is still awaiting — the wait keeps its turn
 *        alive and resolves `{kind:'retry'}` even if this module instance is
 *        gone. Only server shutdown (process exit) and explicit disposal with
 *        this flag end waits early.
 * @returns {object} engine handle: `{ install(ctx), dispose(), status() }`.
 */
export function createRetryEngine(options) {
  const log = options.log ?? (() => {});
  const now = options.now ?? (() => Date.now());
  const lifetime = new AbortController();
  /** See options.abortWaitsOnDispose: reload-safe by default. */
  const abortWaitsOnDispose = options.abortWaitsOnDispose === true;
  /** Active waits, drained on dispose. */
  const active = new Set();
  /** Per (sessionKey, ruleName) hit counts within the current turn. */
  const budgets = new Map();
  /** Last-seen turn per session, so budgets reset when a turn ends. */
  const sessionTurn = new Map();
  let installed = false;
  /** @type {(() => void) | null} */
  let disposer = null;

  /** Reset every budget when a session's turn number advances. */
  function observeTurn(sessionKey, turn) {
    if (sessionKey === '') return;
    const previous = sessionTurn.get(sessionKey);
    if (previous === turn) return;
    sessionTurn.set(sessionKey, turn);
    for (const key of budgets.keys()) {
      if (key.startsWith(`${sessionKey}\u0000`)) budgets.delete(key);
    }
  }

  /** The engine's live view for status panels. */
  function status() {
    return { waiting: active.size };
  }

  /**
   * Stop the engine. By default in-flight waits are LEFT RUNNING: their owning
   * agent loop is still awaiting the returned promise, and a plugin-row
   * hot-reload (loader rebuild triggered by any plugin-market update) must not
   * turn a scheduled retry into a failed turn. The listener is removed either
   * way, so no NEW wait can start from this instance. Pass
   * `abortWaitsOnDispose: true` (tests / explicit teardown) to cancel them.
   */
  function dispose() {
    if (abortWaitsOnDispose) lifetime.abort(new Error('retry engine disposed'));
    const pending = [...active];
    active.clear();
    budgets.clear();
    sessionTurn.clear();
    try {
      disposer?.();
    } catch { /* listener already gone */ }
    disposer = null;
    installed = false;
    return Promise.allSettled(pending);
  }

  /**
   * Report a failure the rules passed on, to the advisory miss hook.
   *
   * @param {object} base - `{ sessionId, turn, step }` waterfall coordinates.
   * @param {object} failure - normalized failure view.
   * @param {'no-rules' | 'no-match' | 'budget-exhausted'} reason
   * @param {string | null} ruleName
   * @param {number} ruleCount
   */
  function reportMiss(base, failure, reason, ruleName, ruleCount) {
    if (typeof options.onMiss !== 'function') return;
    try {
      options.onMiss({
        sessionId: base.sessionId,
        turn: base.turn,
        step: base.step,
        provider: failure.provider,
        code: failure.code,
        status: failure.status ?? null,
        message: failure.message.slice(0, 500),
        reason,
        ruleName,
        ruleCount,
      });
    } catch (error) {
      log(`agents-manager: retry miss hook failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * The waterfall listener. `prepend: true` keeps this rule pass ahead of
   * the built-in executor regardless of loader ordering.
   *
   * @param {object} payload - `{ agent, turn, step, provider, failure, retryPolicy, signal }`.
   * @param {() => Promise<{ kind?: string } | undefined>} next
   * @returns {Promise<{ kind: string } | undefined>}
   */
  async function onRequestError(payload, next) {
    if (lifetime.signal.aborted || payload?.signal?.aborted) return undefined;
    const { rules, fallback } = options.rules();

    const agent = payload.agent;
    const sessionKey = typeof agent?.session?.id === 'string' ? agent.session.id : '';
    observeTurn(sessionKey, payload.turn);
    const failure = {
      provider: String(payload.provider ?? ''),
      message: String(payload.failure?.message ?? ''),
      code: String(payload.failure?.code ?? ''),
      status: typeof payload.failure?.status === 'number' ? payload.failure.status : undefined,
      providerRetryAfterMs: typeof payload.failure?.providerRetryAfterMs === 'number'
        ? payload.failure.providerRetryAfterMs
        : undefined,
    };

    if (rules.length === 0) {
      if (failure.message !== '') {
        reportMiss({ sessionId: sessionKey, turn: payload.turn, step: payload.step }, failure, 'no-rules', null, 0);
      }
      return next();
    }
    if (failure.message === '') return next();

    const hit = evaluateRules(rules, failure, now(), fallback);
    if (hit === null) {
      reportMiss({ sessionId: sessionKey, turn: payload.turn, step: payload.step }, failure, 'no-match', null, rules.length);
      return next();
    }

    const ruleName = String(hit.rule.name ?? '');
    const budgetKey = `${sessionKey}\u0000${ruleName}`;
    const budget = hit.rule.maxRetries ?? DEFAULT_MAX_RETRIES;
    // maxRetries 0 means "retry forever within this turn": the comparison
    // below never trips for Infinity. `record.budget` keeps the user-facing
    // value (0) so session events and UI stay JSON-safe.
    const limit = budget === 0 ? Infinity : budget;
    const used = budgets.get(budgetKey) ?? 0;
    if (used >= limit) {
      log(`agents-manager: retry rule "${ruleName}" exhausted its budget (${budget}) on this turn; deferring downstream`);
      reportMiss({ sessionId: sessionKey, turn: payload.turn, step: payload.step }, failure, 'budget-exhausted', ruleName, rules.length);
      return next();
    }
    budgets.set(budgetKey, used + 1);

    const fused = AbortSignal.any?.([payload.signal, lifetime.signal].filter(Boolean)) ?? payload.signal;
    if (fused === undefined || fused.aborted) return undefined;

    const attempt = used + 1;
    const startedAt = now();
    const record = {
      ruleName,
      provider: failure.provider,
      code: failure.code,
      status: failure.status ?? null,
      waitMs: hit.waitMs,
      attempt,
      budget,
      turn: payload.turn,
      step: payload.step,
      startedAt,
      message: failure.message.slice(0, 2000),
    };
    const tracked = (async () => {
      try {
        options.onRetry(record);
      } catch (error) {
        log(`agents-manager: retry event hook failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!await cancellableDelay(hit.waitMs, fused)) {
        // The wait was cancelled mid-flight: the turn's abort signal fired
        // (user stop, model switch, provider reload) or this plugin is going
        // away. Record WHY in the monitor so "the wait vanished" stays
        // answerable from the settings page.
        try {
          options.onCancel?.(record);
        } catch { /* advisory */ }
        return undefined;
      }
      try {
        options.onRetry({ ...record, phase: 'started' });
      } catch { /* advisory */ }
      return { kind: 'retry' };
    })();
    active.add(tracked);
    tracked.finally(() => active.delete(tracked)).catch(() => {});
    return tracked;
  }

  /**
   * Install the waterfall listener on the host context.
   *
   * @param {object} ctx - plugin host context.
   */
  function install(ctx) {
    if (installed) return;
    installed = true;
    disposer = ctx.on('agent/request-error', onRequestError, { prepend: true });
  }

  return { install, dispose, status, onRequestError };
}
