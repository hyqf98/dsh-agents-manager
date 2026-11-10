/**
 * One-click MCP sync from other coding agents and AI desktop apps: locate and
 * parse the MCP configuration of Claude Code, Claude Desktop, Codex, zcode,
 * Cursor, opencode, Gemini CLI, Qwen Code, MiMo Code, Windsurf, VS Code,
 * Cline, and Trae on this machine.
 *
 * Paths resolve from the OS home directory with per-platform layouts
 * (~/.config vs ~/Library/Application Support vs %APPDATA%), so detection
 * works on macOS, Linux, and Windows alike. Parsing is read-only; nothing is
 * written back to any of these files.
 *
 * @module
 */
import { readFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
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

/**
 * Strip JSONC noise (// and /* comments, trailing commas) that some agents
 * (opencode .jsonc, MiMo Code mimocode.jsonc, VS Code mcp.json) allow in
 * otherwise-JSON files. Conservative: never touches content inside strings.
 *
 * @param {string} text - raw file content.
 * @returns {string} JSON-parseable text.
 */
function stripJsonc(text) {
  let out = '';
  let quote = '';
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (quote !== '') {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i += 1;
      i -= 1; // let the loop re-read the newline
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i + 1 < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 1; // skip past the closing slash
      continue;
    }
    out += ch;
  }
  // Trailing commas before } or ] (tolerated by JSONC, illegal in JSON).
  return out.replace(/,([\s\r\n]*[}\]])/g, '$1');
}

/** Read and parse one JSON or JSONC file; comment-tolerant. */
async function readJsonTolerant(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, error: 'missing' };
    return { ok: false, error: `read-failed:${code ?? 'unknown'}` };
  }
  try {
    return { ok: true, value: JSON.parse(stripJsonc(text)) };
  } catch (error) {
    return { ok: false, error: `bad-json:${/** @type {Error} */ (error).message}` };
  }
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
 * MCP servers of opencode (~/.config/opencode/opencode.json[c]): the `mcp`
 * object with local (`type: "local"`, `command` array, `environment`) and
 * remote (`type: "remote"`, `url`, `headers`) shapes.
 */
async function readOpencode(path, known) {
  const read = await readJsonTolerant(path);
  if (!read.ok) return { entries: [], error: read.error === 'missing' ? null : read.error };
  const servers = read.value?.mcp;
  if (servers === undefined || typeof servers !== 'object' || Array.isArray(servers)) return { entries: [], error: null };
  const converted = {};
  for (const [name, raw] of Object.entries(servers)) {
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
      const map = /** @type {Record<string, unknown>} */ (raw);
      if (Array.isArray(map.command)) {
        // [cmd, ...args] → command string + args; environment → env.
        const [command, ...args] = map.command.map(String);
        converted[name] = {
          command,
          ...(args.length > 0 ? { args } : {}),
          ...(map.environment !== undefined && map.environment !== null && typeof map.environment === 'object' ? { env: map.environment } : {}),
        };
        continue;
      }
    }
    converted[name] = raw; // remote: url/headers already our shape
  }
  return { entries: toEntries(converted, known), error: null };
}

/**
 * MCP servers of Gemini CLI (~/.gemini/settings.json): `mcpServers` with
 * stdio (`command` string + `args`) and http (`url` / `httpUrl`).
 */
async function readGemini(path, known) {
  const read = await readJsonTolerant(path);
  if (!read.ok) return { entries: [], error: read.error === 'missing' ? null : read.error };
  const servers = read.value?.mcpServers;
  if (servers === undefined || typeof servers !== 'object') return { entries: [], error: null };
  // Gemini http servers may spell the endpoint `httpUrl`/`httpUrlToJson`; our
  // normalizeServer only knows `url`, so alias before entry conversion.
  const aliased = {};
  for (const [name, raw] of Object.entries(servers)) {
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
      const map = /** @type {Record<string, unknown>} */ (raw);
      if (typeof map.url !== 'string' && typeof map.httpUrl === 'string') {
        aliased[name] = { ...map, url: map.httpUrl };
        continue;
      }
    }
    aliased[name] = raw;
  }
  return { entries: toEntries(aliased, known), error: null };
}

/** MCP servers of Qwen Code (~/.qwen/settings.json): `mcpServers`, Claude shape. */
async function readQwen(path, known) {
  const read = await readJsonTolerant(path);
  if (!read.ok) return { entries: [], error: read.error === 'missing' ? null : read.error };
  const servers = read.value?.mcpServers;
  if (servers === undefined || typeof servers !== 'object') return { entries: [], error: null };
  return { entries: toEntries(servers, known), error: null };
}

