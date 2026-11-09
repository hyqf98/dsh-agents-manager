/**
 * Auto-retry feature row (`agents-manager-retry`).
 *
 * Owns the retry-rules store, the cross-restart monitor, the prepend engine
 * on `agent/request-error`, the three AI tools (read_retry_state /
 * test_retry_rule / write_retry_rules), and the「自动重试」settings page's
 * HTTP services. When this row is disabled no rule matches, no monitor
 * persists, and the client hides the settings page (via /state.features).
 *
 * @module
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRetryStore } from '../retry/store.js';
import { createRetryEngine } from '../retry/engine.js';
import { createRetryMonitor } from '../retry/monitor.js';
import { listRetryTargets, writeRetryPolicy, resetRetryPolicy } from '../retry/manager.js';
import { buildRetryTools } from '../retry/tools.js';
import { RETRY_PRESETS } from '../retry/presets.js';

/**
 * Compose the retry feature against the core service.
 *
 * @param {object} ctx - plugin host context for this row.
 * @returns {void}
 */
export function apply(ctx) {
  ctx.inject(['agents-manager:core'], (scope) => {
    const core = typeof scope.get === 'function' ? scope.get('agents-manager:core') : scope['agents-manager:core'];
    if (core === undefined || core === null) return;

    const warn = (message) => { try { ctx.logger?.warn?.(message); } catch { /* logging is optional */ } };

    const retryStore = createRetryStore({
      resolveStorageDomain: () => core.serviceOf('storageDomain') ?? null,
      log: warn,
    });
    const retryMonitor = createRetryMonitor({
      persistPath: join(homedir(), '.dsh', 'agents-manager', 'monitor.json'),
      log: warn,
    });

    /**
     * Locate the live agent a retry record belongs to: the core threads the
     * waterfall payload's agent into onRetry for the current call only.
     *
     * @type {((record: object) => object | undefined) | null}
     */
    let agentByRetryRecord = null;
    /**
     * retryKey → session id, captured while onRetry runs (the agent handle is
     * gone again by the time a later onCancel fires).
     *
     * @type {Map<string, string>}
     */
    const sessionOfRetry = new Map();
    /** The stable key a record is known under across its phases. */
    const retryKeyOf = (record) => `${record.ruleName}\u0000${record.turn}\u0000${record.step}\u0000${record.attempt}`;

    const retryEngine = createRetryEngine({
      rules: () => retryStore.current(),
      onRetry: (record) => {
        // Durable-before-wait, mirroring the built-in executor: the llm/retry
        // event lands in the session log first; the monitor observes it
        // through session/event like any other consumer. The engine's second
        // callback (phase 'started') appends the paired llm/retry-started
        // event (V4 requires one strictly increasing retry chain per policy).
        const agent = agentByRetryRecord?.(record);
        if (agent?.session !== undefined && agent.session !== null) {
          sessionOfRetry.set(retryKeyOf(record), String(agent.session.id ?? ''));
          try {
            if (record.phase === 'started') {
              agent.session.append('llm/retry-started', {
                retryId: `${record.ruleName}-${record.turn}-${record.step}-${record.attempt}`,
                turn: record.turn,
                step: record.step,
                retry: record.attempt,
              });
            } else {
              agent.session.append('llm/retry', {
                retryId: `${record.ruleName}-${record.turn}-${record.step}-${record.attempt}`,
                turn: record.turn,
                step: record.step,
                provider: record.provider,
                mode: 'plugin-rule',
                ruleName: record.ruleName,
                retry: record.attempt,
                maxRetries: record.budget,
                delayMs: record.waitMs,
                failure: { message: record.message, code: record.code, ...(record.status === null ? {} : { status: record.status }) },
              });
            }
          } catch (error) {
            warn(`agents-manager: retry event append failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      },
      onMiss: (record) => {
        // Failures the rules passed on still land in the monitoring surface
        // (kind 'failure' row with the pass-on reason).
        try {
          retryMonitor.recordFailure(record);
        } catch { /* monitoring is advisory */ }
      },
      onCancel: (record) => {
        // A scheduled wait that the turn's abort signal cancelled (user stop,
        // model switch, provider reload) or plugin teardown dropped. Surface
        // it as a monitor row so "the wait vanished" has a visible cause.
        try {
          const key = retryKeyOf(record);
          const sessionId = sessionOfRetry.get(key) ?? '';
          sessionOfRetry.delete(key);
          retryMonitor.recordFailure({
            sessionId,
            turn: record.turn,
            step: record.step,
            provider: record.provider,
            code: record.code,
            status: record.status ?? undefined,
            message: record.message,
            reason: 'cancelled',
            ruleName: record.ruleName,
          });
        } catch { /* monitoring is advisory */ }
      },
      log: warn,
    });

    // Engine: prepend listener with the agent threaded through per call.
    try {
      const engineInner = retryEngine;
      const wrappedOnRequestError = async (payload, next) => {
        agentByRetryRecord = () => payload?.agent;
        try {
          return await engineInner.onRequestError(payload, next);
        } finally {
          agentByRetryRecord = null;
        }
      };
      const offEngine = ctx.on('agent/request-error', wrappedOnRequestError, { prepend: true });
      ctx.effect(() => () => { try { offEngine(); } catch { /* already gone */ } }, 'agents-manager: retry engine listener');
    } catch (error) {
      warn(`agents-manager: retry engine install failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Monitor: observe committed llm/retry events from every session.
    const offRetryEvents = ctx.on('session/event', (session, event) => {
      try {
        if (event?.type === 'llm/retry' || event?.type === 'llm/retry-started' || event?.type === 'turn/end') {
          retryMonitor.observe(session, event);
        }
      } catch { /* monitoring is advisory */ }
    });

    // The monitor loads its persisted ring first so pre-restart history is
    // visible from the first settings-page poll; the store opens alongside.
    retryMonitor.init().catch((error) => {
      warn(`agents-manager: retry monitor history load failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    retryStore.init().catch((error) => {
      warn(`agents-manager: retry rule store startup failed: ${error instanceof Error ? error.message : String(error)}`);
    });

    ctx.effect(() => () => {
      offRetryEvents();
      void retryEngine.dispose();
      void retryStore.dispose();
      void retryMonitor.dispose();
    }, 'agents-manager: retry row teardown');

    const disposeRetry = core.features.register('retry', {
      /**
       * Tool definitions for one agent-binding sync: the retry trio.
       *
       * @returns {Array<object>}
       */
      toolDefinitions() {
        return buildRetryTools({
          rules: () => retryStore.current(),
          monitor: () => retryMonitor.snapshot(),
          listTargets: () => listRetryTargets(ctx),
          saveDocument: (rules, fallback) => retryStore.saveDocument(rules, fallback),
          presets: () => RETRY_PRESETS,
        });
      },
      /** HTTP services for the settings page's /retry routes. */
      apiServices() {
        return {
          retryStore,
          retryMonitor: () => retryMonitor.snapshot(),
          listRetryTargets: () => listRetryTargets(ctx),
          writeRetryPolicy: (provider, policy) => writeRetryPolicy(ctx, provider, policy),
          resetRetryPolicy: (provider) => resetRetryPolicy(ctx, provider),
        };
      },
    });
    // Agents bound before this row resolved must re-sync for the retry trio.
    core.syncAllAgents();
    try {
      ctx.effect(() => () => disposeRetry(), 'agents-manager: retry row feature disposer');
    } catch { /* manual detach on row teardown */ }
  });
}

export const inject = ['agents-manager:core'];
