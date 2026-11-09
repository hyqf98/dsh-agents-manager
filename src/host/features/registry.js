/**
 * Shared feature-plugin plumbing for dsh-agents-manager.
 *
 * The bundle splits into four loader rows (core + one per optional
 * capability). Each optional row's module injects the `agents-manager:core`
 * service the core row provides, registers itself through this registry,
 * and disappears entirely when its row is disabled — no tools, no settings
 * page, no engine listeners.
 *
 * @module
 */

/**
 * Create the feature registry the core owns.
 *
 * The registry is deliberately tiny: feature rows announce a stable id and
 * a contribution bundle (tool definitions builder, HTTP services, event
 * listeners), and the core folds them into the agent-binding sync, the HTTP
 * handler, and the /state `features` answer. Registration order follows
 * loader composition; contributions are read live on every use, so a row
 * unloading mid-session simply stops contributing.
 *
 * @returns {object} registry handle for the core service.
 */
export function createFeatureRegistry() {
  /** @type {Map<string, object>} feature id → contribution bundle */
  const features = new Map();

  return {
    /**
     * Announce (or replace) one feature's contributions. Called from the
     * feature module's apply; the disposer removes the row again.
     *
     * @param {string} id - stable feature id ('subagents' | 'retry' | 'processes').
     * @param {object} contribution - the feature's bundle, see createFeature.
     * @returns {() => void} disposer.
     */
    register(id, contribution) {
      features.set(id, contribution);
      return () => {
        if (features.get(id) === contribution) features.delete(id);
      };
    },

    /** Every live feature id, sorted for stable /state answers. */
    activeFeatures() {
      return [...features.keys()].sort();
    },

    /**
     * Tool definitions from every live feature for one agent binding sync.
     *
     * @param {object} ctx - plugin host context, for conflict warnings.
     * @returns {Array<object>} tool definitions in registration order.
     */
    toolDefinitions(ctx) {
      /** @type {Array<object>} */
      const definitions = [];
      for (const [id, contribution] of features) {
        if (typeof contribution.toolDefinitions !== 'function') continue;
        try {
          for (const definition of contribution.toolDefinitions() ?? []) {
            definitions.push(definition);
          }
        } catch (error) {
          try {
            ctx?.logger?.warn?.(`agents-manager: feature "${id}" tool build failed: ${error instanceof Error ? error.message : String(error)}`);
          } catch { /* logging is optional */ }
        }
      }
      return definitions;
    },

    /**
     * HTTP API services contributed by live features. Merged over the core's
     * own services before createHandler, so feature routes live or die with
     * their row (an absent service answers through the handler's degraded
     * branches exactly as an uncomposed optional service does today).
     *
     * @returns {object} service overrides for createHandler.
     */
    apiServices() {
      /** @type {Array<object>} */
      const merged = [];
      for (const [, contribution] of features) {
        if (typeof contribution.apiServices !== 'function') continue;
        try {
          const services = contribution.apiServices();
          if (services !== undefined && services !== null) merged.push(services);
        } catch { /* a broken feature never breaks the API */ }
      }
      return Object.assign({}, ...merged);
    },
  };
}
