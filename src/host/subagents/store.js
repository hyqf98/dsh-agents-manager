/**
 * Subagent role store: the primary home for delegation-role configuration.
 *
 * Layering mirrors mcp/store.js:
 *  1. DSH unified storage (preferred): a schema-validated KV domain opened
 *     through the Host `storageDomain` facility. The domain name is distinct
 *     from the MCP store's `agents_manager` domain because the facility
 *     refuses to open one name twice (`already-open`), so role data lives in
 *     `agents_manager_subagents` — still deployment-wide DSH storage.
 *  2. File fallback (when the storage-domain form is not composed): a
 *     plugin-owned JSON file under ~/.dsh, written atomically with a `.bak`
 *     rotation, exactly like the MCP fallback file beside it.
 *
 * Plugin data is shared across DSH profiles by design: profiles are
 * composition layers (which plugins are installed), while the unified storage
 * root (~/.dsh/storages) is deployment-wide — the same convention the host's
 * own workspace and credential storage follow.
 *
 * @module
 */
import { z } from 'zod';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFile, writeFile, rename, mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { BUILTIN_ROLES, mergeBuiltinRoles } from './builtin.js';

/** Longest accepted role name (the `delegate_` tool prefix eats the rest). */
export const MAX_ROLE_NAME = 23;
/** Largest accepted config file, in bytes. */
export const MAX_CONFIG_BYTES = 512 * 1024;

/** Zod schema for one model candidate inside a role. */
const ModelSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  reasoningEffort: z.string().min(1).optional(),
  description: z.string().optional(),
});

/** Zod record schema for one delegation role. */
const RoleSchema = z.object({
  description: z.string(),
  promptPrefix: z.string().optional(),
  preset: z.string().min(1).optional(),
  maxTokens: z.number().int().positive().optional(),
  enabled: z.boolean(),
  openPool: z.boolean().optional(),
  models: z.array(ModelSchema),
  /** Names of the MCP servers this role's children may use; null = all (default). */
  mcp: z.array(z.string()).nullable().optional(),
  /** Names of the skills this role's children may load; null = all (default). */
  skills: z.array(z.string()).nullable().optional(),
});

/** Zod record schema for one global model-pool entry. */
const PoolModelSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  name: z.string().optional(),
  description: z.string().optional(),
  reasoningEffort: z.string().min(1).optional(),
  enabled: z.boolean(),
});

/** The KV domain this plugin owns for delegation roles and the model pool. */
export const DOMAIN_SPEC = {
  name: 'agents_manager_subagents',
  version: 1,
  tables: {
    roles: { valueSchema: RoleSchema },
    models: { valueSchema: PoolModelSchema },
  },
  global: {
    schema: z.object({}),
    initial: {},
  },
};

/** Default plugin-owned fallback file (only used without the domain form). */
export function defaultFallbackPath() {
  return join(homedir(), '.dsh', 'agents-manager', 'subagents.json');
}

/**
 * Sanitize a raw role name into a safe `delegate_<role>` suffix: lowercase
 * kebab-case, `[a-z0-9-]`, bounded length. Returns '' when nothing usable
 * remains.
 *
 * @param {unknown} raw - user-provided role name.
 * @returns {string}
 */
export function sanitizeRoleName(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_ROLE_NAME)
    .replace(/-+$/g, '');
}

/**
 * Normalize one raw role entry into this plugin's canonical record.
 * Returns `{ ok: true, role }` or `{ ok: false, error }` with a stable code.
 *
 * @param {unknown} raw - parsed JSON value for one role.
 * @param {object} [options]
 * @param {boolean} [options.allowEmptyModels] - accept an empty candidate list
 *        (used when saving a customization of a builtin, which ships no
 *        models and inherits the calling session's model).
 * @returns {{ ok: true, role: object } | { ok: false, error: string }}
 */
