/**
 * ~/.agents/mcp.json store: read, validate, write, and pasted-config parsing.
 *
 * The file format is compatible with the common `mcpServers` JSON shape used by
 * Claude Code / Cursor, plus an explicit `transport` field and an `enabled`
 * switch owned by this plugin. All functions here are dependency-free except
 * node:fs/promises and node:crypto, so tests can drive them against temp dirs.
 *
 * @module
 */
import { readFile, writeFile, rename, mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

/** Server-name contract shared with dsh-mcp-client. */
export const NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
/** Largest accepted config file, in bytes. */
export const MAX_CONFIG_BYTES = 512 * 1024;
/** Default per-call timeout (milliseconds) when the config omits one. */
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000;

/**
 * Normalize one raw server entry into this plugin's canonical record.
 *
 * Transport is inferred when absent: a `command` means stdio, a `url` means
 * streamable-http, and an explicit `transport`/`type` field wins. Returns
 * `{ ok: true, server }` or `{ ok: false, error }` with a stable error code.
 *
 * @param {unknown} raw - parsed JSON value for one server.
 * @returns {{ ok: true, server: object } | { ok: false, error: string }}
 */
export function normalizeServer(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'not-object' };
  }
  const source = /** @type {Record<string, unknown>} */ (raw);
  const declared = typeof source.transport === 'string' ? source.transport
    : typeof source.type === 'string' ? source.type : '';
  let transport = declared.trim().toLowerCase();
  if (transport === 'http' || transport === 'https' || transport === 'streamable_http' || transport === 'streamable-http'
    // Legacy SSE endpoints and vendor "remote" types are addressed over HTTP;
    // the modern client negotiates what the server actually speaks.
    || transport === 'sse' || transport === 'remote') {
    transport = 'streamable-http';
  }
  if (transport !== 'stdio' && transport !== 'streamable-http') {
    if (typeof source.command === 'string' && source.command !== '') transport = 'stdio';
    else if (typeof source.url === 'string' && source.url !== '') transport = 'streamable-http';
    else return { ok: false, error: 'unknown-transport' };
  }
  /** @type {Record<string, unknown>} */
  const server = { transport };
  if (transport === 'stdio') {
    if (typeof source.command !== 'string' || source.command.trim() === '') {
      return { ok: false, error: 'missing-command' };
    }
    server.command = source.command;
    if (source.args !== undefined) {
      if (!Array.isArray(source.args) || source.args.some((item) => typeof item !== 'string')) {
        return { ok: false, error: 'bad-args' };
      }
      server.args = source.args;
    }
    if (source.env !== undefined) {
      const env = normalizeStringMap(source.env);
      if (env === null) return { ok: false, error: 'bad-env' };
      server.env = env;
    }
    if (source.cwd !== undefined) {
      if (typeof source.cwd !== 'string') return { ok: false, error: 'bad-cwd' };
      server.cwd = source.cwd;
    }
  } else {
    if (typeof source.url !== 'string' || !/^https?:\/\//i.test(source.url)) {
      return { ok: false, error: 'bad-url' };
    }
    server.url = source.url;
    if (source.headers !== undefined) {
      const headers = normalizeStringMap(source.headers);
      if (headers === null) return { ok: false, error: 'bad-headers' };
      server.headers = headers;
    }
  }
  if (source.toolCallTimeoutMs !== undefined && source.toolCallTimeoutMs !== null
    || source.timeoutMs !== undefined && source.timeoutMs !== null) {
    const value = Number(source.toolCallTimeoutMs ?? source.timeoutMs);
    if (!Number.isInteger(value) || value < 1_000 || value > 600_000) {
      return { ok: false, error: 'bad-timeout' };
    }
    server.toolCallTimeoutMs = value;
  }
  // User-authored note describing what this server is for; surfaced to the AI
  // through the tool descriptions (see supervisor.definitionsFor) and to the
  // UI on cards, the import dialog, and the session chip.
  if (typeof source.description === 'string' && source.description.trim() !== '') {
    const description = source.description.trim().slice(0, 500);
    if (description !== '') server.description = description;
  }
  server.enabled = source.enabled === undefined ? true : source.enabled === true;
  return { ok: true, server };
}

