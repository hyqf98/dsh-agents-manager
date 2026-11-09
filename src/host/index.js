/**
 * Host entry for dsh-agents-manager — the CORE row.
 *
 * Composition:
 *  - one MCP supervisor over the managed MCP config (startup auto-test =
 *    initial pool sync; failures surface through /state for the client's
 *    toasts);
 *  - one HTTP prefix route (/agents-manager/api/v1) the browser half calls;
 *  - the `agents-manager:core` service the bundle's optional feature rows
 *    (subagents / retry / processes) inject: shared stores, the agent
 *    binding loop, the HTTP service merge, and the feature registry that
 *    drives /state.features (the client hides each disabled feature's UI);
 *  - per-agent tool registration: MCP tools for the servers its session
 *    selected plus feature tools from every live feature row, and a guard
 *    that denies `skill` loads for skills the session deselected.
 *
 * Feature rows live in src/host/features/ and load as their own cordis
 * entries (see cordis.patch.yml); this core never imports them.
 *
 * @module
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createSupervisor } from './mcp/supervisor.js';
import { createMcpStore } from './mcp/store.js';
import * as skillsStore from './skills/store.js';
import { createSelectionStore } from './session/selection.js';
import { createPendingCapabilities } from './session/pending-capabilities.js';
import { detectAgentSources } from './mcp/agent-sources.js';
import { installFromGithub } from './skills/installer.js';
import { createFeatureRegistry } from './features/registry.js';
import { createHandler, API_BASE } from './http/api.js';

/** Resolve a service from a context, tolerating property or registry access. */
function serviceOf(scope, name) {
  try {
    if (scope && typeof scope.get === 'function') {
      const found = scope.get(name);
      if (found !== undefined && found !== null) return found;
    }
  } catch { /* registry miss */ }
  return scope?.[name] ?? undefined;
}

/** Best-effort session id from an Agent handle across harness revisions. */
function sessionIdOf(agent) {
  const candidate = agent?.session?.id ?? agent?.id ?? agent?.sessionId;
  return candidate === undefined || candidate === null ? '' : String(candidate);
}

/**
 * Compose the plugin against the host context. Each capability waits for its
 * own service so a headless composition (no web server) still gets tools.
 *
 * @param {object} ctx - plugin host context.
 * @returns {void}
 */
