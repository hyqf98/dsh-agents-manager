/**
 * Per-session service-process registry: what the `report_service_process`
 * callback tool records after the AI starts a local service, and what the
 * composer's floating process panel reads (and stops) through the HTTP API.
 *
 * The store is process-local memory keyed by the ROOT session id — a
 * subagent's report rolls up to its root conversation so the user always
 * sees one panel per visible session. It is deliberately not persisted:
 * process lifetime is runtime state, and after a DSH restart the services
 * may still run while the panel needs a fresh report to re-show them.
 *
 * @module
 */

/** Longest service name accepted. */
const MAX_NAME_CHARS = 80;
/** Longest command/url echo kept per record. */
const MAX_LINE_CHARS = 500;
/** Longest process-output excerpt kept per record (replaced, not appended). */
const MAX_OUTPUT_CHARS = 4000;
/** Longest one-line note kept per record. */
const MAX_MESSAGE_CHARS = 300;
/** Most ports accepted in one report (after dedupe). */
const MAX_PORTS = 8;
/** Most records kept per session; overflow evicts stopped records first. */
const MAX_PER_SESSION = 50;
/** Lifecycle statuses a record may carry. */
const STATUSES = ['running', 'stopped', 'exited', 'failed'];
/** A running record with no pid/jobId flips to exited after this long without a refresh. */
export const STALE_NO_HANDLE_MS = 5 * 60 * 1000;

/** Signal-to-exit grace: poll steps and total budget for `stop`. */
const STOP_STEP_MS = 250;
const STOP_MAX_STEPS = 6;

/**
 * Best-effort session id from an Agent handle across harness revisions
 * (mirrors the host entry's sessionIdOf).
 *
 * @param {object} agent - live Agent handle.
 * @returns {string}
 */
export function sessionIdOfAgent(agent) {
  const candidate = agent?.session?.id ?? agent?.id ?? agent?.sessionId;
  return candidate === undefined || candidate === null ? '' : String(candidate);
}

/**
 * Create the root-session resolver: walk a calling agent's session up the
 * `parentSession` header chain while the sessions classify as subagents, so
 * subagent-reported processes land on the conversation the user sees. The
 * walk stops at the first session that is not a live subagent child; an
 * unresolvable parent falls back to the caller's own session (the record
 * still exists, only its panel attribution degrades) and logs once.
 *
 * @param {object} services
 * @param {() => object | undefined} services.resolveSessions - live `ctx.sessions` getter.
 * @param {(id: string) => string | undefined} [services.parentHintOf] - supplementary child→parent map (subagent/start listener).
 * @param {(message: string) => void} [services.log] - diagnostic sink.
 * @returns {(agent: object) => { rootId: string, callerId: string, subagent: boolean }}
 */
export function createRootResolver(services) {
  const log = services.log ?? (() => {});
  /** @type {Set<string>} */
  const warned = new Set();

  /**
   * Header of a live session, tolerating registry and handle access.
   *
   * @param {string} id
   * @param {object | undefined} session - the caller's own handle for the first hop.
   * @returns {object | undefined}
   */
  function headerOf(id, session) {
    let live = session;
    if (live === undefined) {
      try {
        const sessions = services.resolveSessions();
        if (sessions !== undefined && typeof sessions.get === 'function') live = sessions.get(id);
      } catch { /* registry access is best-effort */ }
    }
    return live?.header;
  }

  return function resolveRoot(agent) {
    const callerId = sessionIdOfAgent(agent);
    if (callerId === '') return { rootId: '', callerId: '', subagent: false };
    let currentId = callerId;
    let currentHeader = headerOf(callerId, agent?.session);
    /** @type {Set<string>} */
    const visited = new Set([callerId]);
    for (let hop = 0; hop < 32; hop += 1) {
      if (currentHeader?.origin !== 'subagent') break;
      const parent = typeof currentHeader.parentSession === 'string' && currentHeader.parentSession !== ''
        ? currentHeader.parentSession
        : services.parentHintOf?.(currentId);
      if (parent === undefined || parent === '' || visited.has(parent)) break;
      const parentHeader = headerOf(parent, undefined);
      if (parentHeader === undefined) {
        // Parent not in the live registry: the chain is unresolvable from
        // here, so the record stays under the deepest session we did see.
        if (!warned.has(currentId)) {
          warned.add(currentId);
          try {
            log(`agents-manager: subagent session ${currentId} has parent ${parent} outside the live registry; process report stays on ${currentId}`);
          } catch { /* logging is optional */ }
        }
        break;
      }
      visited.add(parent);
      currentId = parent;
      currentHeader = parentHeader;
    }
    return { rootId: currentId, callerId, subagent: currentId !== callerId };
  };
}