export function normalizeRole(raw, options = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'not-object' };
  }
  const source = /** @type {Record<string, unknown>} */ (raw);
  const description = typeof source.description === 'string' ? source.description.trim() : '';
  if (description === '') return { ok: false, error: 'missing-description' };
  const allowEmptyModels = options.allowEmptyModels === true;
  if (!Array.isArray(source.models) || (source.models.length === 0 && !allowEmptyModels)) {
    return { ok: false, error: 'missing-models' };
  }
  /** @type {Array<object>} */
  const models = [];
  const seen = new Set();
  for (const candidate of source.models) {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      return { ok: false, error: 'bad-model' };
    }
    const entry = /** @type {Record<string, unknown>} */ (candidate);
    if (typeof entry.provider !== 'string' || entry.provider.trim() === ''
      || typeof entry.model !== 'string' || entry.model.trim() === '') {
      return { ok: false, error: 'bad-model' };
    }
    const key = `${entry.provider}\n${entry.model}`;
    if (seen.has(key)) return { ok: false, error: 'duplicate-model' };
    seen.add(key);
    /** @type {Record<string, unknown>} */
    const model = {
      provider: entry.provider.trim(),
      model: entry.model.trim(),
    };
    if (entry.reasoningEffort !== undefined && entry.reasoningEffort !== null) {
      if (typeof entry.reasoningEffort !== 'string' || entry.reasoningEffort.trim() === '') {
        return { ok: false, error: 'bad-effort' };
      }
      model.reasoningEffort = entry.reasoningEffort.trim();
    }
    if (entry.description !== undefined && entry.description !== null) {
      if (typeof entry.description !== 'string') return { ok: false, error: 'bad-model-description' };
      const text = entry.description.trim();
      if (text !== '') model.description = text;
    }
    models.push(model);
  }
  /** @type {Record<string, unknown>} */
  const role = {
    description,
    enabled: source.enabled === undefined ? true : source.enabled === true,
    models,
  };
  // Optional user-facing grouping label; the client folds role cards by it.
  if (source.category !== undefined && source.category !== null) {
    if (typeof source.category !== 'string') return { ok: false, error: 'bad-category' };
    const category = source.category.trim().slice(0, 40);
    if (category !== '') role.category = category;
  }
  if (source.promptPrefix !== undefined && source.promptPrefix !== null) {
    if (typeof source.promptPrefix !== 'string') return { ok: false, error: 'bad-prompt-prefix' };
    if (source.promptPrefix.trim() !== '') role.promptPrefix = source.promptPrefix;
  }
  if (source.preset !== undefined && source.preset !== null) {
    if (typeof source.preset !== 'string' || source.preset.trim() === '') {
      return { ok: false, error: 'bad-preset' };
    }
    role.preset = source.preset.trim();
  }
  if (source.decision !== undefined && source.decision !== null) {
    if (typeof source.decision === 'object' && !Array.isArray(source.decision)
      && source.decision.type === 'remote'
      && typeof source.decision.baseURL === 'string' && source.decision.baseURL.trim() !== ''
      && typeof source.decision.model === 'string' && source.decision.model.trim() !== '') {
      const decision = { type: 'remote', baseURL: source.decision.baseURL.trim(), model: source.decision.model.trim() };
      if (typeof source.decision.apiKey === 'string' && source.decision.apiKey.trim() !== '') decision.apiKey = source.decision.apiKey.trim();
      role.decision = decision;
    }
  }
  if (source.openPool !== undefined && source.openPool !== null) {
    role.openPool = source.openPool === true;
  }
  // Per-role capability selection: null or absent = follow the calling
  // session's selection (stayed absent); a string array whitelists exactly
  // those names, deduplicated and trimmed.
  for (const [field, code] of /** @type {Array<[string, string]>} */ ([['mcp', 'bad-mcp'], ['skills', 'bad-skills']])) {
    if (source[field] === undefined || source[field] === null) continue;
    if (!Array.isArray(source[field])) return { ok: false, error: code };
    /** @type {Array<string>} */
    const names = [];
    for (const item of source[field]) {
      if (typeof item !== 'string' || item.trim() === '') return { ok: false, error: code };
      const name = item.trim();
      if (!names.includes(name)) names.push(name);
    }
    role[field] = names;
  }
  if (source.maxTokens !== undefined && source.maxTokens !== null) {
    if (!Number.isInteger(/** @type {unknown} */ (source.maxTokens)) || /** @type {number} */ (source.maxTokens) < 1) {
      return { ok: false, error: 'bad-max-tokens' };
    }
    role.maxTokens = source.maxTokens;
  }
  return { ok: true, role };
}

/**
 * Validate the full parsed fallback document (`{"roles": {...}}`).
 *
 * @param {unknown} parsed - parsed JSON value of the whole file.
 * @returns {{ ok: true, roles: Record<string, object> } | { ok: false, error: string }}
 */
