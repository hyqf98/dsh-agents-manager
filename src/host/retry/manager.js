/**
 * Provider retry-policy manager: reads and writes the built-in
 * `dsh-llm-retry` executor's policy configuration for each provider route.
 *
 * The policy lives in each provider adapter's own configuration:
 *  - `llm-pi-ai` namespace: `providers.<route>.retryPolicy`
 *  - `llm-deepseek` namespace: `retryPolicy`
 * Both are `.volatile()`, so a write through `ctx.settings.mutate` persists
 * into the profile patch and hot-reloads into the adapter on the next
 * request — no DSH restart. Validation mirrors the kernel's
 * `resolveRetryPolicy` (dsh-llm/lib/types/retry-policy.js) so a bad value is
 * rejected here with a local error instead of a plugin-load failure.
 *
 * @module
 */

/** Largest delay Node schedules without clamping (dsh-timeout parity). */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;
/** Failure codes the built-in normal mode retries on by default. */
export const DEFAULT_RETRYABLE_CODES = ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'];

/**
 * Display-level vendor labels: ordered keyword → label pairs scanned over each
 * model's id+name (first match wins per model). The order is the canonical
 * tie-breaker for `deriveVendors`; pure presentation: nothing in rule
 * matching or policy addressing changes — the kernel's retry granularity
 * stays the provider route.
 *
 * @type {Array<[string, string]>}
 */
export const VENDOR_KEYWORDS = [
  ['deepseek', 'DeepSeek'],
  ['glm', 'GLM'],
  ['zhipu', 'GLM'],
  ['bigmodel', 'GLM'],
  ['gpt', 'GPT'],
  ['codex', 'GPT'],
  ['claude', 'Claude'],
  ['anthropic', 'Claude'],
  ['kimi', 'Kimi'],
  ['moonshot', 'Kimi'],
  ['gemini', 'Gemini'],
  ['qwen', 'Qwen'],
  ['minimax', 'MiniMax'],
  ['grok', 'Grok'],
];

/**
 * Derive the vendor labels one provider route's model catalog covers —
 * dominant vendors only: each model contributes its first keyword hit, and a
 * label survives when its model count reaches a third of the route's top
 * vendor (so a lone stray model never prefixes the card title). Survivors
 * sort by model count descending, ties keep the canonical keyword order.
 * Unknown models (no keyword hit) contribute nothing rather than noise.
 *
 * @param {Array<unknown>} models - catalog entries (`{ id, name? }` or strings).
 * @returns {Array<string>} dominant vendor labels, most models first.
 */
export function deriveVendors(models) {
  /** @type {Array<string>} */
  const haystacks = [];
  for (const model of Array.isArray(models) ? models : []) {
    const id = typeof model === 'string' ? model : String(model?.id ?? '');
    const name = typeof model === 'string' ? '' : String(model?.name ?? '');
    if (id !== '' || name !== '') haystacks.push(`${id} ${name}`.toLowerCase());
  }
  /** @type {Map<string, number>} label → matched-model count. */
  const counts = new Map();
  /** @type {Map<string, number>} label → first matching keyword index (canonical order). */
  const canonical = new Map();
  for (const text of haystacks) {
    for (let index = 0; index < VENDOR_KEYWORDS.length; index += 1) {
      const [keyword, label] = VENDOR_KEYWORDS[index];
      if (!text.includes(keyword)) continue;
      if (!canonical.has(label)) canonical.set(label, index);
      counts.set(label, (counts.get(label) ?? 0) + 1);
      break; // one vendor per model
    }
  }
  const top = Math.max(0, ...counts.values());
  const floor = Math.max(1, Math.ceil(top / 3));
  return [...counts.entries()]
    .filter(([, count]) => count >= floor)
    .sort((a, b) => (b[1] - a[1]) || ((canonical.get(a[0]) ?? 0) - (canonical.get(b[0]) ?? 0)))
    .map(([label]) => label);
}

/** Default TTL for the per-provider model-catalog cache (settings poll guard). */
const DEFAULT_MODEL_CACHE_TTL_MS = 10_000;
/** Module-level default cache for vendor derivation. */
const modelCatalogCache = new Map();

/**
 * List a provider's models through a tiny TTL cache so the settings page's 5s
 * polling loop does not re-read every catalog on every tick. Any failure (or a
 * missing listModels) degrades to the last cached value or an empty list.
 *
 * @param {object} llm
 * @param {string} providerId
 * @param {{ cache?: Map<string, {at: number, models: Array<object>}>, ttlMs?: number, now?: () => number }} [options]
 * @returns {Promise<Array<object>>}
 */
