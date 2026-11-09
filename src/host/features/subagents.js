/**
 * Subagents feature row (`agents-manager-subagents`).
 *
 * Owns the delegation-role store, the `delegate_<role>` + model-pool tools,
 * the「子代理」settings page's HTTP services, and the settings catalog the
 * role editor offers. Injects the core service; when this row is disabled
 * the store never opens, the tools never register, and the client hides the
 * settings page (via /state.features).
 *
 * @module
 */
import { createSubagentsStore } from '../subagents/store.js';
import { buildRoleTools, buildPoolListTool } from '../subagents/router.js';

/**
 * Compose the subagents feature against the core service.
 *
 * @param {object} ctx - plugin host context for this row.
 * @returns {void}
 */
export function apply(ctx) {
  ctx.inject(['agents-manager:core'], (scope) => {
    const core = typeof scope.get === 'function' ? scope.get('agents-manager:core') : scope['agents-manager:core'];
    if (core === undefined || core === null) return;

    /** The delegation-role store: same two-layer scheme as the MCP store. */
    const subagentsStore = createSubagentsStore({
      resolveStorageDomain: () => core.serviceOf('storageDomain') ?? null,
      log: (message) => { try { ctx.logger?.warn?.(message); } catch { /* logging is optional */ } },
    });

    /** Current role snapshot read through the store. */
    let currentRoles = {};
    /** Current global model-pool snapshot read through the store. */
    let currentPool = [];

    /**
     * Re-read roles and rebuild every live agent's registrations.
     *
     * @returns {Promise<void>}
     */
    async function refresh() {
      currentRoles = await subagentsStore.listRoles();
      currentPool = await subagentsStore.listPoolModels();
      core.syncAllAgents();
    }

    subagentsStore.init()
      .then(() => refresh())
      .catch((error) => {
        ctx.logger?.warn?.(`agents-manager: subagent role store startup failed: ${error instanceof Error ? error.message : String(error)}`);
      });

    /**
     * The subagents seam: role tools only register while it is composed.
     * The seam can compose after this row, so inject re-syncs on arrival.
     */
    if (typeof ctx.inject === 'function') {
      ctx.inject(['subagents'], () => {
        core.setSubagentsService(core.serviceOf('subagents'));
        refresh().catch(() => { /* roles stay as last read */ });
      });
    } else {
      core.setSubagentsService(core.serviceOf('subagents'));
    }

    ctx.effect(() => () => {
      void subagentsStore.dispose();
    }, 'agents-manager: subagents row teardown');

    const disposeSubagents = core.features.register('subagents', {
      /**
       * Tool definitions for one agent-binding sync: the pool-list tool plus
       * one delegate_<role> per enabled role. Only meaningful while the
       * subagents seam is composed (the core tracks that).
       *
       * @returns {Array<object>}
       */
      toolDefinitions() {
        if (!core.subagentsComposed()) return [];
        const warn = (message) => {
          try { ctx.logger?.warn?.(message); } catch { /* logging is optional */ }
        };
        const poolListTool = buildPoolListTool(currentPool);
        const roleTools = buildRoleTools(currentRoles, core.delegationServices(), currentPool, warn);
        return poolListTool === null ? roleTools : [poolListTool, ...roleTools];
      },
      /** HTTP services for the settings page's /subagents routes. */
      apiServices() {
        return {
          subagentsStore,
          onSubagentsChanged: () => { void refresh(); },
          listLlmCatalog: () => core.listLlmCatalog(),
        };
      },
    });
    // Agents bound before this row resolved must re-sync for the role tools.
    core.syncAllAgents();
    try {
      ctx.effect(() => () => disposeSubagents(), 'agents-manager: subagents row feature disposer');
    } catch { /* manual detach on row teardown */ }
  });
}

export const inject = ['agents-manager:core'];