export function normalizeDocument(parsed) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'not-object' };
  }
  const doc = /** @type {Record<string, unknown>} */ (parsed);
  const rawRoles = doc.roles ?? {};
  if (rawRoles === null || typeof rawRoles !== 'object' || Array.isArray(rawRoles)) {
    return { ok: false, error: 'bad-roles' };
  }
  /** @type {Record<string, object>} */
  const roles = {};
  for (const [name, raw] of Object.entries(/** @type {Record<string, unknown>} */ (rawRoles))) {
    const normalized = normalizeRole(raw);
    if (!normalized.ok) return { ok: false, error: `${name}: ${normalized.error}` };
    roles[name] = normalized.role;
  }
  return { ok: true, roles };
}

/**
 * Read and validate the fallback file. A missing file is an empty store, not
 * an error.
 *
 * @param {string} filePath - absolute path to subagents.json.
 * @returns {Promise<{ ok: true, roles: Record<string, object>, exists: boolean } | { ok: false, error: string, exists: boolean }>}
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
    if (code === 'ENOENT') return { ok: true, roles: {}, exists: false };
    return { ok: false, error: `read-failed:${code ?? 'unknown'}`, exists: true };
  }
  if (text.trim() === '') return { ok: true, roles: {}, exists: true };
  try {
    const normalized = normalizeDocument(JSON.parse(text));
    if (!normalized.ok) return { ok: false, error: normalized.error, exists: true };
    return { ok: true, roles: normalized.roles, exists: true };
  } catch (error) {
    return { ok: false, error: `bad-json:${/** @type {Error} */ (error).message}`, exists: true };
  }
}

/**
 * Persist the fallback file atomically: temp write, `.bak` rotation, rename.
 *
 * @param {string} filePath - absolute path to subagents.json.
 * @param {Record<string, object>} roles - normalized role records keyed by name.
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
export async function writeConfig(filePath, roles) {
  const body = `${JSON.stringify({ roles }, null, 2)}\n`;
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
 * Create the store handle. All methods are async and never throw for storage
 * unavailability: failures surface through `storeInfo().error` and reads
 * degrade to an empty map.
 *
 * @param {object} [options]
 * @param {object | null} [options.storageDomain] - the Host facility, when already resolved.
 * @param {() => object | null} [options.resolveStorageDomain] - lazy resolver; retried
 *        briefly so a plugin that activates before the storage-domain form can
 *        still reach the unified storage.
 * @param {string} [options.fallbackPath] - plugin-owned JSON file path.
 * @param {(message: string) => void} [options.log] - diagnostic sink.
 * @param {Array<object>} [options.builtinRoles] - built-in roles merged under
 *        user records in `listRoles()`; pass `[]` to serve user records only
 *        (tests). Defaults to the shipped catalog.
 * @returns {object} store handle.
 */
/**
 * Normalize one raw model-pool entry.
 *
 * @param {unknown} raw - parsed JSON value for one pool entry.
 * @returns {{ ok: true, entry: object } | { ok: false, error: string }}
 */
export function normalizePoolModel(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'not-object' };
  }
  const source = /** @type {Record<string, unknown>} */ (raw);
  if (typeof source.provider !== 'string' || source.provider.trim() === ''
    || typeof source.model !== 'string' || source.model.trim() === '') {
    return { ok: false, error: 'bad-model' };
  }
  /** @type {Record<string, unknown>} */
  const entry = {
    provider: source.provider.trim(),
    model: source.model.trim(),
    enabled: source.enabled === undefined ? true : source.enabled === true,
  };
  for (const [field, code] of /** @type {Array<[string, string]>} */ ([['name', 'bad-name'], ['description', 'bad-description'], ['reasoningEffort', 'bad-effort']])) {
    if (source[field] !== undefined && source[field] !== null) {
      if (typeof source[field] !== 'string') return { ok: false, error: code };
      const text = /** @type {string} */ (source[field]).trim();
      if (text !== '') entry[field] = text;
    }
  }
  return { ok: true, entry };
}

export function createSubagentsStore(options = {}) {
  const fallbackPath = options.fallbackPath ?? defaultFallbackPath();
  const log = options.log ?? (() => {});
  const builtinRoles = options.builtinRoles ?? BUILTIN_ROLES;

  /** @type {{ kind: 'domain' | 'file' | 'unavailable', error: string | null }} */
  const state = { kind: 'unavailable', error: null };
  /** @type {any | null} */
  let domain = null;

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

  /** Open the primary backend. */
  async function init() {
    const storageDomain = await resolveFacility();
    if (storageDomain !== null && typeof storageDomain.open === 'function') {
      try {
        domain = await storageDomain.open(DOMAIN_SPEC);
        state.kind = 'domain';
        state.error = null;
      } catch (error) {
        domain = null;
        state.error = `domain-open-failed: ${error instanceof Error ? error.message : String(error)}`;
        log(`agents-manager: unified storage unavailable for subagent roles (${state.error}); falling back to ${fallbackPath}`);
      }
    } else {
      state.error = 'storage-domain-not-composed';
    }
    if (domain === null) state.kind = 'file';
  }

  /**
   * Read every model-pool entry as an array. Storage failures degrade to [].
   *
   * @returns {Promise<Array<object>>}
   */
  async function listPoolModels() {
    if (domain !== null) {
      try {
        return [...domain.table('models').entries()].map(([, value]) => value);
      } catch (error) {
        state.error = `domain-read-failed: ${error instanceof Error ? error.message : String(error)}`;
        return [];
      }
    }
    const read = await readConfig(fallbackPath);
    if (!read.ok) {
      state.error = read.error;
      return [];
    }
    return [];
  }

  /**
   * Persist one pool entry under its provider/model key.
   *
   * @param {string} key - `"<provider>/<model>"`.
   * @param {object} entry - normalized pool entry.
   * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
   */
  async function putPoolModel(key, entry) {
    if (domain !== null) {
      try {
        await domain.table('models').put(key, entry);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    return { ok: false, error: 'file-pool-unsupported' };
  }

  /**
   * Remove one pool entry.
   *
   * @param {string} key
   * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
   */
  async function removePoolModel(key) {
    if (domain !== null) {
      try {
        await domain.table('models').delete(key);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    return { ok: false, error: 'file-pool-unsupported' };
  }

  /**
   * Read the user's stored role records only, keyed by sanitized name (no
   * builtins merged). Storage failures degrade to an empty map recorded in
   * `storeInfo().error`.
   *
   * @returns {Promise<Record<string, object>>}
   */
  async function listUserRoles() {
    if (domain !== null) {
      try {
        return Object.fromEntries(domain.table('roles').entries());
      } catch (error) {
        state.error = `domain-read-failed: ${error instanceof Error ? error.message : String(error)}`;
        return {};
      }
    }
    const read = await readConfig(fallbackPath);
    if (!read.ok) {
      state.error = read.error;
      return {};
    }
    return read.roles;
  }

  /**
   * Read every effective role: the user's records with the plugin's built-in
   * roles merged in underneath. A user record with a builtin's name overrides
   * it wholesale; a tombstone record hides it. Storage failures degrade to
   * the builtins alone.
   *
   * @returns {Promise<Record<string, object>>}
   */
  async function listRoles() {
    return mergeBuiltinRoles(await listUserRoles(), builtinRoles);
  }

  /**
   * Persist one normalized role record.
   *
   * @param {string} name - sanitized role name.
   * @param {object} role - normalized record.
   * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
   */
  async function putRole(name, role) {
    if (domain !== null) {
      try {
        await domain.table('roles').put(name, role);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    const read = await readConfig(fallbackPath);
    const current = read.ok ? read.roles : {};
    return writeConfig(fallbackPath, { ...current, [name]: role });
  }

  /**
   * Remove one role.
   *
   * @param {string} name
   * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
   */
  async function removeRole(name) {
    if (domain !== null) {
      try {
        await domain.table('roles').delete(name);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    const read = await readConfig(fallbackPath);
    if (!read.ok || read.roles[name] === undefined) return { ok: false, error: 'not-found' };
    const next = { ...read.roles };
    delete next[name];
    return writeConfig(fallbackPath, next);
  }

  /** Store status for API responses. */
  function storeInfo() {
    return { kind: state.kind, fallbackPath, error: state.error };
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

  return { init, listRoles, listUserRoles, putRole, removeRole, listPoolModels, putPoolModel, removePoolModel, storeInfo, dispose };
}