async function cachedModels(llm, providerId, options = {}) {
  const cache = options.cache ?? modelCatalogCache;
  const ttlMs = options.ttlMs ?? DEFAULT_MODEL_CACHE_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const hit = cache.get(providerId);
  if (hit !== undefined && now() - hit.at < ttlMs) return hit.models;
  try {
    const models = await llm.listModels(providerId);
    const list = Array.isArray(models) ? models : [];
    cache.set(providerId, { at: now(), models: list });
    return list;
  } catch {
    return hit !== undefined ? hit.models : [];
  }
}

/**
 * Validate one retryPolicy value against the kernel's grammar.
 *
 * @param {unknown} raw
 * @returns {{ ok: true, policy: object } | { ok: false, error: string }}
 */
export function validateRetryPolicy(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'not-object' };
  }
  const source = /** @type {Record<string, unknown>} */ (raw);
  const mode = source.mode === undefined ? 'normal' : source.mode;
  if (mode !== 'normal' && mode !== 'always') return { ok: false, error: 'bad-mode' };

  const allowed = new Set(mode === 'normal'
    ? ['mode', 'maxRetries', 'retryableCodes', 'backoff']
    : ['mode', 'backoff']);
  for (const key of Object.keys(source)) {
    if (!allowed.has(key)) return { ok: false, error: `unknown-key:${key}` };
  }

  /** @type {Record<string, unknown>} */
  const policy = { mode };

  if (mode === 'normal') {
    if (source.maxRetries !== undefined) {
      if (!Number.isSafeInteger(source.maxRetries) || source.maxRetries < 0) {
        return { ok: false, error: 'bad-max-retries' };
      }
      policy.maxRetries = source.maxRetries;
    }
    if (source.retryableCodes !== undefined) {
      if (!Array.isArray(source.retryableCodes) || source.retryableCodes.length === 0) {
        return { ok: false, error: 'bad-retryable-codes' };
      }
      if (source.retryableCodes.some((code) => typeof code !== 'string' || code === '')) {
        return { ok: false, error: 'bad-retryable-codes' };
      }
      if (new Set(source.retryableCodes).size !== source.retryableCodes.length) {
        return { ok: false, error: 'duplicate-codes' };
      }
      policy.retryableCodes = [...source.retryableCodes];
    }
  }

  if (source.backoff !== undefined) {
    const backoff = source.backoff;
    if (backoff === null || typeof backoff !== 'object' || Array.isArray(backoff)) {
      return { ok: false, error: 'bad-backoff' };
    }
    const b = /** @type {Record<string, unknown>} */ (backoff);
    const initial = b.initialDelayMs === undefined ? 500 : b.initialDelayMs;
    const max = b.maxDelayMs === undefined ? 10000 : b.maxDelayMs;
    const jitter = b.jitterRatio === undefined ? 0.1 : b.jitterRatio;
    for (const [name, value] of [['initialDelayMs', initial], ['maxDelayMs', max]]) {
      if (!Number.isFinite(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
        return { ok: false, error: `bad-${name}` };
      }
    }
    if (initial > max) return { ok: false, error: 'initial-gt-max' };
    if (!Number.isFinite(jitter) || jitter < 0 || jitter > 1) {
      return { ok: false, error: 'bad-jitter' };
    }
    policy.backoff = { initialDelayMs: initial, maxDelayMs: max, jitterRatio: jitter };
  }
  return { ok: true, policy };
}

/**
 * List every retry target: registered providers joined with their settings
 * address, currently effective policy, and the vendor labels their model
 * catalog covers (display-level derivation, best-effort).
 *
 * @param {object} ctx - host context carrying `llm` (optional).
 * @param {{ cache?: Map<string, {at: number, models: Array<object>}>, ttlMs?: number, now?: () => number }} [options]
 * @returns {Promise<Array<{ provider: string, displayName: string, vendors: Array<string>, modelCount: number, settingsNs: string | null, settingsPath: Array<string>, editable: boolean, policy: object | null }>>}
 */