/**
 * Accept only plain string→string maps for env/headers.
 *
 * @param {unknown} raw - parsed JSON value.
 * @returns {Record<string, string> | null}
 */
function normalizeStringMap(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, value] of Object.entries(/** @type {Record<string, unknown>} */ (raw))) {
    if (typeof value !== 'string') return null;
    out[key] = value;
  }
  return out;
}

/**
 * Validate the full parsed config document and normalize every server entry.
 *
 * @param {unknown} parsed - parsed JSON value of the whole file.
 * @returns {{ ok: true, servers: Record<string, object> } | { ok: false, error: string, index?: number }}
 */
export function normalizeDocument(parsed) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'not-object' };
  }
  const doc = /** @type {Record<string, unknown>} */ (parsed);
  const rawServers = doc.mcpServers ?? doc;
  if (rawServers === null || typeof rawServers !== 'object' || Array.isArray(rawServers)) {
    return { ok: false, error: 'bad-mcpServers' };
  }
  /** @type {Record<string, object>} */
  const servers = {};
  let index = 0;
  for (const [name, raw] of Object.entries(/** @type {Record<string, unknown>} */ (rawServers))) {
    if (!NAME_PATTERN.test(name)) return { ok: false, error: 'bad-name', index };
    const normalized = normalizeServer(raw);
    if (!normalized.ok) return { ok: false, error: normalized.error, index };
    servers[name] = normalized.server;
    index += 1;
  }
  return { ok: true, servers };
}

