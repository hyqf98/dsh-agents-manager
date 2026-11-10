/**
 * Host entry for dsh-agents-manager — the CORE row (骨架).
 *
 * The core owns only what every feature row shares:
 *  - the agent-binding loop: per-agent tool registration (MCP tools through
 *    the capabilities row's seam + feature tools from every live row) and
 *    the skill-selection guard;
 *  - one HTTP prefix route (/agents-manager/api/v1) the browser half calls,
 *    whose services merge every live feature row's apiServices();
 *  - the `agents-manager:core` service the feature rows inject: the feature
 *    registry driving /state.features, the capabilities seam mount, the
 *    delegation seam, and the shared re-sync hooks.
 *
 * Feature rows live in src/host/features/ and load as their own cordis rows
 * (see cordis.patch.yml): capabilities (MCP + skills + session selection),
 * subagents, retry, processes. This core never imports them.
 *
 * @module
 */
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
  const features = createFeatureRegistry();

  /**
   * The capabilities seam: MCP supervisor + config store + skills backend +
   * per-session selection + delegation reservations, supplied live by the
   * capabilities feature row through core.mountCapabilities. Null while that
   * row is disabled — then no MCP tool registers, no skill guard applies,
   * and the HTTP mcp/skills/selection routes answer 501.
   *
   * @type {object | null}
   */
  let caps = null;

  /**
   * The subagents seam the delegation tools call, resolved by the subagents
   * feature row once the seam composes (this core never imports it).
   */
  let subagentsService;

  /**
   * Live per-agent registration state: agent → { sync(), dispose() } where
   * sync() rebuilds the agent-layer registrations from the current pool and
   * selection, and dispose() removes them.
   *
   * @type {Map<object, { sync: () => void, dispose: () => void }>}
   */
  const agentBindings = new Map();

  /**
   * Build (or rebuild) one agent's scoped registrations: MCP tools for every
   * enabled-and-selected connected server (capabilities row), the
   * skill-selection guard, and the feature rows' contributions (delegate
   * tools, retry tools, the process report tool, service-detect listeners).
   * Registrations land on the agent's own layer and are disposed with it;
   * we keep the disposers ourselves as well so plugin unload also removes
   * them.
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
     * @type {{ mcp: string[] | null, skills: string[] | null } | null}
     */
    let effectiveSelection = null;
    if (caps !== null) {
      try {
        const header = agent?.session?.header;
        const reserved = header?.origin === 'subagent' && typeof header?.parentSession === 'string'
          ? caps.pendingCapabilities.consume(String(header.parentSession))
          : null;
        if (reserved !== null) effectiveSelection = reserved;
      } catch { /* reservation handling is best-effort; the session selection stands */ }
    }

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
      if (caps === null) return false; // unreachable: no MCP tools without the row
      return caps.selectionStore.mcpEnabled(sessionId, name);
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
      if (caps === null) return true;
      return caps.selectionStore.skillEnabled(sessionId, name);
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
      // MCP tools (capabilities row only): every enabled-and-selected
      // connected server.
      if (caps !== null) {
        for (const [name, server] of Object.entries(caps.servers())) {
          if (server.enabled === false) continue;
          if (!mcpSelected(name)) continue;
          for (const definition of caps.supervisor.definitionsFor(name)) {
            try {
              registrationDisposers.push(tools.register(definition));
            } catch (error) {
              ctx.logger?.warn?.(`agents-manager: tool registration failed for ${definition.name}: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        }

        // The skill-selection guard (same row: without it every skill loads).
        try {
          registrationDisposers.push(tools.guard((exec) => {
            if (exec?.name !== 'skill') return undefined;
            const requested = exec.arguments?.name;
            if (typeof requested !== 'string' || requested === '') return undefined;
            if (skillSelected(requested)) return undefined;
            return `Skill "${requested}" is disabled for this session — enable it in the composer capability selector.`;
          }));
        } catch { /* a composition without guards keeps MCP tools working */ }
      }

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
      for (const contribution of coreServiceFeatures()) {
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
    if (sessionId !== '' && caps !== null) {
      caps.selectionStore.clear(sessionId);
      // A disposed delegating parent will never spawn its reserved child;
      // drop the reservation so it cannot leak onto a later one.
      caps.pendingCapabilities.disposeParent(sessionId);
    }
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

  /**
   * The features face exposed on the core service (see ctx.provide below);
   * hoisted so syncRegistrations can read raw contribution bundles.
   */
  function coreServiceFeatures() {
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
  }

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
      contributions: coreServiceFeatures,
    },
    /** Service resolution against the core context (storageDomain/jobs/llm/...). */
    serviceOf: (name) => serviceOf(ctx, name),
    /** Re-run every live agent's registration sync. */
    syncAllAgents,
    /** Re-sync one session's agent after a selection change. */
    syncAgentForSession,
    /**
     * Mount (or unmount with null) the capabilities seam: the MCP
     * supervisor/store, skills backend, and session selection handles the
     * core's agent binding consults live on every sync.
     *
     * @param {object | null} seam
     */
    mountCapabilities: (seam) => { caps = seam; },
    /** Live capabilities seam, or null while that row is disabled. */
    capabilities: () => caps,
    /** The delegation seam handle (set by the subagents row when composed). */
    setSubagentsService: (service) => { subagentsService = service; },
    subagentsComposed: () => subagentsService !== undefined,
    /** Delegation capability getters the role tools consult. */
    delegationServices: () => ({
      get subagents() { return subagentsService; },
      get llm() { return serviceOf(ctx, 'llm'); },
      get delegateCapabilities() {
        const pending = caps?.pendingCapabilities;
        return pending === undefined ? undefined : (parentSessionId, selection) => pending.reserve(parentSessionId, selection);
      },
      get sessionSelection() { return caps === null ? undefined : (sessionId) => caps.selectionStore.get(sessionId); },
      get sessionMcpEnabled() {
        return caps === null ? undefined : () => Object.entries(caps.servers()).filter(([, server]) => server.enabled !== false).map(([name]) => name).sort();
      },
      get sessionSkillsEnabled() {
        return caps === null ? undefined : () => caps.listSkills().then((list) => list.map((skill) => skill.name));
      },
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
   * sessionListMetadata blank fold — a turn/start event exists — instead of the
   * event count: a web-built new session can already carry non-turn events
   * (e.g. an auto title) before its first message, so `seq === 0` misjudged
   * genuinely fresh sessions as started and hid their chip forever. This veto
   * is a safe subset of the client's authoritative gate: the host only says
   * fresh=false when the official fold would agree, and anything else stays
   * true for the client to decide. A Session unknown to the live registry
   * returns fresh=true: the host cannot distinguish a fresh blank shell from
   * not-yet-materialized history, and the client's summary gate owns that
   * distinction.
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
   * assembly time, so feature routes live or die with their row (the MCP /
   * skills / selection services arrive through the capabilities row's
   * apiServices; without that row the shared /state still answers, with the
   * capabilities surfaces empty and the mcp/skills routes 501).
   */
  function handlerServices() {
    return {
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

  // Plugin teardown: drop listeners and unbind agents. The stores,
  // supervisors, and reservations belong to their feature rows and are
  // disposed there.
  try {
    ctx.effect(() => () => {
      offCreated();
      offDisposed();
      for (const binding of [...agentBindings.values()]) binding.dispose();
      agentBindings.clear();
    }, 'agents-manager: teardown');
  } catch { /* a context without effects cannot own cleanup */ }
}

export const inject = [];
