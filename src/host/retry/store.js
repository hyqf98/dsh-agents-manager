/**
 * Retry-rules store: the primary home for auto-retry rule configuration.
 *
 * Layering mirrors mcp/store.js and subagents/store.js:
 *  1. DSH unified storage (preferred): a schema-validated KV domain opened
 *     through the Host `storageDomain` facility, under its own domain name
 *     `agents_manager_retry` (the facility refuses one name twice).
 *  2. File fallback: a plugin-owned JSON file under ~/.dsh, written atomically
 *     with a `.bak` rotation.
 *
 * The store serves the engine a compiled snapshot (rules + fallback clamp) so
 * rule edits apply to the next failure without any restart.
 *
 * @module
 */
import { z } from 'zod';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFile, writeFile, rename, mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { normalizeDocument, HARD_MAX_WAIT_MS, DEFAULT_MAX_WAIT_MS } from './rules.js';

/** Largest accepted rules document, in bytes. */
export const MAX_CONFIG_BYTES = 512 * 1024;

/** Zod schema for one stored rule (kept loose; rules.js owns normalization). */
const RuleSchema = z.object({
  name: z.string(),
  when: z.string(),
  flags: z.string().optional(),
  enabled: z.boolean().optional(),
  providers: z.array(z.string()).optional(),
  codes: z.array(z.string()).optional(),
  status: z.array(z.number()).optional(),
  wait: z.object({ kind: z.string() }).passthrough(),
  maxRetries: z.number().optional(),
  clampMs: z.number().optional(),
});

/** The KV domain this plugin owns for retry rules. */
export const DOMAIN_SPEC = {
  name: 'agents_manager_retry',
  version: 1,
  tables: {
    rules: { valueSchema: RuleSchema },
  },
  global: {
    schema: z.object({ maxDelayMs: z.number().optional() }),
    initial: {},
  },
};

/** Default plugin-owned fallback file (only used without the domain form). */
export function defaultFallbackPath() {
  return join(homedir(), '.dsh', 'agents-manager', 'retry.json');
}

/**
 * Read and validate the fallback file. A missing file is an empty store.
 *
 * @param {string} filePath
 * @returns {Promise<{ ok: true, rules: Array<object>, fallback: object, exists: boolean } | { ok: false, error: string, exists: boolean }>}
 */
export async function readConfig(filePath) {
  let text;
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return { ok: false, error: 'not-a-file', exists: true };
    if (info.size > MAX_CONFIG_BYTES) return { ok: false, error: 'too-large', exists: true };
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    if (code === 'ENOENT') return { ok: true, rules: [], fallback: {}, exists: false };
    return { ok: false, error: `read-failed:${code ?? 'unknown'}`, exists: true };
  }
  if (text.trim() === '') return { ok: true, rules: [], fallback: {}, exists: true };
  try {
    return { ...normalizeDocument(JSON.parse(text)), exists: true };
  } catch (error) {
    return { ok: false, error: `bad-json:${/** @type {Error} */ (error).message}`, exists: true };
  }
}

/**
 * Persist the fallback file atomically.
 *
 * @param {string} filePath
 * @param {{ rules: Array<object>, fallback: object }} doc
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
export async function writeConfig(filePath, doc) {
  const body = `${JSON.stringify(doc, null, 2)}\n`;
  try {
    await mkdir(dirname(filePath), { recursive: true });
    let previous = null;
    try {
      previous = await readFile(filePath, 'utf8');
    } catch { /* absent previous is fine */ }
    const temp = `${filePath}.tmp`;
    await writeFile(temp, body, 'utf8');
    if (previous !== null) await writeFile(`${filePath}.bak`, previous, 'utf8');
    await rename(temp, filePath);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: /** @type {Error} */ (error).message };
  }
}

/**
 * Create the retry-rules store handle. All methods are async and never throw
 * for storage unavailability: failures surface through `storeInfo().error`
 * and reads degrade to the empty rule set.
 *
 * @param {object} [options]
 * @param {object | null} [options.storageDomain] - the Host facility, when already resolved.
 * @param {() => object | null} [options.resolveStorageDomain] - lazy resolver.
 * @param {string} [options.fallbackPath] - plugin-owned JSON file path.
 * @param {(message: string) => void} [options.log] - diagnostic sink.
 * @param {() => void} [options.onRulesChanged] - snapshot-refresh hook.
 * @returns {object} store handle.
 */