export async function listRetryTargets(ctx, options = {}) {
  const llm = typeof ctx.get === 'function' ? ctx.get('llm') : ctx?.llm;
  if (llm === undefined || llm === null || typeof llm.listProviders !== 'function') return [];
  /** @type {Map<string, { provider: string, displayName: string, settingsNs: string | null, settingsPath: Array<string> }>} */
  const directory = new Map();
  try {
    for (const entry of llm.listConfigurableProviders()) {
      directory.set(entry.provider, {
        provider: entry.provider,
        displayName: entry.displayName ?? entry.provider,
        settingsNs: entry.settingsNs ?? null,
        settingsPath: [...(entry.settingsPath ?? [])],
      });
    }
  } catch { /* a composition without the directory still lists providers */ }
  /** @type {Array<object>} */
  const targets = [];
  for (const info of llm.listProviders()) {
    const known = directory.get(info.id);
    let policy = null;
    try {
      policy = llm.providerRetryPolicy(info.id) ?? null;
    } catch { /* route without a policy keeps the defaults view */ }
    /** @type {Array<object>} */ let models = [];
    if (typeof llm.listModels === 'function') {
      models = await cachedModels(llm, info.id, options);
    }
    targets.push({
      provider: info.id,
      displayName: info.name ?? info.id,
      vendors: deriveVendors(models),
      modelCount: models.length,
      settingsNs: known?.settingsNs ?? null,
      settingsPath: known?.settingsPath ?? [],
      editable: known?.settingsNs != null,
      policy,
    });
  }
  return targets;
}

/**
 * Write one provider's retryPolicy through the settings service (hot reload).
 *
 * @param {object} ctx - host context carrying `llm` and `settings`.
 * @param {string} provider - provider route id.
 * @param {object} policy - validated retryPolicy value.
 * @returns {Promise<{ ok: true } | { ok: false, error: string, code?: string }>}
 */
export async function writeRetryPolicy(ctx, provider, policy) {
  const llm = typeof ctx.get === 'function' ? ctx.get('llm') : ctx?.llm;
  if (llm === undefined || llm === null) return { ok: false, error: 'llm-unavailable' };
  const settings = typeof ctx.get === 'function' ? ctx.get('settings') : ctx?.settings;
  if (settings === undefined || settings === null || typeof settings.mutate !== 'function') {
    return { ok: false, error: 'settings-unavailable' };
  }
  /** @type {{ settingsNs: string | null, settingsPath: Array<string> }} */
  let address = { settingsNs: null, settingsPath: [] };
  try {
    for (const entry of llm.listConfigurableProviders()) {
      if (entry.provider === provider) {
        address = { settingsNs: entry.settingsNs ?? null, settingsPath: [...(entry.settingsPath ?? [])] };
        break;
      }
    }
  } catch { /* fall through with the empty address */ }
  if (address.settingsNs === null) return { ok: false, error: 'not-configurable' };

  let revision;
  try {
    const descriptor = settings.describe().find((row) => row.ns === address.settingsNs);
    revision = descriptor?.revision;
  } catch { /* a settings service without describe writes without the guard */ }
  try {
    await settings.mutate(address.settingsNs, [
      { op: 'set', path: [...address.settingsPath, 'retryPolicy'], value: policy },
    ], revision);
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error?.code === 'SETTINGS_CONFLICT' || /changed since it was read/i.test(message)) {
      return { ok: false, error: 'conflict', code: 'conflict' };
    }
    return { ok: false, error: message };
  }
}

/**
 * Reset one provider's retryPolicy to its inherited/default value.
 *
 * @param {object} ctx - host context.
 * @param {string} provider - provider route id.
 * @returns {Promise<{ ok: true } | { ok: false, error: string, code?: string }>}
 */
export async function resetRetryPolicy(ctx, provider) {
  const llm = typeof ctx.get === 'function' ? ctx.get('llm') : ctx?.llm;
  if (llm === undefined || llm === null) return { ok: false, error: 'llm-unavailable' };
  const settings = typeof ctx.get === 'function' ? ctx.get('settings') : ctx?.settings;
  if (settings === undefined || settings === null || typeof settings.mutate !== 'function') {
    return { ok: false, error: 'settings-unavailable' };
  }
  /** @type {{ settingsNs: string | null, settingsPath: Array<string> }} */
  let address = { settingsNs: null, settingsPath: [] };
  try {
    for (const entry of llm.listConfigurableProviders()) {
      if (entry.provider === provider) {
        address = { settingsNs: entry.settingsNs ?? null, settingsPath: [...(entry.settingsPath ?? [])] };
        break;
      }
    }
  } catch { /* fall through */ }
  if (address.settingsNs === null) return { ok: false, error: 'not-configurable' };

  let revision;
  try {
    const descriptor = settings.describe().find((row) => row.ns === address.settingsNs);
    revision = descriptor?.revision;
  } catch { /* unguarded write */ }
  try {
    await settings.mutate(address.settingsNs, [
      { op: 'unset', path: [...address.settingsPath, 'retryPolicy'] },
    ], revision);
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error?.code === 'SETTINGS_CONFLICT' || /changed since it was read/i.test(message)) {
      return { ok: false, error: 'conflict', code: 'conflict' };
    }
    return { ok: false, error: message };
  }
}
