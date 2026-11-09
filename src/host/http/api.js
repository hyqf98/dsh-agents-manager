/**
 * The single HTTP API the browser half talks to: one prefix route under
 * `/agents-manager/api/v1` serving JSON for MCP config management, testing,
 * skill editing, session selection, the session process panel, and
 * delegation-role management.
 *
 * Every response is `{ ok: true, ... }` or `{ ok: false, error, message? }`;
 * handler exceptions are contained as 500 JSON so the UI always gets a
 * parseable body.
 *
 * @module
 */
import { normalizeServer, parsePasted, NAME_PATTERN } from '../mcp/config.js';
import { normalizeRole, normalizePoolModel, sanitizeRoleName } from '../subagents/store.js';
import { builtinStates, builtinTombstone, isBuiltinRoleName } from '../subagents/builtin.js';
import { normalizeRule, testRule, DEFAULT_MAX_WAIT_MS } from '../retry/rules.js';
import { validateRetryPolicy } from '../retry/manager.js';
import { RETRY_PRESETS } from '../retry/presets.js';

/** Prefix the host entry mounts this handler under. */
export const API_BASE = '/agents-manager/api/v1';
/** Largest JSON request body accepted, in bytes. */
export const MAX_BODY_BYTES = 512 * 1024;

/**
 * Build the route handler around its collaborators so tests drive stubs.
 *
 * The capabilities services (store / supervisor / skillsRoot / skillsStore /
 * selectionStore / listSkills / detectAgentSources / installSkillFromGithub)
 * arrive through the capabilities feature row's apiServices(); without that
 * row the mcp/skills/selection routes answer 501 and /state degrades to its
 * capabilities-empty shape. The subagents and retry services likewise ride
 * their own rows.
 *
 * @param {object} services
 * @param {object} [services.store] - MCP server store (capabilities row).
 * @param {object} [services.supervisor] - MCP supervisor handle (capabilities row).
 * @param {string} [services.skillsRoot] - absolute ~/.agents/skills path (capabilities row).
 * @param {object} [services.skillsStoreModule] - skills-store module (capabilities row).
 * @param {object} [services.selectionStore] - session selection store (capabilities row).
 * @param {() => Promise<Array<object>>} [services.listSkills] - skill listing (capabilities row).
 * @param {(sessionId: string) => void} [services.onSelectionChanged] - hook for live agent re-sync.
 * @param {() => Promise<Array<object>>} [services.detectAgentSources] - one-click sync scanner.
 * @param {(source: string) => Promise<object>} [services.installSkillFromGithub] - GitHub skill installer.
 * @param {object} [services.subagentsStore] - delegation-role store.
 * @param {() => void} [services.onSubagentsChanged] - hook for live agent re-sync after role writes.
 * @param {() => Promise<Array<object>>} [services.listLlmCatalog] - registered LLM providers and models for pickers.
 * @param {(sessionId: string) => boolean} [services.sessionFresh] - whether a Session still has no live turns.
 * @param {object} [services.processStore] - per-session service-process registry.
 * @param {object} [services.retryStore] - retry-rules store.
 * @param {() => { active: Array<object>, recent: Array<object> }} [services.retryMonitor] - monitor snapshot.
 * @param {() => Promise<Array<object>>} [services.listRetryTargets] - provider policy targets.
 * @param {(provider: string, policy: object) => Promise<{ ok: boolean, error?: string, code?: string }>} [services.writeRetryPolicy]
 * @param {(provider: string) => Promise<{ ok: boolean, error?: string, code?: string }>} [services.resetRetryPolicy]
 * @param {() => number} [services.retryNow] - injectable clock for rule testing.
 * @returns {(req: object, res: object) => Promise<void>} the mounted handler.
 */
