/**
 * One-click MCP sync from other coding agents: locate and parse the MCP
 * configuration of Claude Code, Codex, zcode, and Cursor on this machine.
 *
 * Paths resolve from the OS home directory, so detection works on macOS,
 * Linux, and Windows alike. Parsing is read-only; nothing is written back to
 * any of these files.
 *
 * @module
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeServer, NAME_PATTERN } from './config.js';

/** Safe server-name form: replace contract-invalid characters, trim dashes. */
function safeName(name) {
  const cleaned = String(name).replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.slice(0, 32);
}

/** Read and parse one JSON file; returns { ok, value } | { ok: false, error }. */
async function readJson(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, error: 'missing' };
    return { ok: false, error: `read-failed:${code ?? 'unknown'}` };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: `bad-json:${/** @type {Error} */ (error).message}` };
  }
}

/**
 * Turn one raw server map into conflict-marked import entries.
 *
 * @param {Record<string, unknown>} rawServers - agent-specific server map.
 * @param {Record<string, object>} known - servers already in our store.
 * @returns {Array<{ name: string, server: object, issue: string | null }>}
 */
function toEntries(rawServers, known) {
  const seen = new Set();
  return Object.entries(rawServers ?? {}).map(([rawName, raw]) => {
    const name = safeName(rawName);
    const normalized = normalizeServer(raw);
    if (!normalized.ok) {
      return { name: name || rawName, server: /** @type {object} */ (raw), issue: normalized.error };
    }
    if (!NAME_PATTERN.test(name) || name === '') {
      return { name: name || rawName, server: normalized.server, issue: 'bad-name' };
    }
    if (seen.has(name) || known[name] !== undefined) {
      return { name, server: normalized.server, issue: 'name-exists' };
    }
    seen.add(name);
    return { name, server: normalized.server, issue: null };
  });
}

/** MCP servers of Claude Code: global `mcpServers` in ~/.claude.json. */
async function readClaude(path, known) {
  const read = await readJson(path);
  if (!read.ok) return { entries: [], error: read.error === 'missing' ? null : read.error };
  const servers = read.value?.mcpServers;
  if (servers === undefined || typeof servers !== 'object') return { entries: [], error: null };
  return { entries: toEntries(servers, known), error: null };
}

/** MCP servers of zcode: `mcp.servers` in ~/.zcode/cli/config.json. */
async function readZcode(path, known) {
  const read = await readJson(path);
  if (!read.ok) return { entries: [], error: read.error === 'missing' ? null : read.error };
  const servers = read.value?.mcp?.servers;
  if (servers === undefined || typeof servers !== 'object') return { entries: [], error: null };
  return { entries: toEntries(servers, known), error: null };
}

/** MCP servers of Cursor: `mcpServers` in ~/.cursor/mcp.json. */
async function readCursor(path, known) {
  const read = await readJson(path);
  if (!read.ok) return { entries: [], error: read.error === 'missing' ? null : read.error };
  const servers = read.value?.mcpServers;
  if (servers === undefined || typeof servers !== 'object') return { entries: [], error: null };
  return { entries: toEntries(servers, known), error: null };
}

/**
 * Parse the subset of TOML Codex uses for MCP servers: `[mcp_servers.name]`
 * tables whose values are strings, arrays of strings, and inline tables.
 *
 * @param {string} text - raw config.toml content.
 * @returns {Record<string, object>} raw server configs keyed by name.
 */
