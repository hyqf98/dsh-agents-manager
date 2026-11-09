/**
 * Pending per-child capability selections: what a `delegate_<role>` call
 * reserved for the child agent it is about to create, keyed by the PARENT
 * session id. The host entry's agent/created hook consumes and clears the
 * reservation when the child agent appears, so the child's MCP tools and
 * skill guard follow the delegating role's configured selection instead of
 * the parent session's.
 *
 * The map is process-local memory and single-use: a delegation reserves, the
 * child binding consumes. Unconsumed reservations expire so a failed spawn
 * cannot leak a stale selection onto a later child.
 *
 * @module
 */

/** How long an unconsumed reservation stays valid, in ms. */
const RESERVATION_TTL_MS = 60_000;

/**
 * Create the pending-capabilities store.
 *
 * @param {object} [services]
 * @param {() => number} [services.now] - injectable clock.
 * @returns {object} store handle.
 */
export function createPendingCapabilities(services = {}) {
  const now = services.now ?? (() => Date.now());

  /**
   * @typedef {Object} Reservation
   * @property {{ mcp: string[] | null, skills: string[] | null }} selection
   * @property {number} createdAt
   */

  /** @type {Map<string, Reservation>} parent session id → reservation. */
  const byParent = new Map();

  /**
   * Reserve a child's capability selection under the delegating parent.
   *
   * @param {string} parentSessionId
   * @param {{ mcp: string[] | null, skills: string[] | null }} selection - null group = unrestricted.
   * @returns {void}
   */
  function reserve(parentSessionId, selection) {
    if (parentSessionId === undefined || parentSessionId === null || String(parentSessionId) === '') return;
    // Opportunistic expiry: the map is tiny, so sweeping on write is enough.
    const at = now();
    for (const [key, value] of byParent) {
      if (at - value.createdAt > RESERVATION_TTL_MS) byParent.delete(key);
    }
    byParent.set(String(parentSessionId), { selection, createdAt: at });
  }

  /**
   * Consume the reservation a parent's delegation left, if any. Single-use.
   *
   * @param {string} parentSessionId
   * @returns {{ mcp: string[] | null, skills: string[] | null } | null}
   */
  function consume(parentSessionId) {
    const reservation = byParent.get(String(parentSessionId ?? ''));
    if (reservation === undefined) return null;
    byParent.delete(String(parentSessionId));
    return reservation.selection;
  }

  /**
   * Drop one parent's reservation without consuming it — the delegating
   * session went away, so its reserved child will never exist.
   *
   * @param {string} parentSessionId
   * @returns {void}
   */
  function disposeParent(parentSessionId) {
    byParent.delete(String(parentSessionId ?? ''));
  }

  /** Drop every reservation (plugin teardown). */
  function dispose() {
    byParent.clear();
  }

  return { reserve, consume, disposeParent, dispose };
}