export function apply(ctx) {
  const agentsRoot = join(homedir(), '.agents');
  const skillsRoot = join(agentsRoot, 'skills');

  const supervisor = createSupervisor();
  const selectionStore = createSelectionStore();
  const features = createFeatureRegistry();

  /**
   * Capability reservations a `delegate_<role>` call leaves for the child it
   * spawns: consumed by bindAgent when the child's agent/created fires, so a
   * role can pin the child's MCP/skill selection regardless of what the
   * delegating session itself selected.
   */
  const pendingCapabilities = createPendingCapabilities();

  /**
   * The subagents seam the delegation tools call, resolved by the subagents
   * feature row once the seam composes (this core never imports it).
   */
  let subagentsService;

  /**
   * The primary MCP configuration store: the DSH unified storage when its
   * domain form is composed (this deployment has it), a plugin-owned file
   * under ~/.dsh otherwise. ~/.agents/mcp.json stays a read-only import
   * source that the store migrates once when the primary store is empty.
   */
  const store = createMcpStore({
    // Lazy on purpose: activation order is not guaranteed, so the store retries
    // this briefly before falling back to the plugin-owned ~/.dsh file.
    resolveStorageDomain: () => serviceOf(ctx, 'storageDomain') ?? null,
    log: (message) => { try { ctx.logger?.warn?.(message); } catch { /* logging is optional */ } },
  });

  /**
   * Live per-agent registration state: agent → { sync(), dispose() } where
   * sync() rebuilds the agent-layer registrations from the current pool and
   * selection, and dispose() removes them.
   *
   * @type {Map<object, { sync: () => void, dispose: () => void }>}
   */
  const agentBindings = new Map();

  /** Current server snapshot read through the store. */
  let currentServers = {};

  /**
   * Re-read the managed servers through the store.
   *
   * @returns {Promise<Record<string, object>>}
   */
  async function loadServers() {
    currentServers = await store.listServers();
    return currentServers;
  }

  /**
   * The skills listing /state serves: the filesystem scan of ~/.agents/skills,
   * which is the same directory the harness skill provider loads.
   *
   * @returns {Promise<Array<object>>}
   */
  async function listSkills() {
    const result = await skillsStore.listSkills(skillsRoot);
    if (!result.ok) return [];
    return result.skills;
  }

  /**
   * Build (or rebuild) one agent's scoped registrations: MCP tools for every
   * enabled-and-selected connected server, the skill-selection guard, and
   * the feature rows' contributions (delegate tools, retry tools, the
   * process report tool, service-detect listeners). Registrations land on
   * the agent's own layer and are disposed with it; we keep the disposers
   * ourselves as well so plugin unload also removes them.
   *
   * @param {object} agent - live Agent handle from agent/created.
   */
  function bindAgent(agent) {
    const agentCtx = agent?.ctx;
    if (agentCtx === undefined || agentBindings.has(agent)) return;
    const sessionId = sessionIdOf(agent);

    /**
     * The child's effective selection: the delegating role's reservation
     * when this agent is a freshly spawned subagent child, otherwise (and by
     * default) the session's own composer selection. Reservation consumes
     * once, so a resumed or re-created child with the same id falls back to
     * the session selection rather than a stale role pin.
     *
     * @type {{ mcp: string[] | null, skills: string[] | null }}
     */
    let effectiveSelection = null;
    try {
      const header = agent?.session?.header;
      const reserved = header?.origin === 'subagent' && typeof header?.parentSession === 'string'
        ? pendingCapabilities.consume(String(header.parentSession))
        : null;
      if (reserved !== null) effectiveSelection = reserved;
    } catch { /* reservation handling is best-effort; the session selection stands */ }

    /**
     * Does this session's selection enable one MCP server? A child with a
     * role reservation answers through the reservation instead.
     *
     * @param {string} name
     * @returns {boolean}
     */
    function mcpSelected(name) {
      if (effectiveSelection !== null) {
        return effectiveSelection.mcp === null || effectiveSelection.mcp.includes(name);
      }
      return selectionStore.mcpEnabled(sessionId, name);
    }

    /**
     * Does this session's selection enable one skill? Same reservation rule.
     *
     * @param {string} name
     * @returns {boolean}
     */
    function skillSelected(name) {
      if (effectiveSelection !== null) {
        return effectiveSelection.skills === null || effectiveSelection.skills.includes(name);
      }
      return selectionStore.skillEnabled(sessionId, name);
    }

    /** Disposers owned by the agent binding (registrations + agent effect). */
    let registrationDisposers = [];
    let agentEffectDisposer = null;

    /** Remove current registrations without dropping the binding. */
    function unregister() {
      for (const dispose of registrationDisposers.splice(0)) {
        try {
          dispose();
        } catch { /* already gone with the agent */ }
      }
    }

    /** Rebuild registrations from the live pool, selection, and features. */
    function sync() {
      // Check BEFORE unregistering: an MCP-ready storm re-syncs every agent
      // repeatedly, and one sync that cannot resolve the tools service must
      // leave the existing registrations intact — unregister-then-return left
      // the agent with NO plugin tools at all (intermittent missing
      // delegate/retry tools in E2E) until some later re-sync happened to
      // succeed.
      const tools = serviceOf(agentCtx, 'tools');
      if (tools === undefined || sessionId === '') return;
      try {
        unregister();
        syncRegistrations(tools);
      } catch (error) {
        // A throw mid-way (observed intermittently in E2E: role tools
        // registered, retry tools never reached) must be visible, not silent.
        ctx.logger?.warn?.(`agents-manager: agent tool sync failed midway: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    /** The registration body, extracted so sync() can guard it whole. @param {object} tools */
    function syncRegistrations(tools) {
      // MCP tools: every enabled-and-selected connected server.
      for (const [name, server] of Object.entries(currentServers)) {
        if (server.enabled === false) continue;
        if (!mcpSelected(name)) continue;
        for (const definition of supervisor.definitionsFor(name)) {
          try {
            registrationDisposers.push(tools.register(definition));
          } catch (error) {
            ctx.logger?.warn?.(`agents-manager: tool registration failed for ${definition.name}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }

      // The skill-selection guard.
      try {
        registrationDisposers.push(tools.guard((exec) => {
          if (exec?.name !== 'skill') return undefined;
          const requested = exec.arguments?.name;
          if (typeof requested !== 'string' || requested === '') return undefined;
          if (skillSelected(requested)) return undefined;
          return `Skill "${requested}" is disabled for this session — enable it in the composer capability selector.`;
        }));
      } catch { /* a composition without guards keeps MCP tools working */ }

      // Feature rows: tool definitions (delegate tools, retry trio) plus the
      // processes row's per-agent hooks (report tool + detect listeners).
      for (const definition of features.toolDefinitions(ctx)) {
        try {
          if (typeof tools.get === 'function' && tools.get(definition.name) !== undefined) {
            ctx.logger?.warn?.(`agents-manager: tool name "${definition.name}" is already taken; feature tool skipped`);
            continue;
          }
          registrationDisposers.push(tools.register(definition));
        } catch (error) {
          ctx.logger?.warn?.(`agents-manager: feature tool registration failed for ${definition.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      // The processes row's per-agent service-detect listeners (layers 1-2)
      // and any other contribution-carried tools (the report tool rides
      // contributions() because it pairs with the detect hooks).
      for (const contribution of features.contributions()) {
        for (const definition of (contribution?.tools ?? [])) {
          try {
            if (typeof tools.get === 'function' && tools.get(definition.name) !== undefined) {
              ctx.logger?.warn?.(`agents-manager: tool name "${definition.name}" is already taken; feature tool skipped`);
              continue;
            }
            registrationDisposers.push(tools.register(definition));
          } catch (error) {
            ctx.logger?.warn?.(`agents-manager: feature tool registration failed for ${definition.name}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (contribution?.detect === undefined) continue;
        try {
          const offPre = agentCtx.on('tools/pre-execute', contribution.detect.onPreExecute);
          const offPost = agentCtx.on('tools/post-execute', contribution.detect.onPostExecute);
          const detachDetect = () => {
            try { offPre(); } catch { /* already gone */ }
            try { offPost(); } catch { /* already gone */ }
          };
          registrationDisposers.push(detachDetect);
          try {
            ctx.effect(() => detachDetect, 'agents-manager: service-detect listeners');
          } catch { /* manual detach on plugin teardown below */ }
        } catch (error) {
          ctx.logger?.warn?.(`agents-manager: service-detect listeners failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    const binding = {
      sync,
      dispose() {
        unregister();
        try {
          agentEffectDisposer?.();
        } catch { /* agent may already be gone */ }
        agentEffectDisposer = null;
      },
    };
    agentBindings.set(agent, binding);

    try {
      agentEffectDisposer = agentCtx.effect(() => {
        // When the agent's context is disposed (session end), registrations
        // registered through it are removed automatically; drop our record.
        return () => {
          unregister();
          agentBindings.delete(agent);
        };
      });
    } catch { /* an agent ctx without effects still gets manual cleanup */ }

    // Also keep the whole binding removable by our own plugin unload.
    try {
      ctx.effect(() => () => binding.dispose(), 'agents-manager: agent binding');
    } catch { /* manual dispose on plugin teardown below */ }

    sync();
  }

  /** Re-sync every live agent (pool change or config change). */
  function syncAllAgents() {
    for (const binding of agentBindings.values()) binding.sync();
  }

  /** Re-sync one session's agent after a selection change. */
  function syncAgentForSession(sessionId) {
    for (const [agent, binding] of agentBindings) {
      if (sessionIdOf(agent) === sessionId) binding.sync();
    }
  }

  // Pool changes (connections settled, snapshots replaced) re-register tools.
  const offPoolChange = supervisor.onChange(() => {
    syncAllAgents();
  });

  // Agent lifecycle: bind tools when agents appear, forget them when they go.
  const offCreated = ctx.on('agent/created', (payload) => {
    try {
      bindAgent(payload?.agent);
    } catch (error) {
      ctx.logger?.warn?.(`agents-manager: agent binding failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  const offDisposed = ctx.on('agent/disposed', (payload) => {
    const binding = agentBindings.get(payload?.agent);
    if (binding !== undefined) {
      binding.dispose();
      agentBindings.delete(payload?.agent);
    }
    const sessionId = sessionIdOf(payload?.agent);
    if (sessionId !== '') {
      selectionStore.clear(sessionId);
      // A disposed delegating parent will never spawn its reserved child;
      // drop the reservation so it cannot leak onto a later one.
      pendingCapabilities.disposeParent(sessionId);
    }
  });

  // Selection changes re-register only the affected session's agent.
  const offSelection = selectionStore.onChange((sessionId) => {
    syncAgentForSession(sessionId);
  });

  // Startup: open the store (one-shot ~/.agents migration included), then the
  // initial pool sync — which IS the startup auto-test; failures land in
  // supervisor.status() where /state (and the client's toasts) read them.
  store.init()
    .then(() => loadServers())
    .then((servers) => supervisor.sync(servers))
    .then(() => syncAllAgents())
    .catch((error) => {
      ctx.logger?.warn?.(`agents-manager: startup failed: ${error instanceof Error ? error.message : String(error)}`);
    });

  /**
   * The LLM catalog the settings page offers in its model pickers: registered
   * providers and their advertised models. Degrades to an empty catalog when
   * the llm service is not composed.
   *
   * @returns {Promise<Array<{ id: string, name: string, models: Array<{ id: string, name: string }> }>>}
   */
  async function listLlmCatalog() {
    const llm = serviceOf(ctx, 'llm');
    if (llm === undefined || typeof llm.listProviders !== 'function') return [];
    /** @type {Array<{ id: string, name: string, models: Array<{ id: string, name: string }> }>} */
    const providers = [];
    for (const provider of llm.listProviders()) {
      /** @type {{ id: string, name: string, models: Array<{ id: string, name: string }> }} */
      const entry = { id: provider.id, name: provider.name ?? provider.id, models: [] };
      try {
        const models = await llm.listModels(provider.id);
        if (Array.isArray(models)) {
          entry.models = models.map((model) => ({
            id: model.id,
            name: model.name ?? model.id,
            efforts: Array.isArray(model?.reasoning?.efforts)
              ? model.reasoning.efforts.map((effort) => effort.id)
              : [],
          }));
        }
      } catch { /* a provider whose catalog cannot be read offers manual entry */ }
      providers.push(entry);
    }
    return providers;
  }

  /**
   * The core service the feature rows inject. Everything the rows need from
   * this core rides this object; the rows never import core internals.
   *
   * The service's features face wraps the registry so every registration is
   * also mirrored into `featureBundles` (the raw contributions the processes
   * row exposes ride there; toolDefinitions/apiServices stay on the registry
   * path so the core's own sync/HTTP folds keep working when rows vanish).
   */
  /** @type {Map<string, object>} */
  const featureBundles = new Map();

  ctx.provide('agents-manager:core', {
    /** The shared feature registry, with raw contribution bundles reachable. */
    features: {
      register(id, contribution) {
        featureBundles.set(id, contribution);
        const dispose = features.register(id, contribution);
        return () => {
          if (featureBundles.get(id) === contribution) featureBundles.delete(id);
          dispose();
        };
      },
      activeFeatures: () => features.activeFeatures(),
      /**
       * Raw contribution bundles from live features (the processes row's
       * per-agent detect hooks ride here).
       *
       * @returns {Array<object>}
       */
      contributions() {
        /** @type {Array<object>} */
        const out = [];
        for (const id of features.activeFeatures()) {
          const bundle = featureBundles.get(id);
          if (bundle?.contributions !== undefined) {
            try {
              out.push(bundle.contributions());
            } catch { /* a broken feature never breaks binding sync */ }
          }
        }
        return out;
      },
    },
    /** Service resolution against the core context (storageDomain/jobs/llm/...). */
    serviceOf: (name) => serviceOf(ctx, name),
    /** Re-run every live agent's registration sync. */
    syncAllAgents,
    /** The delegation seam handle (set by the subagents row when composed). */
    setSubagentsService: (service) => { subagentsService = service; },
    subagentsComposed: () => subagentsService !== undefined,
    /** Delegation capability getters the role tools consult. */
    delegationServices: () => ({
      get subagents() { return subagentsService; },
      get llm() { return serviceOf(ctx, 'llm'); },
      get delegateCapabilities() { return (parentSessionId, selection) => pendingCapabilities.reserve(parentSessionId, selection); },
      get sessionSelection() { return (sessionId) => selectionStore.get(sessionId); },
      get sessionMcpEnabled() { return () => Object.entries(currentServers).filter(([, server]) => server.enabled !== false).map(([name]) => name).sort(); },
      get sessionSkillsEnabled() { return () => skillsStore.listSkills(skillsRoot).then((result) => (result.ok ? result.skills.map((skill) => skill.name) : [])); },
    }),
    /** The model catalog for the role editor's pickers. */
    listLlmCatalog,
  });

  /**
   * Whether the named Session is still empty — one input of the composer
   * capability chip's visibility. The client combines this with its own
   * session-summary gate (blank state, which sees cold-viewed history too);
   * this host check vetoes what only the live registry knows: a subagent
   * conversation (tools fixed at spawn) and a live session that already has
   * turns. "Has turns" follows the same semantics as the official
   * sessionListMetadata blank fold — a turn/start event exists — instead of
   * the event count: a web-built new session can already carry non-turn
   * events (e.g. an auto title) before its first message, so `seq === 0`
   * misjudged genuinely fresh sessions as started and hid their chip
   * forever. This veto is a safe subset of the client's authoritative
   * gate: the host only says fresh=false when the official fold would
   * agree, and anything else stays true for the client to decide.
   * A Session unknown to the live registry returns fresh=true: the host
   * cannot distinguish a fresh blank shell from not-yet-materialized
   * history, and the client's summary gate owns that distinction.
   *
   * @param {string} sessionId
   * @returns {boolean}
   */
  function sessionFresh(sessionId) {
    try {
      const sessions = serviceOf(ctx, 'sessions');
      if (sessions === undefined || typeof sessions.get !== 'function') return true;
      const session = sessions.get(sessionId);
      if (session === undefined) return true;
      // A subagent conversation never offers capability selection: its tools
      // were fixed when the delegating agent started it.
      if (session.header?.origin === 'subagent') return false;
      // Started means "a turn exists", mirroring the official blank fold.
      // Non-turn events (titles, fork seed markers) do not start a session.
      for (const event of session.snapshotEvents()) {
        if (event.type === 'turn/start') return false;
      }
      return true;
    } catch {
      return true;
    }
  }

  /**
   * The HTTP API the settings page and composer selector talk to: core
   * services merged with every live feature row's apiServices() at request
   * assembly time, so feature routes live or die with their row.
   */
  function handlerServices() {
    return {
      store,
      supervisor,
      skillsRoot,
      skillsStore,
      selectionStore,
      listSkills,
      onSelectionChanged: (sessionId) => syncAgentForSession(sessionId),
      detectAgentSources: () => detectAgentSources({ knownServers: () => store.listServers() }),
      installSkillFromGithub: (source) => installFromGithub({ source, skillsRoot }),
      listLlmCatalog,
      sessionFresh,
      features: () => features.activeFeatures(),
      ...features.apiServices(),
    };
  }

  /** @type {(req: object, res: object) => Promise<void>} */
  let handler = null;
  function ensureHandler() {
    if (handler === null) handler = createHandler(handlerServices());
    return handler;
  }

  /**
   * Mount the prefix route once a web server is composed. The handler is
   * rebuilt lazily per request from live feature services, so a row toggle
   * applies without re-mounting the route.
   *
   * @param {object} scope - context carrying webServer.
   */
  function mountRoutes(scope) {
    const webServer = serviceOf(scope, 'webServer');
    if (webServer === undefined || typeof webServer.register !== 'function') return;
    webServer.register({ kind: 'prefix', path: API_BASE, handler: (req, res) => ensureHandler()(req, res) });
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], mountRoutes);
  } else {
    mountRoutes(ctx);
  }

  // Plugin teardown: stop connections, drop listeners, unbind agents, close the store.
  try {
    ctx.effect(() => () => {
      offPoolChange();
      offCreated();
      offDisposed();
      offSelection();
      for (const binding of [...agentBindings.values()]) binding.dispose();
      agentBindings.clear();
      void supervisor.dispose();
      void store.dispose();
      pendingCapabilities.dispose();
    }, 'agents-manager: teardown');
  } catch { /* a context without effects cannot own cleanup */ }
}

export const inject = [];