export function parseCodexToml(text) {
  /** @type {Record<string, Record<string, unknown>>} */
  const tables = {};
  /** @type {Record<string, unknown> | null} */
  let current = null;
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const header = /^\[\[?([^\]]+)\]?\]$/.exec(line);
    if (header !== null) {
      const path = header[1].trim();
      const parts = path.split('.').map((part) => part.trim().replace(/^["']|["']$/g, ''));
      if (parts.length === 2 && parts[0] === 'mcp_servers') {
        current = {};
        tables[parts[1]] = current;
      } else {
        current = null;
      }
      continue;
    }
    if (current === null) continue;
    const pair = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (pair === null) continue;
    current[pair[1]] = parseTomlValue(pair[2].trim());
  }
  return tables;
}

/** Parse one TOML scalar/array/inline-table value as it appears in Codex configs. */
function parseTomlValue(text) {
  if (text.startsWith('"') || text.startsWith("'")) {
    const body = text.slice(1, text.length - 1);
    return text.startsWith('"') ? body.replace(/\\"/g, '"') : body;
  }
  if (text.startsWith('[')) {
    const inner = text.slice(1, text.lastIndexOf(']'));
    return inner.split(',').map((item) => item.trim()).filter((item) => item !== '')
      .map((item) => String(parseTomlValue(item)));
  }
  if (text.startsWith('{')) {
    const inner = text.slice(1, text.lastIndexOf('}'));
    const out = {};
    for (const part of splitTopLevel(inner)) {
      const pair = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(part.trim());
      if (pair !== null) out[pair[1]] = parseTomlValue(pair[2].trim());
    }
    return out;
  }
  if (text === 'true' || text === 'false') return text === 'true';
  const asNumber = Number(text);
  return Number.isFinite(asNumber) && text !== '' ? asNumber : text;
}

/** Split "a = 1, b = 2" on top-level commas only (respecting quotes/brackets). */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let quote = '';
  let current = '';
  for (const ch of text) {
    if (quote !== '') {
      current += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '[' || ch === '{') depth += 1;
    if (ch === ']' || ch === '}') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim() !== '') parts.push(current);
  return parts;
}

/** MCP servers of Codex: `[mcp_servers.*]` tables in ~/.codex/config.toml. */
async function readCodex(path, known) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    return { entries: [], error: code === 'ENOENT' || code === 'ENOTDIR' ? null : `read-failed:${code ?? 'unknown'}` };
  }
  const tables = parseCodexToml(text);
  if (Object.keys(tables).length === 0) return { entries: [], error: null };
  // Codex stdio env values may reference environment variables by name; keep
  // them verbatim as strings — the store treats unknown keys as literals.
  return { entries: toEntries(tables, known), error: null };
}

/**
 * Detect every known agent config under one home directory and parse its MCP
 * servers. Sources are returned in a stable order regardless of existence.
 *
 * @param {object} [options]
 * @param {string} [options.home] - home directory; defaults to os.homedir().
 * @param {() => Promise<Record<string, object>>} [options.knownServers] - current store snapshot.
 * @returns {Promise<Array<{ id: string, label: string, path: string, exists: boolean, error: string | null, entries: Array<object> }>>}
 */
export async function detectAgentSources(options = {}) {
  const home = options.home ?? (await import('node:os')).homedir();
  const known = options.knownServers ? await options.knownServers() : {};
  const readers = [
    { id: 'claude-code', label: 'Claude Code', path: join(home, '.claude.json'), read: readClaude },
    { id: 'codex', label: 'Codex', path: join(home, '.codex', 'config.toml'), read: readCodex },
    { id: 'zcode', label: 'zcode', path: join(home, '.zcode', 'cli', 'config.json'), read: readZcode },
    { id: 'cursor', label: 'Cursor', path: join(home, '.cursor', 'mcp.json'), read: readCursor },
  ];
  return Promise.all(readers.map(async (reader) => {
    const result = await reader.read(reader.path, known);
    const exists = result.entries.length > 0 || (await fileExists(reader.path));
    return {
      id: reader.id,
      label: reader.label,
      path: reader.path,
      exists,
      error: result.error !== null && result.error !== 'missing' ? result.error : null,
      entries: result.entries,
    };
  }));
}

/** Best-effort existence probe that never throws. */
async function fileExists(path) {
  const { stat } = await import('node:fs/promises');
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
