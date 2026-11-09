/**
 * MCP & skills management feature row (`agents-manager-capabilities`).
 *
 * Owns everything the「MCP 和技能」surface is about: the MCP supervisor and
 * its managed config store (startup auto-test = initial pool sync), the
 * ~/.agents/skills listing/editor backend and GitHub installer, and the
 * per-session capability selection (which MCP servers / skills a session
 * enables, plus the child reservations delegation leaves). When this row is
 * disabled no MCP connection opens, no skill guard applies, the settings
 * page and composer chip disappear (via /state.features), and AI sessions
 * fall back to DSH's own MCP/skill handling.
 *
 * @module
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createSupervisor } from '../mcp/supervisor.js';
import { createMcpStore } from '../mcp/store.js';
import * as skillsStore from '../skills/store.js';
import { createSelectionStore } from '../session/selection.js';
import { createPendingCapabilities } from '../session/pending-capabilities.js';
import { detectAgentSources } from '../mcp/agent-sources.js';
import { installFromGithub } from '../skills/installer.js';

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

/**
 * Compose the capabilities feature against the core service.
 *
 * The seam is intentionally narrow: the row hands the core its live handles
 * (supervisor, stores, roots, current snapshot) through core.mountCapabilities
 * and re-syncs agents whenever a handle changes; the core keeps owning agent
 * binding, the HTTP route, and teardown ordering.
 *
 * @param {object} ctx - plugin host context for this row.
 * @returns {void}
 */
export function apply(ctx) {
  ctx.inject(['agents-manager:core'], (scope) => {
    const core = typeof scope.get === 'function' ? scope.get('agents-manager:core') : scope['agents-manager:core'];
    if (core === undefined || core === null) return;

    const warn = (message) => { try { ctx.logger?.warn?.(message); } catch { /* logging is optional */ } };

    const agentsRoot = join(homedir(), '.agents');
    const skillsRoot = join(agentsRoot, 'skills');

    const supervisor = createSupervisor();
    const selectionStore = createSelectionStore();
    const pendingCapabilities = createPendingCapabilities();

    /**
     * The primary MCP configuration store: the DSH unified storage when its
     * domain form is composed, a plugin-owned file under ~/.dsh otherwise.
     * ~/.agents/mcp.json stays a read-only import source.
     */
    const store = createMcpStore({
      resolveStorageDomain: () => core.serviceOf('storageDomain') ?? null,
      log: warn,
    });

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
     * The capabilities seam object the core binds against. Every field is
     * read live by the core's agent-binding sync and HTTP handler, so this
     * row disabling simply never mounts it (the core keeps a capability-free
     * fallback).
     */
    const seam = {
      supervisor,
      store,
      selectionStore,
      pendingCapabilities,
      skillsRoot,
      skillsStoreModule: skillsStore,
      detectAgentSources: () => detectAgentSources({ knownServers: () => store.listServers() }),
      installSkillFromGithub: (source) => installFromGithub({ source, skillsRoot }),
    };

    /**
     * The skills listing /state serves: the filesystem scan of
     * ~/.agents/skills, the same directory the harness skill provider loads.
     *
     * @returns {Promise<Array<object>>}
     */
    async function listSkills() {
      const result = await skillsStore.listSkills(skillsRoot);
      if (!result.ok) return [];
      return result.skills;
    }
    seam.listSkills = listSkills;

    /** Live server snapshot for the core's tool registration. */
    seam.servers = () => currentServers;

    // Pool changes (connections settled, snapshots replaced) re-register tools.
    const offPoolChange = supervisor.onChange(() => {
      core.syncAllAgents();
    });

    // Selection changes re-register only the affected session's agent.
    const offSelection = selectionStore.onChange((sessionId) => {
      core.syncAgentForSession(sessionId);
    });

    // Startup: open the store (one-shot ~/.agents migration included), then
    // the initial pool sync — which IS the startup auto-test; failures land
    // in supervisor.status() where /state (and the client's toasts) read them.
    store.init()
      .then(() => loadServers())
      .then((servers) => supervisor.sync(servers))
      .then(() => core.syncAllAgents())
      .catch((error) => {
        warn(`agents-manager: capabilities startup failed: ${error instanceof Error ? error.message : String(error)}`);
      });

    const disposeCapabilities = core.features.register('capabilities', {
      /** HTTP services for the settings page's mcp/skills/selection routes. */
      apiServices() {
        return {
          store,
          supervisor,
          skillsRoot,
          skillsStoreModule: skillsStore,
          selectionStore,
          listSkills,
          onSelectionChanged: (sessionId) => core.syncAgentForSession(sessionId),
          detectAgentSources: seam.detectAgentSources,
          installSkillFromGithub: seam.installSkillFromGithub,
        };
      },
    });
    try {
      ctx.effect(() => () => disposeCapabilities(), 'agents-manager: capabilities row feature disposer');
    } catch { /* manual detach on row teardown */ }

    core.mountCapabilities(seam);
    // Agents bound before this row resolved must re-sync for MCP tools, the
    // skill guard, and the delegation reservation hooks.
    core.syncAllAgents();

    ctx.effect(() => () => {
      offPoolChange();
      offSelection();
      core.mountCapabilities(null);
      void supervisor.dispose();
      void store.dispose();
      pendingCapabilities.dispose();
    }, 'agents-manager: capabilities row teardown');
  });
}

export const inject = ['agents-manager:core'];