/**
 * Read and validate the config file. A missing file is an empty store, not an
 * error; an unreadable or malformed file is surfaced so the UI can warn.
 *
 * @param {string} filePath - absolute path to mcp.json.
 * @returns {Promise<{ ok: true, servers: Record<string, object>, exists: boolean } | { ok: false, error: string, exists: boolean }>}
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
    if (code === 'ENOENT') return { ok: true, servers: {}, exists: false };
    return { ok: false, error: `read-failed:${code ?? 'unknown'}`, exists: true };
  }
  if (text.trim() === '') return { ok: true, servers: {}, exists: true };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `bad-json:${/** @type {Error} */ (error).message}`, exists: true };
  }
  const normalized = normalizeDocument(parsed);
  if (!normalized.ok) return { ok: false, error: normalized.error, exists: true };
  return { ok: true, servers: normalized.servers, exists: true };
}

/**
 * Persist the config atomically: write a temp file, rotate the previous file to
 * `mcp.json.bak`, then move the temp file into place.
 *
 * @param {string} filePath - absolute path to mcp.json.
 * @param {Record<string, object>} servers - normalized server records keyed by name.
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
export async function writeConfig(filePath, servers) {
  const body = `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`;
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
 * Parse pasted text into candidate servers. Accepted shapes:
 *  - `{"mcpServers": {...}}` (standard)
 *  - `{"servers": {...}}`
 *  - a bare map `{name: {...}}` with at least one entry that looks like a server
 *  - a single server object (with or without a `name` field)
 *  - an array of server objects (each with `name`)
 *
 * @param {string} text - pasted raw text.
 * @returns {{ ok: true, entries: Array<{ name: string, server: object, issue: string | null }> } | { ok: false, error: string }}
 */
export function parsePasted(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: /** @type {Error} */ (error).message };
  }
  /** @type {Array<{ name: string, raw: unknown }>} */
  let candidates = [];
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      const name = item && typeof item === 'object' && typeof /** @type {any} */ (item).name === 'string'
        ? /** @type {any} */ (item).name : '';
      candidates.push({ name, raw: item });
    }
  } else if (parsed !== null && typeof parsed === 'object') {
    const doc = /** @type {Record<string, unknown>} */ (parsed);
    const wrapped = doc.mcpServers ?? doc.servers;
    if (wrapped !== undefined && wrapped !== null && typeof wrapped === 'object' && !Array.isArray(wrapped)) {
      candidates = Object.entries(/** @type {Record<string, unknown>} */ (wrapped))
        .map(([name, raw]) => ({ name, raw }));
    } else if (typeof doc.command === 'string' || typeof doc.url === 'string') {
      const name = typeof doc.name === 'string' ? doc.name : '';
      candidates = [{ name, raw: doc }];
    } else {
      // Bare map of servers: every value must carry a transport hint.
      const entries = Object.entries(doc);
      if (entries.length > 0 && entries.every(([, raw]) => raw !== null && typeof raw === 'object'
        && (typeof (/** @type {any} */ (raw).command) === 'string' || typeof (/** @type {any} */ (raw).url) === 'string'))) {
        candidates = entries.map(([name, raw]) => ({ name, raw }));
      } else {
        return { ok: false, error: 'unrecognized-shape' };
      }
    }
  } else {
    return { ok: false, error: 'unrecognized-shape' };
  }
  if (candidates.length === 0) return { ok: false, error: 'empty' };
  const entries = candidates.map(({ name, raw }) => {
    const normalized = normalizeServer(raw);
    if (!normalized.ok) {
      return { name: name || '(unnamed)', server: /** @type {object} */ (raw), issue: normalized.error };
    }
    const finalName = name || (typeof (/** @type {any} */ (raw).serverName) === 'string' ? /** @type {any} */ (raw).serverName : '');
    if (!NAME_PATTERN.test(finalName)) {
      return { name: finalName || '(unnamed)', server: normalized.server, issue: 'bad-name' };
    }
    return { name: finalName, server: normalized.server, issue: null };
  });
  return { ok: true, entries };
}

/**
 * Model-facing tool name for one MCP tool, following the pinned dsh-mcp-client
 * contract: `mcp__<serverName>__<rawName>`, non-`[A-Za-z0-9_-]` replaced with
 * `_`, truncated to 64 chars, with a 12-hex sha256 identity suffix appended
 * whenever normalization was lossy.
 *
 * @param {string} serverName - normalized server namespace.
 * @param {string} rawName - the server's own tool name.
 * @returns {string}
 */
export function publicToolName(serverName, rawName) {
  const joined = `mcp__${serverName}__${rawName}`;
  const normalized = joined.replace(/[^A-Za-z0-9_-]/g, '_');
  const MAX = 64;
  if (normalized === joined && normalized.length <= MAX) return normalized;
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, 12);
  return `${normalized.slice(0, MAX - 12 - 1)}_${hash}`;
}

/**
 * Scrub a parent environment the way dsh spawns MCP stdio children: drop
 * credential-shaped names (`/KEY|PASSWORD|SECRET|TOKEN/i`), `DSH_*`, and the
 * harness's `NODE_USE_ENV_PROXY` injection, then merge the explicit server
 * env on top.
 *
 * `NODE_USE_ENV_PROXY=1` is what dsh-http-proxy's `proxyEnvironmentForChild`
 * adds to every spawned child while a proxy policy is active: it makes each
 * Node child's own `fetch()` honor the proxy environment. For an MCP server
 * that reaches intranet hosts the proxy cannot route, that silently breaks
 * connections (a machine proxy resolves/routes the intranet from its own
 * position). MCP servers that want a proxy follow the plain proxy variables
 * themselves, so the flag is dropped here; a server opts back in by setting
 * `NODE_USE_ENV_PROXY` explicitly in its env config.
 *
 * @param {NodeJS.ProcessEnv} parentEnv - ambient environment.
 * @param {Record<string, string> | undefined} extra - configured env for the server.
 * @returns {Record<string, string>}
 */
export function buildChildEnv(parentEnv, extra) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (typeof value !== 'string') continue;
    if (/KEY|PASSWORD|SECRET|TOKEN/i.test(key)) continue;
    if (key.startsWith('DSH_')) continue;
    if (key === 'NODE_USE_ENV_PROXY') continue;
    out[key] = value;
  }
  return { ...out, ...(extra ?? {}) };
}