export function createRetryStore(options = {}) {
  const fallbackPath = options.fallbackPath ?? defaultFallbackPath();
  const log = options.log ?? (() => {});

  /** @type {{ kind: 'domain' | 'file' | 'unavailable', error: string | null }} */
  const state = { kind: 'unavailable', error: null };
  /** @type {any | null} */
  let domain = null;
  /** Current compiled snapshot: normalized rules + fallback clamp. */
  let snapshot = { rules: [], fallback: { maxDelayMs: DEFAULT_MAX_WAIT_MS } };

  const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

  /**
   * Resolve the storage-domain facility, retrying briefly when the caller
   * supplied a lazy resolver (activation order is not guaranteed).
   *
   * @returns {Promise<object | null>}
   */
  async function resolveFacility() {
    if (typeof options.resolveStorageDomain === 'function') {
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          const found = options.resolveStorageDomain();
          if (found !== null && found !== undefined) return found;
        } catch { /* not composed yet */ }
        await delay(300);
      }
      return null;
    }
    return options.storageDomain ?? null;
  }

  /**
   * Read the raw document from whichever backend is live.
   *
   * @returns {Promise<{ rules: Array<object>, fallback: object }>}
   */
  async function readDocument() {
    if (domain !== null) {
      try {
        /** @type {Record<string, unknown>} */
        const globals = domain.global.get();
        // entries() is an iterable of (key, value) pairs; the document's
        // rules are the values alone, matching the file backend's shape.
        /** @type {Array<object>} */
        const rules = [];
        for (const [, value] of domain.table('rules').entries()) rules.push(value);
        return {
          rules,
          fallback: typeof globals.maxDelayMs === 'number' ? { maxDelayMs: globals.maxDelayMs } : {},
        };
      } catch (error) {
        state.error = `domain-read-failed: ${error instanceof Error ? error.message : String(error)}`;
        return { rules: [], fallback: {} };
      }
    }
    const read = await readConfig(fallbackPath);
    if (!read.ok) {
      state.error = read.error;
      return { rules: [], fallback: {} };
    }
    return { rules: read.rules, fallback: read.fallback };
  }

  /** Normalize the raw document into the engine's compiled snapshot. */
  async function refreshSnapshot() {
    const raw = await readDocument();
    const globalMax = typeof raw.fallback?.maxDelayMs === 'number' ? { maxDelayMs: raw.fallback.maxDelayMs } : {};
    const normalized = normalizeDocument({ rules: raw.rules, fallback: globalMax });
    if (!normalized.ok) {
      state.error = `invalid-rules: ${normalized.error}`;
      return;
    }
    // Keep any lower-level error (read failure) visible; only a fully valid
    // snapshot clears it.
    if (state.error === null || state.error.startsWith('invalid-rules')) state.error = null;
    snapshot = { rules: normalized.rules, fallback: normalized.fallback };
    try {
      options.onRulesChanged?.();
    } catch { /* hook is advisory */ }
  }

  /** Open the primary backend. */
  async function init() {
    const storageDomain = await resolveFacility();
    if (storageDomain !== null && typeof storageDomain.open === 'function') {
      try {
        domain = await storageDomain.open(DOMAIN_SPEC);
        state.kind = 'domain';
        state.error = null;
        await migrateFallbackIntoDomain();
      } catch (error) {
        domain = null;
        state.error = `domain-open-failed: ${error instanceof Error ? error.message : String(error)}`;
        log(`agents-manager: unified storage unavailable for retry rules (${state.error}); falling back to ${fallbackPath}`);
      }
    } else if (state.error === null) {
      state.error = 'storage-domain-not-composed';
    }
    if (domain === null) state.kind = 'file';
    await refreshSnapshot();
  }

  /**
   * One-shot convergence: rules written to the fallback file while the domain
   * was unavailable (facility not yet composed on some boot) would otherwise
   * stay invisible now that the domain is the live backend — the engine would
   * silently run with an empty rule list. When the domain opens empty and the
   * file holds a valid non-empty document, copy it in once. A non-empty
   * domain always wins (its rules were written through this same store).
   *
   * @returns {Promise<void>}
   */
  async function migrateFallbackIntoDomain() {
    if (domain === null) return;
    try {
      const table = domain.table('rules');
      for (const _key of table.keys()) {
        return; // domain has rules: nothing to converge
      }
      const fileDoc = await readConfig(fallbackPath);
      if (!fileDoc.ok || fileDoc.rules.length === 0) return;
      const merged = normalizeDocument({ rules: fileDoc.rules, fallback: fileDoc.fallback ?? {} });
      if (!merged.ok) {
        log(`agents-manager: retry-rule fallback file ignored during migration (${merged.error})`);
        return;
      }
      for (const rule of merged.rules) await table.put(rule.name, rule);
      if (typeof fileDoc.fallback?.maxDelayMs === 'number') {
        const existing = domain.global.get();
        await domain.global.set({ ...existing, maxDelayMs: fileDoc.fallback.maxDelayMs });
      }
      log(`agents-manager: migrated ${merged.rules.length} retry rule(s) from ${fallbackPath} into unified storage`);
    } catch (error) {
      log(`agents-manager: retry-rule file→domain migration skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * The engine's compiled view: rules + fallback clamp.
   *
   * @returns {{ rules: Array<object>, fallback: object }}
   */
  function current() {
    return snapshot;
  }

  /**
   * Persist a full validated document (rules + fallback).
   *
   * @param {Array<object>} rules - normalized rules.
   * @param {object} fallback - `{ maxDelayMs }`.
   * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
   */
  async function saveDocument(rules, fallback) {
    if (domain !== null) {
      try {
        const table = domain.table('rules');
        for (const key of table.keys()) await table.delete(key);
        for (const rule of rules) await table.put(rule.name, rule);
        const existing = domain.global.get();
        await domain.global.set({ ...existing, maxDelayMs: fallback.maxDelayMs });
        await refreshSnapshot();
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    const written = await writeConfig(fallbackPath, { rules, fallback });
    if (!written.ok) return written;
    await refreshSnapshot();
    return { ok: true };
  }

  /**
   * Upsert one normalized rule by name.
   *
   * @param {object} rule - normalized rule record.
   * @returns {Promise<{ ok: true, rules: Array<object> } | { ok: false, error: string }>}
   */
  async function putRule(rule) {
    const doc = await readDocument();
    const merged = normalizeDocument({
      rules: [...doc.rules.filter((r) => r.name !== rule.name), rule],
      fallback: doc.fallback,
    });
    if (!merged.ok) return { ok: false, error: merged.error };
    const saved = await saveDocument(merged.rules, merged.fallback);
    if (!saved.ok) return saved;
    return { ok: true, rules: snapshot.rules };
  }

  /**
   * Delete one rule by name.
   *
   * @param {string} name
   * @returns {Promise<{ ok: true, rules: Array<object> } | { ok: false, error: string }>}
   */
  async function removeRule(name) {
    const doc = await readDocument();
    if (!doc.rules.some((r) => r.name === name)) return { ok: false, error: 'not-found' };
    const merged = normalizeDocument({
      rules: doc.rules.filter((r) => r.name !== name),
      fallback: doc.fallback,
    });
    if (!merged.ok) return { ok: false, error: merged.error };
    const saved = await saveDocument(merged.rules, merged.fallback);
    if (!saved.ok) return saved;
    return { ok: true, rules: snapshot.rules };
  }

  /** Store status for API responses. */
  function storeInfo() {
    return { kind: state.kind, fallbackPath, error: state.error, ruleCount: snapshot.rules.length };
  }

  /** Close the domain, when one was opened. */
  async function dispose() {
    if (domain !== null) {
      try {
        await domain.close();
      } catch { /* closing a dead domain is fine */ }
      domain = null;
    }
  }

  return { init, current, readDocument, saveDocument, putRule, removeRule, refreshSnapshot, storeInfo, dispose };
}
