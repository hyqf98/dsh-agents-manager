/**
 * MCP server store: the primary home for managed MCP configuration.
 *
 * Layering:
 *  1. DSH unified storage (preferred): a schema-validated KV domain opened
 *     through the Host `storageDomain` facility (`ctx.storage.domain`); writes
 *     are durable-first and change-notified. The spec below is a plain object
 *     with the exact shape `DomainFacility.open()` consumes.
 *  2. File fallback (when the storage-domain form is not composed): a
 *     plugin-owned JSON file under ~/.dsh — still "the DSH environment", never
 *     a workspace or profile file.
 *  3. `~/.agents/mcp.json` is a READ-ONLY import source: migrated once
 *     automatically when the primary store is empty, and importable on demand
 *     through the API. Nothing ever writes to it.
 *
 * @module
 */
import { z } from 'zod';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { readConfig, writeConfig } from './config.js';

/** Zod record schema for one normalized MCP server. */
const ServerSchema = z.object({
  transport: z.enum(['stdio', 'streamable-http']),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  toolCallTimeoutMs: z.number().int().optional(),
  enabled: z.boolean(),
});

/** The KV domain this plugin owns inside the DSH unified storage. */
export const DOMAIN_SPEC = {
  name: 'agents_manager',
  version: 1,
  tables: {
    servers: { valueSchema: ServerSchema },
  },
  global: {
    schema: z.object({ agents_import_done: z.boolean() }),
    initial: { agents_import_done: false },
  },
};

/** Default plugin-owned fallback file (only used without the domain form). */
export function defaultFallbackPath() {
  return join(homedir(), '.dsh', 'agents-manager', 'mcp.json');
}

/** The read-only import source this plugin recognizes. */
export function defaultAgentsPath() {
  return join(homedir(), '.agents', 'mcp.json');
}

/**
 * Read a boolean marker file; absent or malformed reads as false.
 *
 * @param {string} path
 * @returns {Promise<boolean>}
 */
async function readMarker(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    return parsed !== null && typeof parsed === 'object' && parsed.done === true;
  } catch {
    return false;
  }
}

/**
 * Persist a boolean marker file, best-effort.
 *
 * @param {string} path
 * @param {boolean} done
 */