/**
 * MCP servers of MiMo Code (~/.config/mimocode/mimocode.json[c]): the `mcp`
 * object with `type: "local"` (`command` array + `environment`) and
 * `type: "remote"` (`url` + `headers`).
 */
async function readMimo(path, known) {
  const read = await readJsonTolerant(path);
  if (!read.ok) return { entries: [], error: read.error === 'missing' ? null : read.error };
  const servers = read.value?.mcp;
  if (servers === undefined || typeof servers !== 'object' || Array.isArray(servers)) return { entries: [], error: null };
  const converted = {};
  for (const [name, raw] of Object.entries(servers)) {
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
      const map = /** @type {Record<string, unknown>} */ (raw);
      if (map.type === 'local' && Array.isArray(map.command)) {
        // [cmd, ...args] → command string + args; environment → env.
        const [command, ...args] = map.command.map(String);
        converted[name] = {
          command,
          ...(args.length > 0 ? { args } : {}),
          ...(map.environment !== undefined && map.environment !== null && typeof map.environment === 'object' ? { env: map.environment } : {}),
        };
        continue;
      }
      if (map.type === 'local' && typeof map.command === 'string') {
        converted[name] = {
          command: map.command,
          ...(map.environment !== undefined && map.environment !== null && typeof map.environment === 'object' ? { env: map.environment } : {}),
        };
        continue;
      }
    }
    converted[name] = raw; // remote/others: url/headers already our shape
  }
  return { entries: toEntries(converted, known), error: null };
}

/**
 * MCP servers of VS Code (user mcp.json) and Trae (~/.config/Trae/mcp.json):
 * `servers` with `type: "stdio"` (`command` string + `args`) and
 * `type: "http"` (`url`); also accepts Claude-shaped `mcpServers`.
 */
async function readVscode(path, known) {
  const read = await readJsonTolerant(path);
  if (!read.ok) return { entries: [], error: read.error === 'missing' ? null : read.error };
  const raw = read.value?.servers ?? read.value?.mcpServers;
  if (raw === undefined || typeof raw !== 'object') return { entries: [], error: null };
  const converted = {};
  for (const [name, entry] of Object.entries(raw)) {
    if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
      const map = /** @type {Record<string, unknown>} */ (entry);
      // VS Code http servers spell the endpoint `url` already; stdio matches
      // Claude shape. Only `type` values need mapping to our transports.
      const type = typeof map.type === 'string' ? map.type.toLowerCase() : '';
      if (type === 'http' || type === 'sse') converted[name] = { ...map, transport: 'streamable-http' };
      else converted[name] = map; // stdio / absent: normalizeServer infers
      continue;
    }
    converted[name] = entry;
  }
  return { entries: toEntries(converted, known), error: null };
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
 * Per-platform config-directory resolution: XDG-style ~/.config on Linux,
 * ~/Library/Application Support on macOS, %APPDATA% on Windows. Bare-home
 * layouts (~/.gemini, ~/.cursor) stay home-relative on every platform.
 *
 * @param {string} home - user home directory.
 * @param {string} posixName - dot-directory under the home (Linux style).
 * @param {string} macosName - folder inside Application Support.
 * @param {string} windowsName - folder inside %APPDATA%.
 * @returns {string} the platform-appropriate config directory.
 */
function configDir(home, posixName, macosName, windowsName) {
  const pf = platform();
  if (pf === 'win32') return join(home, 'AppData', 'Roaming', windowsName);
  if (pf === 'darwin') return join(home, 'Library', 'Application Support', macosName);
  const xdg = process.env.XDG_CONFIG_HOME;
  return typeof xdg === 'string' && xdg !== '' ? join(xdg, posixName) : join(home, '.config', posixName);
}