export function createHandler(services) {
  const {
    skillsStoreModule: skillsStore,
    onSelectionChanged,
    listLlmCatalog,
    sessionFresh,
    processStore,
    features,
  } = services;

  /**
   * Per-builtin state (`default` / `customized` / `hidden`) computed from the
   * raw user records. Falls back to the merged listing for store doubles
   * without `listUserRoles` (their listings equal their user records).
   */
  async function builtinSnapshot() {
    const subagentsStore = services.subagentsStore;
    if (subagentsStore === undefined) return {};
    const raw = typeof subagentsStore.listUserRoles === 'function'
      ? await subagentsStore.listUserRoles()
      : await subagentsStore.listRoles();
    return builtinStates(raw);
  }

  /** 501 guard: routes below need the capabilities row's services. */
  function capabilitiesUnavailable(res) {
    if (services.store !== undefined) return false;
    sendJson(res, 501, { ok: false, error: 'not-supported' });
    return true;
  }

  /** 501 guard: routes below need the subagents row's store. */
  function subagentsUnavailable(res) {
    if (services.subagentsStore !== undefined) return false;
    sendJson(res, 501, { ok: false, error: 'not-supported' });
    return true;
  }

  /** Write one JSON response. */
  function sendJson(res, status, body) {
    const text = JSON.stringify(body);
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('content-length', Buffer.byteLength(text));
    res.end(text);
  }

  /** Read one JSON body, null for empty/oversized/malformed. */
  function readJsonBody(req) {
    return new Promise((resolve) => {
      const chunks = [];
      let total = 0;
      req.on('data', (chunk) => {
        total += chunk.length;
        if (total <= MAX_BODY_BYTES) chunks.push(chunk);
      });
      req.on('end', () => {
        if (chunks.length === 0) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          resolve(null);
        }
      });
      req.on('error', () => resolve(null));
    });
  }

  /** A JSON object body, or null when the request carried something else. */
  function objectBody(body) {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
    return body;
  }

  /**
   * Answer GET /state: store servers, live pool, skills, store metadata,
   * and the feature rows currently loaded (the client hides each disabled
   * feature's UI: settings pages, chip, tab). Without the capabilities row
   * the capabilities fields answer their empty shape so the shared route
   * still parses for the other features' pages.
   *
   * @param {object} res
   */
  async function stateResponse(res) {
    if (services.store === undefined) {
      sendJson(res, 200, {
        ok: true,
        servers: {},
        pool: {},
        skills: [],
        features: typeof features === 'function' ? features() : ['capabilities', 'subagents', 'retry', 'processes'],
        store: { agentsFile: { exists: false, count: 0, error: 'not-supported' } },
        defaults: { mcp: null, skills: null },
      });
      return;
    }
    const servers = await services.store.listServers();
    const agentsFile = await services.store.readAgentsFile();
    let skills = [];
    try {
      skills = await services.listSkills();
    } catch { /* skills listing is advisory */ }
    sendJson(res, 200, {
      ok: true,
      servers,
      pool: services.supervisor.status(),
      skills,
      features: typeof features === 'function' ? features() : ['capabilities', 'subagents', 'retry', 'processes'],
      store: {
        ...services.store.storeInfo(),
        agentsFile: { exists: agentsFile.exists, count: agentsFile.count, error: agentsFile.error },
      },
      defaults: { mcp: null, skills: null },
    });
  }

  /**
   * Persist nothing (helpers below own writes); re-sync the pool to the
   * current store and answer with the refreshed state.
   *
   * @param {object} res
   */
  async function saveAndSync(res) {
    await services.supervisor.sync(await services.store.listServers());
    await stateResponse(res);
  }

  /**
   * Route dispatch for every request under API_BASE.
   *
   * @param {object} req
   * @param {object} res
   */
  async function handle(req, res) {
    const method = String(req.method ?? 'GET').toUpperCase();
    const pathname = new URL(String(req.url ?? '/'), 'http://localhost').pathname;
    const route = pathname.slice(API_BASE.length).replace(/\/+$/, '') || '/';

    if (route === '/state' && method === 'GET') {
      await stateResponse(res);
      return;
    }

    if (route === '/mcp/agents-file' && method === 'GET') {
      if (capabilitiesUnavailable(res)) return;
      const result = await services.store.agentsFileEntries();
      if (!result.ok) {
        sendJson(res, result.error === 'missing' ? 404 : 400, { ok: false, error: result.error });
        return;
      }
      sendJson(res, 200, { ok: true, entries: result.entries });
      return;
    }

    if (route === '/mcp/agent-sources' && method === 'GET') {
      if (services.detectAgentSources === undefined) {
        sendJson(res, 501, { ok: false, error: 'not-supported' });
        return;
      }
      const sources = await services.detectAgentSources();
      sendJson(res, 200, { ok: true, sources });
      return;
    }

    if (route === '/mcp/import' && method === 'POST') {
      if (capabilitiesUnavailable(res)) return;
      const body = objectBody(await readJsonBody(req));
      if (body === null) {
        sendJson(res, 400, { ok: false, error: 'bad-body' });
        return;
      }
      if (typeof body.text !== 'string' || body.text.trim() === '') {
        sendJson(res, 400, { ok: false, error: 'empty-text' });
        return;
      }
      const parsed = parsePasted(body.text);
      if (!parsed.ok) {
        sendJson(res, 400, { ok: false, error: 'bad-json', message: parsed.error });
        return;
      }
      const known = await services.store.listServers();
      let entries = parsed.entries.map((entry) => ({
        name: entry.name,
        server: entry.server,
        issue: entry.issue ?? (known[entry.name] !== undefined ? 'name-exists' : null),
        test: null,
      }));
      if (body.test === true) {
        entries = await Promise.all(entries.map(async (entry) => {
          if (entry.issue !== null && entry.issue !== 'name-exists') return entry;
          const result = await services.supervisor.testOne(entry.name, entry.server);
          return { ...entry, test: result.ok ? { ok: true, toolCount: result.tools.length } : { ok: false, error: result.error } };
        }));
      }
      sendJson(res, 200, { ok: true, entries });
      return;
    }

    if (route === '/mcp/import/commit' && method === 'POST') {
      if (capabilitiesUnavailable(res)) return;
      const body = objectBody(await readJsonBody(req));
      if (body === null || !Array.isArray(body.entries)) {
        sendJson(res, 400, { ok: false, error: 'bad-body' });
        return;
      }
      let accepted = 0;
      for (const raw of body.entries) {
        if (raw === null || typeof raw !== 'object') continue;
        const item = /** @type {{ name?: unknown, server?: unknown }} */ (raw);
        if (typeof item.name !== 'string' || !NAME_PATTERN.test(item.name)) continue;
        const normalized = normalizeServer(item.server);
        if (!normalized.ok) continue;
        const stored = await services.store.putServer(item.name, normalized.server);
        if (stored.ok) accepted += 1;
      }
      if (accepted === 0) {
        sendJson(res, 400, { ok: false, error: 'nothing-selected' });
        return;
      }
      await saveAndSync(res);
      return;
    }

    if (route === '/mcp/save' && method === 'POST') {
      if (capabilitiesUnavailable(res)) return;
      const body = objectBody(await readJsonBody(req));
      if (body === null || typeof body.name !== 'string' || !NAME_PATTERN.test(body.name)) {
        sendJson(res, 400, { ok: false, error: 'bad-name' });
        return;
      }
      const normalized = normalizeServer(body.server);
      if (!normalized.ok) {
        sendJson(res, 400, { ok: false, error: normalized.error });
        return;
      }
      const stored = await services.store.putServer(body.name, normalized.server);
      if (!stored.ok) {
        sendJson(res, 500, { ok: false, error: 'write-failed', message: stored.error });
        return;
      }
      await saveAndSync(res);
      return;
    }

    if (route === '/mcp/delete' && method === 'POST') {
      if (capabilitiesUnavailable(res)) return;
      const body = objectBody(await readJsonBody(req));
      if (body === null || typeof body.name !== 'string') {
        sendJson(res, 400, { ok: false, error: 'bad-body' });
        return;
      }
      const known = await services.store.listServers();
      if (known[body.name] === undefined) {
        sendJson(res, 404, { ok: false, error: 'not-found' });
        return;
      }
      const removed = await services.store.removeServer(body.name);
      if (!removed.ok) {
        sendJson(res, 500, { ok: false, error: 'remove-failed', message: removed.error });
        return;
      }
      await saveAndSync(res);
      return;
    }

    if (route === '/mcp/toggle' && method === 'POST') {
      if (capabilitiesUnavailable(res)) return;
      const body = objectBody(await readJsonBody(req));
      if (body === null || typeof body.name !== 'string' || typeof body.enabled !== 'boolean') {
        sendJson(res, 400, { ok: false, error: 'bad-body' });
        return;
      }
      const servers = await services.store.listServers();
      if (servers[body.name] === undefined) {
        sendJson(res, 404, { ok: false, error: 'not-found' });
        return;
      }
      const stored = await services.store.putServer(body.name, { ...servers[body.name], enabled: body.enabled });
      if (!stored.ok) {
        sendJson(res, 500, { ok: false, error: 'write-failed', message: stored.error });
        return;
      }
      // Answer immediately with the persisted config; the pool sync (a slow
      // stdio connect can take up to ~20s) runs in the background. The
      // settings page's 5s poll renders each card's live
      // connecting/connected state, and sync() itself re-registers tools
      // through onChange when connections settle.
      void services.supervisor.sync(await services.store.listServers()).catch(() => { /* pool errors surface via /state */ });
      await stateResponse(res);
      return;
    }

    if (route === '/mcp/test' && method === 'POST') {
      if (capabilitiesUnavailable(res)) return;
      const body = objectBody(await readJsonBody(req));
      const servers = await services.store.listServers();
      if (body !== null && typeof body.name === 'string') {
        const server = servers[body.name];
        if (server === undefined) {
          sendJson(res, 404, { ok: false, error: 'not-found' });
          return;
        }
        const result = await services.supervisor.testOne(body.name, server);
        // Remember the outcome for every /state reader (settings card dot,
        // session chip), then reconcile the pool so a test doubles as the
        // user's "reconnect this server" gesture.
        if (typeof services.supervisor.recordTest === 'function') services.supervisor.recordTest(body.name, result);
        await services.supervisor.sync(servers);
        sendJson(res, 200, { ok: true, results: { [body.name]: result } });
        return;
      }
      /** @type {Record<string, object>} */
      const results = {};
      await Promise.all(Object.entries(servers).map(async ([name, server]) => {
        results[name] = server.enabled === false ? { ok: false, error: 'disabled' } : await services.supervisor.testOne(name, server);
      }));
      if (typeof services.supervisor.recordTest === 'function') {
        for (const [name, result] of Object.entries(results)) {
          // "disabled" placeholders are not real probes; skip them.
          if (servers[name].enabled !== false) services.supervisor.recordTest(name, result);
        }
      }
      await services.supervisor.sync(servers);
      sendJson(res, 200, { ok: true, results });
      return;
    }

    if (route === '/mcp/call' && method === 'POST') {
      if (capabilitiesUnavailable(res)) return;
      const body = objectBody(await readJsonBody(req));
      if (body === null || typeof body.name !== 'string' || typeof body.tool !== 'string' || body.tool === '') {
        sendJson(res, 400, { ok: false, error: 'bad-body' });
        return;
      }
      const servers = await services.store.listServers();
      const server = servers[body.name];
      if (server === undefined) {
        sendJson(res, 404, { ok: false, error: 'not-found' });
        return;
      }
      if (typeof services.supervisor.call !== 'function') {
        sendJson(res, 501, { ok: false, error: 'not-supported' });
        return;
      }
      const args = body.args !== undefined && body.args !== null && typeof body.args === 'object' && !Array.isArray(body.args)
        ? body.args
        : {};
      const timeoutMs = Number.isInteger(server.toolCallTimeoutMs) ? server.toolCallTimeoutMs : 60000;
      try {
        const result = await services.supervisor.call(body.name, body.tool, args, AbortSignal.timeout(timeoutMs));
        sendJson(res, 200, { ok: true, result });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: 'call-failed', message: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (route === '/skills/install-github' && method === 'POST') {
      if (capabilitiesUnavailable(res)) return;
      const body = objectBody(await readJsonBody(req));
      if (body === null || typeof body.source !== 'string' || body.source.trim() === '') {
        sendJson(res, 400, { ok: false, error: 'bad-body' });
        return;
      }
      if (services.installSkillFromGithub === undefined) {
        sendJson(res, 501, { ok: false, error: 'not-supported' });
        return;
      }
      const result = await services.installSkillFromGithub(body.source.trim());
      if (!result.ok) {
        const status = result.error === 'not-found' || result.error === 'bad-shape' || result.error === 'empty' ? 400 : 502;
        sendJson(res, status, { ok: false, error: result.error, message: result.message });
        return;
      }
      sendJson(res, 200, { ok: true, installed: result.installed, skipped: result.skipped });
      return;
    }

    if (route === '/skills/list' && method === 'GET') {
      if (capabilitiesUnavailable(res)) return;
      const skills = await services.listSkills();
      sendJson(res, 200, { ok: true, skills });
      return;
    }

    if (route === '/skills/files' && method === 'POST') {
      if (capabilitiesUnavailable(res)) return;
      const body = objectBody(await readJsonBody(req));
      if (body === null || typeof body.skill !== 'string') {
        sendJson(res, 400, { ok: false, error: 'bad-body' });
        return;
      }
      const files = await skillsStore.listSkillFiles(`${services.skillsRoot}/${body.skill}`);
      sendJson(res, 200, { ok: true, files });
      return;
    }

    if (route === '/skills/file/read' && method === 'POST') {
      if (capabilitiesUnavailable(res)) return;
      const body = objectBody(await readJsonBody(req));
      if (body === null || typeof body.skill !== 'string' || typeof body.path !== 'string') {
        sendJson(res, 400, { ok: false, error: 'bad-body' });
        return;
      }
      const result = await skillsStore.readSkillFile(services.skillsRoot, body.skill, body.path);
      if (!result.ok) {
        sendJson(res, result.error === 'not-found' ? 404 : 400, { ok: false, error: result.error });
        return;
      }
      sendJson(res, 200, { ok: true, file: result.file });
      return;
    }

    if (route === '/skills/file/write' && method === 'POST') {
      if (capabilitiesUnavailable(res)) return;
      const body = objectBody(await readJsonBody(req));
      if (body === null || typeof body.skill !== 'string' || typeof body.path !== 'string' || typeof body.content !== 'string') {
        sendJson(res, 400, { ok: false, error: 'bad-body' });
        return;
      }
      const baseSha = typeof body.sha === 'string' ? body.sha : null;
      const result = await skillsStore.writeSkillFile(services.skillsRoot, body.skill, body.path, body.content, baseSha);
      if (!result.ok) {
        const status = result.error === 'conflict' ? 409 : result.error === 'not-found' ? 404 : 400;
        sendJson(res, status, { ok: false, error: result.error });
        return;
      }
      sendJson(res, 200, { ok: true, sha: result.sha });
      return;
    }

    if (route === '/session/fresh' && method === 'GET') {
      const url = new URL(String(req.url ?? '/'), 'http://localhost');
      const id = url.searchParams.get('id');
      if (id === null || id === '') {
        sendJson(res, 400, { ok: false, error: 'bad-id' });
        return;
      }
      if (sessionFresh === undefined) {
        sendJson(res, 501, { ok: false, error: 'not-supported' });
        return;
      }
      sendJson(res, 200, { ok: true, fresh: sessionFresh(id) === true });
      return;
    }

    if (route === '/session/selection' && method === 'GET') {
      if (capabilitiesUnavailable(res)) return;
      const url = new URL(String(req.url ?? '/'), 'http://localhost');
      const id = url.searchParams.get('id');
      if (id === null || id === '') {
        sendJson(res, 400, { ok: false, error: 'bad-id' });
        return;
      }
      sendJson(res, 200, { ok: true, selection: services.selectionStore.get(id) });
      return;
    }

    if (route === '/session/selection' && method === 'POST') {
      if (capabilitiesUnavailable(res)) return;
      const body = objectBody(await readJsonBody(req));
      if (body === null || typeof body.sessionId !== 'string' || body.sessionId === '') {
        sendJson(res, 400, { ok: false, error: 'bad-body' });
        return;
      }
      services.selectionStore.set(body.sessionId, { mcp: body.mcp, skills: body.skills });
      if (onSelectionChanged !== undefined) {
        try {
          onSelectionChanged(body.sessionId);
        } catch { /* re-sync hook is best-effort */ }
      }
      sendJson(res, 200, { ok: true, selection: services.selectionStore.get(body.sessionId) });
      return;
    }

    if (route === '/session/processes' && method === 'GET') {
      const url = new URL(String(req.url ?? '/'), 'http://localhost');
      const id = url.searchParams.get('id');
      if (id === null || id === '') {
        sendJson(res, 400, { ok: false, error: 'bad-id' });
        return;
      }
      if (processStore === undefined) {
        sendJson(res, 501, { ok: false, error: 'not-supported' });
        return;
      }
      sendJson(res, 200, { ok: true, processes: processStore.list(id) });
      return;
    }

    if (route === '/session/processes/stop' && method === 'POST') {
      const body = objectBody(await readJsonBody(req));
      if (body === null || typeof body.sessionId !== 'string' || body.sessionId === ''
        || typeof body.name !== 'string' || body.name === '') {
        sendJson(res, 400, { ok: false, error: 'bad-body' });
        return;
      }
      if (processStore === undefined) {
        sendJson(res, 501, { ok: false, error: 'not-supported' });
        return;
      }
      const result = await processStore.stop(body.sessionId, body.name);
      if (!result.ok) {
        const status = result.error === 'not-found' ? 404 : result.error === 'no-pid' ? 409 : 500;
        sendJson(res, status, { ok: false, error: result.error, ...(result.detail === undefined ? {} : { detail: result.detail }) });
        return;
      }
      sendJson(res, 200, { ok: true, process: result.record });
      return;
    }

    if (route === '/subagents' && method === 'GET') {
      if (subagentsUnavailable(res)) return;
      const subagentsStore = services.subagentsStore;
      const roles = await subagentsStore.listRoles();
      const models = typeof subagentsStore.listPoolModels === 'function' ? await subagentsStore.listPoolModels() : [];
      sendJson(res, 200, { ok: true, roles, models, builtin: await builtinSnapshot(), store: subagentsStore.storeInfo() });
      return;
    }

    if (route === '/subagents/models/save' && method === 'POST') {
      if (subagentsUnavailable(res)) return;
      const subagentsStore = services.subagentsStore;
      const body = objectBody(await readJsonBody(req));
      if (body === null || typeof body.entry !== 'object' || body.entry === null) {
        sendJson(res, 400, { ok: false, error: 'bad-body' });
        return;
      }
      const normalized = normalizePoolModel(body.entry);
      if (!normalized.ok) {
        sendJson(res, 400, { ok: false, error: normalized.error });
        return;
      }
      const key = `${normalized.entry.provider}/${normalized.entry.model}`;
      const stored = await subagentsStore.putPoolModel(key, normalized.entry);
      if (!stored.ok) {
        sendJson(res, 500, { ok: false, error: 'write-failed', message: stored.error });
        return;
      }
      if (services.onSubagentsChanged !== undefined) {
        try {
          services.onSubagentsChanged();
        } catch { /* re-sync hook is best-effort */ }
      }
      sendJson(res, 200, { ok: true, key, models: await subagentsStore.listPoolModels() });
      return;
    }

    if (route === '/subagents/models/bulk' && method === 'POST') {
      if (subagentsUnavailable(res)) return;
      const subagentsStore = services.subagentsStore;
      const body = objectBody(await readJsonBody(req));
      if (body === null || !Array.isArray(body.entries)) {
        sendJson(res, 400, { ok: false, error: 'bad-body' });
        return;
      }
      const existing = new Set((await subagentsStore.listPoolModels())
        .map((entry) => `${entry.provider}/${entry.model}`));
      /** @type {Array<object>} */
      const imported = [];
      /** @type {Array<string>} */
      const skipped = [];
      for (const raw of body.entries) {
        const normalized = normalizePoolModel(raw);
        if (!normalized.ok) continue;
        const key = `${normalized.entry.provider}/${normalized.entry.model}`;
        if (existing.has(key)) { skipped.push(key); continue; }
        const stored = await subagentsStore.putPoolModel(key, normalized.entry);
        if (stored.ok) { existing.add(key); imported.push(normalized.entry); }
      }
      if (services.onSubagentsChanged !== undefined) {
        try {
          services.onSubagentsChanged();
        } catch { /* re-sync hook is best-effort */ }
      }
      sendJson(res, 200, { ok: true, imported, skipped, models: await subagentsStore.listPoolModels() });
      return;
    }

    if (route === '/subagents/models/delete' && method === 'POST') {
      if (subagentsUnavailable(res)) return;
      const subagentsStore = services.subagentsStore;
      const body = objectBody(await readJsonBody(req));
      if (body === null || typeof body.key !== 'string' || body.key === '') {
        sendJson(res, 400, { ok: false, error: 'bad-body' });
        return;
      }
      const removed = await subagentsStore.removePoolModel(body.key);
      if (!removed.ok) {
        sendJson(res, removed.error === 'not-found' ? 404 : 500, { ok: false, error: removed.error });
        return;
      }
      if (services.onSubagentsChanged !== undefined) {
        try {
          services.onSubagentsChanged();
        } catch { /* re-sync hook is best-effort */ }
      }
      sendJson(res, 200, { ok: true, models: await subagentsStore.listPoolModels() });
      return;
    }

    if (route === '/subagents/save' && method === 'POST') {
      if (subagentsUnavailable(res)) return;
      const subagentsStore = services.subagentsStore;
      const body = objectBody(await readJsonBody(req));
      if (body === null || typeof body.name !== 'string') {
        sendJson(res, 400, { ok: false, error: 'bad-body' });
        return;
      }
      const name = sanitizeRoleName(body.name);
      if (name === '') {
        sendJson(res, 400, { ok: false, error: 'bad-name' });
        return;
      }
      // Saving under a builtin's name customizes that builtin; those ship no
      // model candidates (the child inherits the calling session's model), so
      // an empty candidate list is accepted for them alone.
      const normalized = normalizeRole(body.role, { allowEmptyModels: isBuiltinRoleName(name) });
      if (!normalized.ok) {
        sendJson(res, 400, { ok: false, error: normalized.error });
        return;
      }
      const stored = await subagentsStore.putRole(name, normalized.role);
      if (!stored.ok) {
        sendJson(res, 500, { ok: false, error: 'write-failed', message: stored.error });
        return;
      }
      if (services.onSubagentsChanged !== undefined) {
        try {
          services.onSubagentsChanged();
        } catch { /* re-sync hook is best-effort */ }
      }
      sendJson(res, 200, { ok: true, name, roles: await subagentsStore.listRoles(), store: subagentsStore.storeInfo() });
      return;
    }

    if (route === '/subagents/delete' && method === 'POST') {
      if (subagentsUnavailable(res)) return;
      const subagentsStore = services.subagentsStore;
      const body = objectBody(await readJsonBody(req));
      if (body === null || typeof body.name !== 'string' || body.name === '') {
        sendJson(res, 400, { ok: false, error: 'bad-body' });
        return;
      }
      // Deleting a builtin writes a tombstone (hide) instead of removing a
      // user record; /subagents/restore drops whatever is stored and the
      // builtin returns with its shipped definition.
      if (isBuiltinRoleName(body.name)) {
        const tombstone = builtinTombstone(body.name);
        const stored = await subagentsStore.putRole(body.name, tombstone);
        if (!stored.ok) {
          sendJson(res, 500, { ok: false, error: 'write-failed', message: stored.error });
          return;
        }
      } else {
        const removed = await subagentsStore.removeRole(body.name);
        if (!removed.ok) {
          sendJson(res, removed.error === 'not-found' ? 404 : 500, { ok: false, error: removed.error });
          return;
        }
      }
      if (services.onSubagentsChanged !== undefined) {
        try {
          services.onSubagentsChanged();
        } catch { /* re-sync hook is best-effort */ }
      }
      sendJson(res, 200, { ok: true, roles: await subagentsStore.listRoles(), builtin: await builtinSnapshot(), store: subagentsStore.storeInfo() });
      return;
    }

    if (route === '/subagents/restore' && method === 'POST') {
      if (subagentsUnavailable(res)) return;
      const subagentsStore = services.subagentsStore;
      const body = objectBody(await readJsonBody(req));
      if (body === null || typeof body.name !== 'string' || body.name === '') {
        sendJson(res, 400, { ok: false, error: 'bad-body' });
        return;
      }
      if (!isBuiltinRoleName(body.name)) {
        sendJson(res, 400, { ok: false, error: 'not-builtin' });
        return;
      }
      // Dropping the stored record (tombstone or customization) brings the
      // builtin back with its shipped definition; nothing stored is a no-op.
      const removed = await subagentsStore.removeRole(body.name);
      if (!removed.ok && removed.error !== 'not-found') {
        sendJson(res, 500, { ok: false, error: removed.error });
        return;
      }
      if (services.onSubagentsChanged !== undefined) {
        try {
          services.onSubagentsChanged();
        } catch { /* re-sync hook is best-effort */ }
      }
      sendJson(res, 200, { ok: true, roles: await subagentsStore.listRoles(), builtin: await builtinSnapshot(), store: subagentsStore.storeInfo() });
      return;
    }

    if (route === '/subagents/catalog' && method === 'GET') {
      if (listLlmCatalog === undefined) {
        sendJson(res, 501, { ok: false, error: 'not-supported' });
        return;
      }
      sendJson(res, 200, { ok: true, providers: await listLlmCatalog() });
      return;
    }

    if (route === '/retry/state' && method === 'GET') {
      if (services.retryStore === undefined || services.retryMonitor === undefined) {
        sendJson(res, 501, { ok: false, error: 'not-supported' });
        return;
      }
      const targets = services.listRetryTargets === undefined
        ? []
        : await services.listRetryTargets().catch(() => []);
      const doc = await services.retryStore.readDocument();
      const monitor = services.retryMonitor();
      sendJson(res, 200, {
        ok: true,
        targets,
        rules: doc.rules,
        fallback: { maxDelayMs: doc.fallback?.maxDelayMs ?? DEFAULT_MAX_WAIT_MS },
        monitor,
        store: services.retryStore.storeInfo(),
        presets: RETRY_PRESETS,
        limits: { minWaitMs: 1000, hardMaxWaitMs: 24 * 60 * 60 * 1000 },
      });
      return;
    }

    if (route === '/retry/rules' && method === 'POST') {
      if (services.retryStore === undefined) {
        sendJson(res, 501, { ok: false, error: 'not-supported' });
        return;
      }
      const body = objectBody(await readJsonBody(req));
      if (body === null || !Array.isArray(body.rules)) {
        sendJson(res, 400, { ok: false, error: 'bad-body' });
        return;
      }
      /** @type {Array<object>} */
      const incoming = [];
      for (const raw of body.rules) {
        const normalized = normalizeRule(raw);
        if (!normalized.ok) {
          sendJson(res, 400, { ok: false, error: normalized.error, rule: typeof raw?.name === 'string' ? raw.name : undefined });
          return;
        }
        incoming.push(normalized.rule);
      }
      let fallback = { maxDelayMs: DEFAULT_MAX_WAIT_MS };
      if (body.fallback !== null && typeof body.fallback === 'object' && typeof body.fallback.maxDelayMs === 'number') {
        if (!Number.isInteger(body.fallback.maxDelayMs) || body.fallback.maxDelayMs < 1000 || body.fallback.maxDelayMs > 24 * 60 * 60 * 1000) {
          sendJson(res, 400, { ok: false, error: 'bad-fallback-max' });
          return;
        }
        fallback = { maxDelayMs: body.fallback.maxDelayMs };
      } else {
        const doc = await services.retryStore.readDocument();
        if (typeof doc.fallback?.maxDelayMs === 'number') fallback = { maxDelayMs: doc.fallback.maxDelayMs };
      }
      let nextRules = incoming;
      if (body.replace !== true) {
        const doc = await services.retryStore.readDocument();
        const byName = new Map(doc.rules.map((rule) => [rule.name, rule]));
        for (const rule of incoming) byName.set(rule.name, rule);
        nextRules = [...byName.values()];
      }
      const saved = await services.retryStore.saveDocument(nextRules, fallback);
      if (!saved.ok) {
        sendJson(res, 500, { ok: false, error: 'write-failed', message: saved.error });
        return;
      }
      const refreshed = await services.retryStore.readDocument();
      sendJson(res, 200, {
        ok: true,
        rules: refreshed.rules,
        fallback: { maxDelayMs: refreshed.fallback?.maxDelayMs ?? DEFAULT_MAX_WAIT_MS },
        store: services.retryStore.storeInfo(),
      });
      return;
    }

    if (route === '/retry/rules/test' && method === 'POST') {
      const body = objectBody(await readJsonBody(req));
      if (body === null || typeof body.rule !== 'object' || body.rule === null || Array.isArray(body.rule)) {
        sendJson(res, 400, { ok: false, error: 'bad-body' });
        return;
      }
      if (typeof body.text !== 'string' || body.text === '') {
        sendJson(res, 400, { ok: false, error: 'empty-text' });
        return;
      }
      let normalized;
      if (typeof body.rule.name === 'string' && body.rule.name.trim() !== '') {
        normalized = normalizeRule(body.rule);
      } else {
        normalized = normalizeRule({ ...body.rule, name: 'probe' });
      }
      if (!normalized.ok) {
        sendJson(res, 400, { ok: false, error: normalized.error });
        return;
      }
      const fallbackDoc = services.retryStore === undefined
        ? { maxDelayMs: DEFAULT_MAX_WAIT_MS }
        : await services.retryStore.readDocument().then((doc) => ({ maxDelayMs: doc.fallback?.maxDelayMs ?? DEFAULT_MAX_WAIT_MS }));
      const outcome = testRule(normalized.rule, {
        message: body.text,
        provider: typeof body.provider === 'string' ? body.provider : undefined,
        code: typeof body.code === 'string' ? body.code : undefined,
        status: typeof body.status === 'number' ? body.status : undefined,
        providerRetryAfterMs: typeof body.providerRetryAfterMs === 'number' ? body.providerRetryAfterMs : undefined,
      }, services.retryNow === undefined ? Date.now() : services.retryNow(), fallbackDoc);
      sendJson(res, 200, { ok: true, outcome });
      return;
    }

    if (route === '/retry/policy' && method === 'POST') {
      if (services.writeRetryPolicy === undefined) {
        sendJson(res, 501, { ok: false, error: 'not-supported' });
        return;
      }
      const body = objectBody(await readJsonBody(req));
      if (body === null || typeof body.provider !== 'string' || body.policy === null || typeof body.policy !== 'object') {
        sendJson(res, 400, { ok: false, error: 'bad-body' });
        return;
      }
      // Validate against the kernel's retryPolicy grammar before the write so
      // a bad value is a local 400 rather than a settings-load failure.
      const validated = validateRetryPolicy(body.policy);
      if (!validated.ok) {
        sendJson(res, 400, { ok: false, error: validated.error });
        return;
      }
      const result = await services.writeRetryPolicy(body.provider, validated.policy);
      if (!result.ok) {
        const status = result.error === 'conflict' ? 409
          : result.error === 'llm-unavailable' || result.error === 'settings-unavailable' || result.error === 'not-configurable' ? 501 : 400;
        sendJson(res, status, { ok: false, error: result.error });
        return;
      }
      const targets = services.listRetryTargets === undefined ? [] : await services.listRetryTargets().catch(() => []);
      sendJson(res, 200, { ok: true, targets });
      return;
    }

    if (route === '/retry/reset' && method === 'POST') {
      if (services.resetRetryPolicy === undefined) {
        sendJson(res, 501, { ok: false, error: 'not-supported' });
        return;
      }
      const body = objectBody(await readJsonBody(req));
      if (body === null || typeof body.provider !== 'string') {
        sendJson(res, 400, { ok: false, error: 'bad-body' });
        return;
      }
      const result = await services.resetRetryPolicy(body.provider);
      if (!result.ok) {
        const status = result.error === 'conflict' ? 409
          : result.error === 'llm-unavailable' || result.error === 'settings-unavailable' || result.error === 'not-configurable' ? 501
            : result.error === 'not-found' ? 404 : 400;
        sendJson(res, status, { ok: false, error: result.error });
        return;
      }
      const targets = services.listRetryTargets === undefined ? [] : await services.listRetryTargets().catch(() => []);
      sendJson(res, 200, { ok: true, targets });
      return;
    }

    sendJson(res, 404, { ok: false, error: 'not-found' });
  }

  /** Handler with every failure contained as JSON. */
  return async function handler(req, res) {
    try {
      await handle(req, res);
    } catch (error) {
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, error: 'internal', message: error instanceof Error ? error.message : String(error) });
      }
    }
  };
}
