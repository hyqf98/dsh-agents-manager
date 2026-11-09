/**
 * Per-session capability selection: which MCP servers and skills the current
 * session enables. `null` selection means "everything enabled" — the default,
 * matching the product requirement that new sessions start with all MCP
 * servers and all skills.
 *
 * The store is process-local memory keyed by sessionId. It is deliberately not
 * persisted: sessions are ephemeral, and the default (all) is restored on
 * restart.
 *
 * @module
 */

/** A selection value: null (all) or an explicit array of names. */

/**
 * Create the store.
 *
 * @returns {object} store handle.
 */
export function createSelectionStore() {
  /** @type {Map<string, { mcp: string[] | null, skills: string[] | null }>} */
  const bySession = new Map();
  /** @type {Set<(sessionId: string) => void>} */
  const listeners = new Set();

  /**
   * Read one session's selection, defaulting to all.
   *
   * @param {string} sessionId
   * @returns {{ mcp: string[] | null, skills: string[] | null }}
   */
  function get(sessionId) {
    return bySession.get(sessionId) ?? { mcp: null, skills: null };
  }

  /**
   * Write one session's selection. Null fields reset to "all".
   *
   * @param {string} sessionId
   * @param {{ mcp?: string[] | null, skills?: string[] | null }} selection
   */
  function set(sessionId, selection) {
    const previous = get(sessionId);
    const next = {
      mcp: Array.isArray(selection.mcp) ? [...new Set(selection.mcp.filter((name) => typeof name === 'string'))] : null,
      skills: Array.isArray(selection.skills) ? [...new Set(selection.skills.filter((name) => typeof name === 'string'))] : null,
    };
    if (next.mcp === null && previous.mcp === null && next.skills === null && previous.skills === null) return;
    bySession.set(sessionId, next);
    for (const listener of [...listeners]) {
      try {
        listener(sessionId);
      } catch { /* listener errors never break the store */ }
    }
  }

  /**
   * Drop one session's selection (agent disposed).
   *
   * @param {string} sessionId
   */
  function clear(sessionId) {
    bySession.delete(sessionId);
  }

  /**
   * Does one session enable a given MCP server?
   *
   * @param {string} sessionId
   * @param {string} serverName
   * @returns {boolean}
   */
  function mcpEnabled(sessionId, serverName) {
    const selection = get(sessionId);
    if (selection.mcp === null) return true;
    return selection.mcp.includes(serverName);
  }

  /**
   * Does one session enable a given skill?
   *
   * @param {string} sessionId
   * @param {string} skillName
   * @returns {boolean}
   */
  function skillEnabled(sessionId, skillName) {
    const selection = get(sessionId);
    if (selection.skills === null) return true;
    return selection.skills.includes(skillName);
  }

  /**
   * Subscribe to selection changes.
   *
   * @param {(sessionId: string) => void} listener
   * @returns {() => void} disposer.
   */
  function onChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return { get, set, clear, mcpEnabled, skillEnabled, onChange };
}
