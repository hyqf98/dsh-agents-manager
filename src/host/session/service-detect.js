/**
 * Service-start detection: the three-layer "the report always happens"
 * machinery behind `report_service_process`.
 *
 * Layer 1 — `tools/pre-execute` over foreground shell calls flags a command
 * that looks like it starts a long-lived local service, remembering the
 * callId in a per-agent pending table (advisory state only; the call is
 * always allowed through untouched).
 * Layer 2 — `tools/post-execute` settles that flag: when the call finished
 * and the model never reported the process itself, one labeled notice is
 * prepended to the decision's additional contexts (the same channel
 * dsh-repeat-tool-reminder uses), asking the model to call
 * `report_service_process` now. The reminder is once per callId and never
 * rewrites or blocks the result.
 * Layer 3 — the host entry separately subscribes to `ctx.jobs` events to
 * auto-register unmatched service jobs in the process panel; that wiring
 * lives in the host entry, this module only owns the shared heuristic and
 * the pending table.
 *
 * @module
 */

/** Heuristic command patterns that look like a local service start. */
const SERVICE_COMMAND_PATTERNS = [
  /(^|\s|["'/])java\s+(-[^e\s]+\s+)*-jar\b/,
  /(^|\s|["'/])java\b[^\n|;&]*\bspring-boot\b/,
  /(^|\s)mvn\b[^\n|;&]*spring-boot:run\b/,
  /(^|\s)gradle?w?\b[^\n|;&]*bootRun\b/,
  /(^|\s)npm\b[^\n|;&]*\b(run\s+)?(dev|serve|start)\b/,
  /(^|\s|["'/])(npx|pnpm|yarn|bunx?)\b[^\n|;&]*(\bvite\b|\bdev\b|\bserve\b|\bstart\b)/,
  /(^|\s|["'/])(vite|next|nuxt|astro|webpack-dev-server|ng)\b/,
  /(^|\s|["'/])python3?\b[^\n|;&]*-m\s+(http\.server|simple_http_server|uvicorn|flask|gunicorn)\b/,
  /(^|\s|["'/])uvicorn\b/,
  /(^|\s|["'/])flask\b[^\n|;&]*\brun\b/,
  /(^|\s|["'/])node\b[^\n|;&]*\b(server|app|main|index)\.(js|mjs|cjs|ts)\b/,
  /(^|\s|["'/])(redis-server|mongod|postgres|pg_ctl|mariadbd|mysqld)\b/,
  /(^|\s)docker(-compose)?\b[^\n|;&]*\b(up|compose up)\b/,
  /(^|\s|["'/])(php|ruby)\b[^\n|;&]*(-S\s|rails\s+(s|server)\b)/,
];

/** Commands that merely mention service tooling without running a server. */
const NON_SERVICE_PATTERNS = [
  /(^|\s)(cat|less|head|tail|grep|rg|ag|awk|sed|find|file|stat|which|type|command|echo)\b/,
  /(^|\s)(git|gh)\b/,
  /(^|\s)(curl|wget|nc|nmap|ping|dig|ssh)\b/,
  /(^|\s)(docker|docker-compose|kubectl|helm)\b[^\n|;&]*\b(ps|logs|inspect|exec|top|stats)\b/,
  /(^|\s)(ps|lsof|netstat|ss|top|htop|kill|pkill)\b/,
];

/** How long an unsettled flag stays valid, in ms (a stuck call cannot pin memory). */
const PENDING_TTL_MS = 30_000;

/** Longest command excerpt kept in a flag or notice. */
const MAX_COMMAND_CHARS = 200;

/** Tool names whose calls start local processes. */
const SHELL_TOOLS = ['bash', 'pwsh'];

/**
 * Whether one shell command looks like it starts a long-lived local
 * service. The negative pass runs first so a read-only command that merely
 * quotes a service command (`grep 'java -jar' README`) does not flag.
 *
 * @param {string} command - raw command text.
 * @returns {boolean}
 */
export function looksLikeServiceStart(command) {
  if (typeof command !== 'string' || command.trim() === '') return false;
  if (NON_SERVICE_PATTERNS.some((pattern) => pattern.test(command))) return false;
  return SERVICE_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
}

/**
 * The reminder notice text for one flagged call.
 *
 * @param {string} command - the flagged command (already excerpted).
 * @returns {string}
 */
export function serviceReportReminderText(command) {
  return `You just started a long-running local service (command: ${command}).`
    + ' Call report_service_process now with its name, the port(s) you expect it to listen on, pid if you know it, and url;'
    + ' the user only sees services that were reported. A foreground shell call returns before the service finishes starting,'
    + ' so report with the expected ports anyway and re-report later to correct them.';
}

/**
 * Create the pending-flag store plus the two waterfall listeners. The
 * listeners are built per agent (registered on `agent.ctx` by the host
 * entry) so their state dies with the agent; this factory exists so tests
 * drive stub contexts.
 *
 * The reminder message shape follows dsh-repeat-tool-reminder: a
 * `createUserMessage`-style plain object with a labeled `source.kind`, so
 * derived history renders it as a notice, never as a user prompt.
 *
 * @param {object} [services]
 * @param {(message: string) => void} [services.log] - diagnostic sink.
 * @param {() => number} [services.now] - injectable clock.
 * @param {(content: Array<object>, source: object) => object} [services.createUserMessage]
 *        - message factory, defaults to a plain record shaped like the kernel's.
 * @returns {{ detect: import('./service-detect.js').DetectApi }} listener bundle.
 */
export function createServiceDetect(services = {}) {
  const log = services.log ?? (() => {});
  const now = services.now ?? (() => Date.now());
  const makeMessage = services.createUserMessage
    ?? ((content, source) => ({ role: 'user', content, source, kind: 'user-message' }));

  /**
   * @typedef {Object} PendingFlag
   * @property {string} command - excerpted command text.
   * @property {number} createdAt
   * @property {boolean} reminded - a notice was already delivered for this call.
   */

  /**
   * Per-agent pending flags: agent → (callId → flag). A WeakMap so agent
   * disposal drops its flags without manual cleanup.
   * @type {WeakMap<object, Map<string, PendingFlag>>}
   */
  const byAgent = new WeakMap();

  /** Sweep flags that are older than the TTL (write-time, map is tiny). */
  function sweep(map) {
    const at = now();
    for (const [key, value] of map) {
      if (at - value.createdAt > PENDING_TTL_MS) map.delete(key);
    }
  }

  /** The agent's flag map, created on demand. */
  function flagsOf(agent) {
    let map = byAgent.get(agent);
    if (map === undefined) {
      map = new Map();
      byAgent.set(agent, map);
    }
    return map;
  }

  /**
   * Layer 1: the pre-execute waterfall listener. Flags a service-looking
   * shell call and always passes through.
   *
   * @param {object} exec - ToolExecution input.
   * @param {() => Promise<object>} next
   * @returns {Promise<object>}
   */
  async function onPreExecute(exec, next) {
    try {
      const agent = exec?.agent;
      if (agent !== undefined && agent !== null && SHELL_TOOLS.includes(exec?.name)) {
        const command = exec?.name === 'bash'
          ? exec?.arguments?.command
          : exec?.arguments?.command;
        const runInBackground = exec?.arguments?.run_in_background === true;
        if ((runInBackground || looksLikeServiceStart(command)) && typeof command === 'string' && command.trim() !== '') {
          const callId = String(exec?.callId ?? '');
          if (callId !== '') {
            const map = flagsOf(agent);
            sweep(map);
            map.set(callId, {
              command: command.slice(0, MAX_COMMAND_CHARS),
              createdAt: now(),
              reminded: false,
            });
          }
        }
      }
    } catch (error) {
      try { log(`agents-manager: service-detect pre-execute failed: ${error instanceof Error ? error.message : String(error)}`); } catch { /* logging is optional */ }
    }
    return next();
  }

  /**
   * Layer 2: the post-execute waterfall listener. When a flagged call
   * settles without a matching report, prepend one notice.
   *
   * @param {object} exec - ToolExecution.
   * @param {object} _result - the frozen result (unused; presence is enough).
   * @param {() => Promise<object>} next
   * @returns {Promise<object>}
   */
  async function onPostExecute(exec, _result, next) {
    let reminder = null;
    try {
      const agent = exec?.agent;
      const callId = String(exec?.callId ?? '');
      if (agent !== undefined && agent !== null && callId !== '' && SHELL_TOOLS.includes(exec?.name)) {
        const map = byAgent.get(agent);
        const flag = map?.get(callId);
        if (flag !== undefined && !flag.reminded) {
          flag.reminded = true;
          reminder = makeMessage(
            [{ type: 'text', text: serviceReportReminderText(flag.command) }],
            { kind: 'agents-manager-process-report', form: 'notice', summary: 'service started; report it' },
          );
        }
      }
    } catch (error) {
      try { log(`agents-manager: service-detect post-execute failed: ${error instanceof Error ? error.message : String(error)}`); } catch { /* logging is optional */ }
    }
    const downstream = await next();
    if (reminder === null) return downstream;
    try {
      if (downstream === null || typeof downstream !== 'object') return downstream;
      if (downstream.kind === 'block') {
        return { ...downstream, additionalContexts: [reminder, ...(downstream.additionalContexts ?? [])] };
      }
      return { ...downstream, additionalContexts: [reminder, ...(downstream.additionalContexts ?? [])] };
    } catch (error) {
      try { log(`agents-manager: service-detect reminder attach failed: ${error instanceof Error ? error.message : String(error)}`); } catch { /* logging is optional */ }
      return downstream;
    }
  }

  /**
   * Consume (clear) the pending flags of one agent — called when
   * `report_service_process` succeeds so the reminder never fires for an
   * already-reported call, and on turn end for cheap hygiene.
   *
   * @param {object} agent
   * @returns {void}
   */
  function consumeAgent(agent) {
    byAgent.delete(agent);
  }

  /**
   * Test hook: read one agent's pending flag map copy.
   *
   * @param {object} agent
   * @returns {Array<{ callId: string, command: string, reminded: boolean }>}
   */
  function snapshot(agent) {
    const map = byAgent.get(agent);
    if (map === undefined) return [];
    return [...map.entries()].map(([callId, flag]) => ({ callId, command: flag.command, reminded: flag.reminded }));
  }

  return { onPreExecute, onPostExecute, consumeAgent, snapshot, looksLikeServiceStart };
}

/**
 * @typedef {Object} DetectApi
 * @property {(exec: object, next: () => Promise<object>) => Promise<object>} onPreExecute
 * @property {(exec: object, result: object, next: () => Promise<object>) => Promise<object>} onPostExecute
 * @property {(agent: object) => void} consumeAgent
 * @property {(agent: object) => Array<{ callId: string, command: string, reminded: boolean }>} snapshot
 * @property {(command: string) => boolean} looksLikeServiceStart
 */