async function writeMarker(path, done) {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify({ done })}\n`, 'utf8');
  } catch { /* a lost marker only re-runs a no-op migration */ }
}

/**
 * Create the store handle. All methods are async and never throw for storage
 * unavailability: failures surface through `storeInfo().error` and reads
 * degrade to an empty list so the supervisor keeps working.
 *
 * @param {object} [options]
 * @param {object | null} [options.storageDomain] - the Host facility, when already resolved.
 * @param {() => object | null} [options.resolveStorageDomain] - lazy resolver; retried
 *        briefly so a plugin that activates before the storage-domain form can
 *        still reach the unified storage.
 * @param {string} [options.fallbackPath] - plugin-owned JSON file path.
 * @param {string} [options.agentsPath] - read-only ~/.agents/mcp.json path.
 * @param {(message: string) => void} [options.log] - diagnostic sink.
 * @returns {object} store handle.
 */
export function createMcpStore(options = {}) {
  const fallbackPath = options.fallbackPath ?? defaultFallbackPath();
  const agentsPath = options.agentsPath ?? defaultAgentsPath();
  const log = options.log ?? (() => {});
  const migrationMarker = `${fallbackPath}.migration`;

  /** @type {{ kind: 'domain' | 'file' | 'unavailable', error: string | null }} */
  const state = { kind: 'unavailable', error: null };
  /** @type {any | null} */
  let domain = null;
  /** Servers persisted by this session's one-shot migration, if any. */
  const info = { migrated: 0 };

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
   * Open the primary backend, then run the one-shot ~/.agents migration.
   *
   * @returns {Promise<void>}
   */
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
        log(`agents-manager: unified storage unavailable (${state.error}); falling back to ${fallbackPath}`);
      }
    } else {
      state.error = 'storage-domain-not-composed';
    }
    if (domain === null) state.kind = 'file';
    await migrateFromAgentsFile();
  }

  /** Whether the one-shot agents-file migration already ran. */
  async function agentsImportDone() {
    if (domain !== null) {
      try {
        return domain.global.get().agents_import_done === true;
      } catch {
        return false;
      }
    }
    return readMarker(migrationMarker);
  }

  /** Mark the one-shot migration as done in whichever backend is live. */
  async function markAgentsImportDone() {
    if (domain !== null) {
      try {
        const current = domain.global.get();
        if (current.agents_import_done !== true) {
          await domain.global.set({ ...current, agents_import_done: true });
        }
      } catch (error) {
        log(`agents-manager: could not record migration flag: ${String(error)}`);
      }
      return;
    }
    await writeMarker(migrationMarker, true);
  }

  /**
   * One-shot migration: when the primary store is empty and ~/.agents/mcp.json
   * holds valid servers, import them and mark the migration done. Never throws.
   */
  async function migrateFromAgentsFile() {
    try {
      if (await agentsImportDone()) return;
      const existing = await listServers();
      if (Object.keys(existing).length > 0) {
        await markAgentsImportDone();
        return;
      }
      const read = await readConfig(agentsPath);
      if (!read.ok || !read.exists || Object.keys(read.servers).length === 0) {
        await markAgentsImportDone();
        return;
      }
      for (const [name, server] of Object.entries(read.servers)) {
        await putServer(name, server);
      }
      await markAgentsImportDone();
      info.migrated = Object.keys(read.servers).length;
      log(`agents-manager: migrated ${info.migrated} server(s) from ${agentsPath}`);
    } catch (error) {
      log(`agents-manager: agents-file migration skipped: ${String(error)}`);
    }
  }

  /**
   * Read every managed server, keyed by name. Storage failures degrade to an
   * empty map recorded in `storeInfo().error`.
   *
   * @returns {Promise<Record<string, object>>}
   */
  async function listServers() {
    if (domain !== null) {
      try {
        return Object.fromEntries(domain.table('servers').entries());
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
    return read.servers;
  }

  /**
   * Persist one normalized server record.
   *
   * @param {string} name - validated server name.
   * @param {object} server - normalized record.
   * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
   */
  async function putServer(name, server) {
    if (domain !== null) {
      try {
        await domain.table('servers').put(name, server);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    const read = await readConfig(fallbackPath);
    const current = read.ok ? read.servers : {};
    return writeConfig(fallbackPath, { ...current, [name]: server });
  }

  /**
   * Remove one server.
   *
   * @param {string} name
   * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
   */
  async function removeServer(name) {
    if (domain !== null) {
      try {
        await domain.table('servers').delete(name);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    const read = await readConfig(fallbackPath);
    if (!read.ok || read.servers[name] === undefined) return { ok: false, error: 'not-found' };
    const next = { ...read.servers };
    delete next[name];
    return writeConfig(fallbackPath, next);
  }

  /**
   * Status of the read-only ~/.agents/mcp.json import source.
   *
   * @returns {Promise<{ ok: boolean, exists: boolean, count: number, error: string | null }>}
   */
  async function readAgentsFile() {
    const read = await readConfig(agentsPath);
    if (!read.ok) return { ok: false, exists: read.exists, count: 0, error: read.error };
    return { ok: true, exists: read.exists, count: Object.keys(read.servers).length, error: null };
  }

  /**
   * Parsed entries of the import source, conflict-marked against the store.
   *
   * @returns {Promise<{ ok: true, entries: Array<{ name: string, server: object, issue: string | null }> } | { ok: false, error: string }>}
   */
  async function agentsFileEntries() {
    const read = await readConfig(agentsPath);
    if (!read.ok) return { ok: false, error: read.exists ? read.error : 'missing' };
    if (!read.exists) return { ok: false, error: 'missing' };
    const known = await listServers();
    const entries = Object.entries(read.servers).map(([name, server]) => ({
      name,
      server,
      issue: known[name] !== undefined ? 'name-exists' : null,
    }));
    return { ok: true, entries };
  }

  /** Store status for /state. */
  function storeInfo() {
    return {
      kind: state.kind,
      fallbackPath,
      agentsPath,
      error: state.error,
      migrated: info.migrated,
    };
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

  return {
    init,
    listServers,
    putServer,
    removeServer,
    readAgentsFile,
    agentsFileEntries,
    storeInfo,
    dispose,
  };
}