/**
 * Create the process store.
 *
 * @param {object} [services]
 * @param {(message: string) => void} [services.log] - diagnostic sink.
 * @param {() => number} [services.now] - injectable clock.
 * @param {(pid: number, signal: number | string) => void} [services.kill] - injectable process.kill (throws on error).
 * @param {(ms: number) => Promise<void>} [services.sleep] - injectable wait used by stop's grace window.
 * @param {(jobId: string, ownerSessionId: string, reason: string) => Promise<unknown>} [services.killJob] -
 *   stop a kernel background job by id (the jobs registry's own kill); used by
 *   `stop` when a record carries no pid but a jobId (auto-registered services).
 * @param {(jobId: string, ownerSessionId: string) => boolean} [services.jobAlive] -
 *   liveness probe for a kernel background job, used by `list` to flip dead
 *   auto-registered records out of the panel.
 *   stop a kernel background job by id (the jobs registry's own kill); used by
 *   `stop` when a record carries no pid but a jobId (auto-registered services).
 * @returns {object} store handle.
 */
export function createProcessStore(services = {}) {
  const log = services.log ?? (() => {});
  const now = services.now ?? (() => Date.now());
  const kill = services.kill ?? ((pid, signal) => process.kill(pid, signal));
  const sleep = services.sleep ?? ((ms) => new Promise((resolve) => { setTimeout(resolve, ms); }));
  const killJob = services.killJob;
  const jobAlive = services.jobAlive;

  /** @type {Map<string, Map<string, object>>} root session id → name → record. */
  const bySession = new Map();

  /**
   * The record map of one session, created on demand.
   *
   * @param {string} sessionId
   * @returns {Map<string, object>}
   */
  function sessionMap(sessionId) {
    let map = bySession.get(sessionId);
    if (map === undefined) {
      map = new Map();
      bySession.set(sessionId, map);
    }
    return map;
  }

  /**
   * Normalize and validate one report's ports.
   *
   * @param {object} entry - raw report payload.
   * @returns {{ ok: true, ports: number[] } | { ok: false, error: string }}
   */
  function normalizePorts(entry) {
    const raw = Array.isArray(entry?.ports) ? [...entry.ports, ...(entry?.port === undefined ? [] : [entry.port])] : [entry?.port];
    const ports = [];
    for (const value of raw) {
      if (value === undefined || value === null || value === '') continue;
      const port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: 'bad-port' };
      if (!ports.includes(port)) ports.push(port);
    }
    if (ports.length > MAX_PORTS) return { ok: false, error: 'too-many-ports' };
    return { ok: true, ports };
  }

  /**
   * Record (or update) one service process for a session. The name is the
   * per-session key: a second report with the same name updates the record
   * instead of duplicating it. Fields the report omits inherit their last
   * reported value (a status-only update keeps pid/ports/output); `output`
   * and `message` replace their previous text when supplied.
   *
   * `entry.source === 'auto'` marks a jobs-bridge registration (kernel
   * background-job heuristic): it keeps source 'auto' and never upgrades
   * an existing manual record; the next manual report with the same name
   * takes the record over.
   *
   * @param {string} sessionId - root session id the panel shows.
   * @param {string} callerSessionId - session id of the reporting agent ('' for the auto bridge).
   * @param {object} entry - raw tool payload.
   * @returns {Promise<{ ok: boolean, error?: string, record?: object, created?: boolean }>}
   */
  async function record(sessionId, callerSessionId, entry) {
    if (sessionId === undefined || sessionId === null || String(sessionId) === '') return { ok: false, error: 'bad-session' };
    const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
    if (name === '' || name.length > MAX_NAME_CHARS) return { ok: false, error: 'bad-name' };
    const ports = normalizePorts(entry);
    if (!ports.ok) return { ok: false, error: ports.error };
    const map = sessionMap(String(sessionId));
    const previous = map.get(name);

    let pid = entry?.pid !== undefined && entry?.pid !== null ? Number(entry.pid) : previous?.pid;
    if (pid !== undefined) {
      if (!Number.isInteger(pid) || pid < 1) return { ok: false, error: 'bad-pid' };
    }
    // A kernel background-job id: the auto bridge supplies it so the panel can
    // stop the service through the jobs registry even without a pid. Oversized
    // or blank values are dropped rather than truncated (a truncated id could
    // never address the real job).
    let jobId = typeof entry?.jobId === 'string' ? entry.jobId.trim() : previous?.jobId;
    if (jobId !== undefined && (jobId === '' || jobId.length > 64)) jobId = undefined;
    const status = entry?.status === undefined || entry?.status === null || entry?.status === ''
      ? (previous?.status ?? 'running')
      : String(entry.status);
    if (!STATUSES.includes(status)) return { ok: false, error: 'bad-status' };
    const text = (value, cap) => (typeof value === 'string' ? value.slice(0, cap) : '');
    const supplied = (value, cap, previousValue) => {
      const next = text(value, cap);
      return next === '' ? (previousValue ?? '') : next;
    };

    const next = {
      name,
      ports: ports.ports.length > 0 ? ports.ports : (previous?.ports ?? []),
      ...(supplied(entry?.url, MAX_LINE_CHARS, previous?.url) === '' ? {} : { url: supplied(entry?.url, MAX_LINE_CHARS, previous?.url) }),
      ...(supplied(entry?.command, MAX_LINE_CHARS, previous?.command) === '' ? {} : { command: supplied(entry?.command, MAX_LINE_CHARS, previous?.command) }),
      ...(supplied(entry?.output, MAX_OUTPUT_CHARS, previous?.output) === '' ? {} : { output: supplied(entry?.output, MAX_OUTPUT_CHARS, previous?.output) }),
      ...(supplied(entry?.message, MAX_MESSAGE_CHARS, previous?.message) === '' ? {} : { message: supplied(entry?.message, MAX_MESSAGE_CHARS, previous?.message) }),
      status,
      startedAt: previous?.startedAt ?? now(),
      updatedAt: now(),
      // A manual report takes over an auto-registered record (same name key):
      // the jobs bridge passes source:'auto' for its own registrations, and
      // an auto UPDATE of an existing manual record keeps that record's
      // manual origin (only a manual report re-labels it).
      source: entry?.source === 'auto' && previous === undefined ? 'auto'
        : entry?.source === 'auto' ? (previous?.source ?? 'auto')
          : callerSessionId !== '' && callerSessionId !== String(sessionId) ? 'subagent' : 'main',
    };
    if (pid !== undefined) next.pid = pid;
    if (jobId !== undefined) next.jobId = jobId;
    if (previous === undefined && map.size >= MAX_PER_SESSION) {
      // Evict the oldest stopped record first; a panel full of running
      // services falls back to plain FIFO.
      let victim = null;
      for (const [key, value] of map) {
        if (value.status !== 'running') { victim = key; break; }
        if (victim === null) victim = key;
      }
      if (victim !== null) {
        map.delete(victim);
        try { log(`agents-manager: process registry full for session; evicted "${victim}"`); } catch { /* logging is optional */ }
      }
    }
    map.set(name, next);
    return { ok: true, record: next, created: previous === undefined };
  }

  /**
   * One session's records, freshest liveness first: a `running` record with
   * a dead pid flips to `exited` here (signal 0 probes without touching the
   * process; EPERM means alive but not ours to probe and stays as-is).
   *
   * Records with a jobId probe the jobs registry instead (the auto-registered
   * background services); records with neither handle cannot be probed, so a
   * running one older than STALE_NO_HANDLE_MS flips to `exited` instead of
   * haunting the panel forever.
   *
   * @param {string} sessionId
   * @returns {Array<object>}
   */
  function list(sessionId) {
    const map = bySession.get(String(sessionId ?? ''));
    if (map === undefined) return [];
    for (const item of map.values()) {
      if (item.status !== 'running') continue;
      if (item.pid !== undefined) {
        try {
          kill(item.pid, 0);
        } catch (error) {
          if (error instanceof Error || typeof error === 'object') {
            const code = error?.code;
            if (code === 'ESRCH') {
              item.status = 'exited';
              item.updatedAt = now();
            }
            // EPERM and anything else: keep the last known status.
          } else {
            throw error;
          }
        }
        continue;
      }
      if (item.jobId !== undefined && jobAlive !== undefined) {
        try {
          if (!jobAlive(item.jobId, String(sessionId ?? ''))) {
            item.status = 'exited';
            item.message = 'background job is no longer running';
            item.updatedAt = now();
          }
        } catch { /* the registry's word is unavailable: keep the last status */ }
        continue;
      }
      // No live handle at all: a stale running report ages out of the panel.
      if (now() - item.updatedAt > STALE_NO_HANDLE_MS) {
        item.status = 'exited';
        item.message = 'stale: no pid/jobId reported, last refresh timed out';
        item.updatedAt = now();
      }
    }
    return [...map.values()].sort((a, b) => a.startedAt - b.startedAt);
  }

  /**
   * Stop one recorded process. With a pid: SIGTERM, a short grace window,
   * then SIGKILL. Without a pid but with a jobId (auto-registered services):
   * the jobs registry's own kill, which needs the owning root session id.
   * The registry never kills by port or name matching; a record with neither
   * handle reports `no-pid`.
   *
   * @param {string} sessionId
   * @param {string} name
   * @returns {Promise<{ ok: boolean, error?: string, detail?: string, record?: object }>}
   */
  async function stop(sessionId, name) {
    const map = bySession.get(String(sessionId ?? ''));
    const item = map?.get(typeof name === 'string' ? name.trim() : '');
    if (item === undefined) return { ok: false, error: 'not-found' };
    if (item.pid === undefined) {
      if (item.jobId === undefined || killJob === undefined) return { ok: false, error: 'no-pid' };
      try {
        await killJob(item.jobId, String(sessionId ?? ''), 'process panel stop');
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return { ok: false, error: 'kill-failed', detail };
      }
      item.status = 'stopped';
      item.updatedAt = now();
      return { ok: true, record: item };
    }
    try {
      kill(item.pid, 'SIGTERM');
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { ok: false, error: 'kill-failed', detail };
    }
    let exited = false;
    for (let step = 0; step < STOP_MAX_STEPS && !exited; step += 1) {
      await sleep(STOP_STEP_MS);
      try {
        kill(item.pid, 0);
      } catch (error) {
        if (error?.code === 'ESRCH') exited = true;
      }
    }
    if (!exited) {
      try {
        kill(item.pid, 'SIGKILL');
        exited = true;
      } catch (error) {
        if (error?.code === 'ESRCH') exited = true;
        else {
          const detail = error instanceof Error ? error.message : String(error);
          return { ok: false, error: 'kill-failed', detail };
        }
      }
    }
    item.status = 'stopped';
    item.updatedAt = now();
    return { ok: true, record: item };
  }

  /** Drop all in-memory records; never signals any process. */
  function dispose() {
    bySession.clear();
  }

  return { record, list, stop, dispose };
}