/** The Claude Desktop config path per platform (MSIX installs redirect Roaming). */
function claudeDesktopPaths(home) {
  const pf = platform();
  if (pf === 'win32') {
    return [
      join(home, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json'),
      // MSIX virtualization: LocalCache\Roaming mirrors Roaming for Store installs.
      join(home, 'AppData', 'Local', 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json'),
    ];
  }
  if (pf === 'darwin') {
    return [join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')];
  }
  return [
    join(configDir(home, 'Claude', 'Claude', 'Claude'), 'claude_desktop_config.json'),
  ];
}

/** The VS Code user-level mcp.json path per platform (stable + Insiders). */
function vscodeMcpPaths(home) {
  const pf = platform();
  if (pf === 'win32') return [
    join(home, 'AppData', 'Roaming', 'Code', 'User', 'mcp.json'),
    join(home, 'AppData', 'Roaming', 'Code - Insiders', 'User', 'mcp.json'),
  ];
  if (pf === 'darwin') return [
    join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json'),
    join(home, 'Library', 'Application Support', 'Code - Insiders', 'User', 'mcp.json'),
  ];
  return [
    join(home, '.config', 'Code', 'User', 'mcp.json'),
    join(home, '.config', 'Code - Insiders', 'User', 'mcp.json'),
  ];
}

/** The Cline global mcp settings path (VS Code global-storage based). */
function clinePaths(home) {
  const pf = platform();
  const suffix = join('globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json');
  if (pf === 'win32') return [join(home, 'AppData', 'Roaming', 'Code', 'User', suffix)];
  if (pf === 'darwin') return [join(home, 'Library', 'Application Support', 'Code', 'User', suffix)];
  return [join(home, '.config', 'Code', 'User', suffix)];
}

/**
 * Detect every known agent config under one home directory and parse its MCP
 * servers. Sources are returned in a stable order regardless of existence;
 * a source with multiple candidate paths reports the first one that exists
 * (or the first path when none do). One resolution path only: the loop below
 * probes every candidate and reads the first hit.
 *
 * @param {object} [options]
 * @param {string} [options.home] - home directory; defaults to os.homedir().
 * @param {() => Promise<Record<string, object>>} [options.knownServers] - current store snapshot.
 * @returns {Promise<Array<{ id: string, label: string, path: string, exists: boolean, error: string | null, entries: Array<object> }>>}
 */
export async function detectAgentSources(options = {}) {
  const home = options.home ?? homedir();
  const known = options.knownServers ? await options.knownServers() : {};

  /**
   * A source spec: candidate paths + a reader. Readers get (path, known) and
   * answer { entries, error }.
   *
   * @type {Array<{ id: string, label: string, paths: () => string[], read: (path: string, known: Record<string, object>) => Promise<{ entries: Array<object>, error: string | null }> }>}
   */
  const sources = [
    { id: 'claude-code', label: 'Claude Code', paths: () => [join(home, '.claude.json')], read: readClaude },
    {
      id: 'claude-desktop',
      label: 'Claude Desktop',
      paths: () => claudeDesktopPaths(home),
      read: readClaude,
    },
    { id: 'codex', label: 'Codex', paths: () => [join(home, '.codex', 'config.toml')], read: readCodex },
    { id: 'zcode', label: 'zcode', paths: () => [join(home, '.zcode', 'cli', 'config.json')], read: readZcode },
    { id: 'cursor', label: 'Cursor', paths: () => [join(home, '.cursor', 'mcp.json')], read: readCursor },
    {
      id: 'opencode',
      label: 'opencode',
      paths: () => [join(configDir(home, 'opencode', 'opencode', 'opencode'), 'opencode.json'), join(configDir(home, 'opencode', 'opencode', 'opencode'), 'opencode.jsonc')],
      read: readOpencode,
    },
    { id: 'gemini-cli', label: 'Gemini CLI', paths: () => [join(home, '.gemini', 'settings.json')], read: readGemini },
    { id: 'qwen-code', label: 'Qwen Code', paths: () => [join(home, '.qwen', 'settings.json')], read: readQwen },
    {
      id: 'mimo-code',
      label: 'MiMo Code',
      paths: () => [
        join(configDir(home, 'mimocode', 'mimocode', 'mimocode'), 'mimocode.json'),
        join(configDir(home, 'mimocode', 'mimocode', 'mimocode'), 'mimocode.jsonc'),
      ],
      read: readMimo,
    },
    { id: 'windsurf', label: 'Windsurf', paths: () => [join(home, '.codeium', 'windsurf', 'mcp_config.json')], read: readClaude },
    {
      id: 'vscode',
      label: 'VS Code',
      paths: () => vscodeMcpPaths(home),
      read: readVscode,
    },
    {
      id: 'cline',
      label: 'Cline',
      paths: () => clinePaths(home),
      read: readClaude,
    },
    {
      id: 'trae',
      label: 'Trae',
      paths: () => [join(configDir(home, 'Trae', 'Trae', 'Trae'), 'mcp.json')],
      read: readVscode,
    },
  ];

  return Promise.all(sources.map(async (source) => {
    const candidates = source.paths();
    const existsList = await Promise.all(candidates.map((p) => fileExists(p)));
    const hitIndex = existsList.indexOf(true);
    const path = candidates[hitIndex >= 0 ? hitIndex : 0];
    const result = await source.read(path, known);
    return {
      id: source.id,
      label: source.label,
      path,
      exists: hitIndex >= 0,
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
