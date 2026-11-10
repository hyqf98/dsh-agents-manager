/**
 * MCP connection supervisor: one shared connection per configured server,
 * tool discovery snapshots, independent test connections, and tool-call
 * bridging for definitions the host entry registers on ctx.tools.
 *
 * v1 policy: no automatic reconnect. A server connects when the config is
 * synced (startup, save, import) and when the user tests it; call failures
 * surface to the model as tool errors and to the UI through /state.
 *
 * @module
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { buildChildEnv, publicToolName } from './config.js';

/** Connect+discover budget for pool connections and tests, in milliseconds. */
export const CONNECT_TIMEOUT_MS = 10_000;
/** Identity this bridge reports to MCP servers. */
const CLIENT_INFO = { name: 'dsh-agents-manager', version: '0.1.0' };

/**
 * Build the transport for one normalized server record.
 *
 * @param {object} server - normalized server config.
 * @returns {object} an MCP SDK transport.
 */
function createTransport(server) {
  if (server.transport === 'stdio') {
    return new StdioClientTransport({
      command: server.command,
      args: server.args,
      env: buildChildEnv(process.env, server.env),
      cwd: server.cwd,
    });
  }
  return new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } });
}

/**
 * Extract readable text from an MCP content array; non-text blocks degrade to
 * bounded placeholders instead of leaking base64 payloads.
 *
 * @param {unknown[]} content - MCP content blocks.
 * @returns {string}
 */
export function extractText(content) {
  if (!Array.isArray(content)) return '';
  const parts = content.map((block) => {
    if (block === null || typeof block !== 'object') return '[unsupported MCP content block]';
    const record = /** @type {Record<string, unknown>} */ (block);
    switch (record.type) {
      case 'text':
        return typeof record.text === 'string' ? record.text : '';
      case 'resource_link':
        return `Resource link: ${String(record.name ?? '')} (${String(record.uri ?? '')})`;
      case 'image':
        return '[image result not projected by this bridge; use a text tool or enable dsh-mcp-client for image support]';
      case 'audio':
        return '[audio result unsupported]';
      case 'resource':
        return '[embedded resource unsupported]';
      default:
        return `[unsupported MCP content type: ${String(record.type)}]`;
    }
  });
  return parts.join('\n');
}

/**
 * Create the supervisor.
 *
 * @param {object} [options] - seams for tests (transport factory override).
 * @param {(server: object) => object} [options.transportFactory]
 *        replaces real transports entirely (both kinds).
 * @returns {object} the supervisor handle.
 */
export function createSupervisor(options = {}) {
  const makeTransport = options.transportFactory ?? createTransport;

  /** @type {Map<string, object>} name → live pool entry */
  const pool = new Map();
  /**
   * Last manual test outcome per server, surfaced through status() so every
   * /state reader (settings cards, session chip) renders it. Cleared when a
   * server leaves the enabled set.
   * @type {Map<string, { ok: boolean, toolCount: number, error: string | null, at: number }>}
   */
  const lastTests = new Map();
  /** @type {Set<() => void>} */
  const listeners = new Set();
  let disposed = false;

  /** Notify listeners that snapshots or states changed. */
  function changed() {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch { /* listener errors never break the pool */ }
    }
  }

  /**
   * Close one client connection, ignoring errors from an already-dead peer.
   *
   * @param {object} entry - pool entry.
   */
  async function close(entry) {
    entry.state = 'closing';
    try {
      await entry.client.close();
    } catch { /* a dead server may reject close */ }
    if (entry.state === 'closing') entry.state = 'failed';
  }

  /**
   * Connect one client and discover its tools within the connect budget.
   *
   * @param {object} entry - pool entry with a fresh client.
   * @returns {Promise<void>}
   */
  async function connect(entry) {
    entry.state = 'connecting';
    entry.error = null;
    entry.tools = [];
    try {
      await entry.client.connect(entry.transport, { signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS) });
      const response = await entry.client.listTools(undefined, { signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS) });
      const tools = Array.isArray(response?.tools) ? response.tools : [];
      const seen = new Set();
      /** @type {Array<{ name: string, publicName: string, description: string, inputSchema: object }>} */
      const snapshot = [];
      for (const tool of tools) {
        if (typeof tool?.name !== 'string' || tool.name === '') continue;
        const publicName = publicToolName(entry.name, tool.name);
        if (seen.has(publicName)) throw new Error(`server listed tool "${tool.name}" more than once`);
        seen.add(publicName);
        snapshot.push({
          name: tool.name,
          publicName,
          description: typeof tool.description === 'string' ? tool.description : '',
          inputSchema: tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object', properties: {} },
        });
      }
      entry.tools = snapshot;
      entry.state = 'connected';
    } catch (error) {
      entry.state = 'failed';
      entry.error = error instanceof Error ? error.message : String(error);
      try {
        await entry.client.close();
      } catch { /* already closed */ }
    }
  }

  /**
   * Reconcile the pool with a normalized config map: stop removed or disabled
   * servers, restart changed ones, connect new ones. Returns when every
   * started connection settled (connected or failed).
   *
   * @param {Record<string, object>} servers - normalized server records.
   * @returns {Promise<void>}
   */
  async function sync(servers) {
    if (disposed) return;
    const wanted = new Map(Object.entries(servers).filter(([, server]) => server.enabled !== false));
    // Test outcomes only describe enabled servers; a disabled one has no
    // meaningful status to render, so its record goes away with the entry.
    for (const name of [...lastTests.keys()]) {
      if (!wanted.has(name)) lastTests.delete(name);
    }
    const stopping = [];
    for (const [name, entry] of pool) {
      const next = wanted.get(name);
      if (next === undefined || JSON.stringify(next) !== JSON.stringify(entry.server)) {
        pool.delete(name);
        stopping.push(close(entry));
      }
    }
    /** @type {Array<Promise<void>>} */
    const starting = [];
    for (const [name, server] of wanted) {
      if (pool.has(name)) continue;
      const entry = {
        name,
        server: JSON.parse(JSON.stringify(server)),
        client: new Client({ ...CLIENT_INFO }),
        transport: makeTransport(server),
        state: 'idle',
        error: null,
        tools: [],
      };
      pool.set(name, entry);
      starting.push(connect(entry));
    }
    await Promise.all([...stopping, ...starting]);
    changed();
  }

  /**
   * Independent test connection: connect, list tools, close. Never touches the
   * shared pool, so a broken server cannot disturb registered tools.
   *
   * @param {string} name - server namespace used for tool naming.
   * @param {object} server - normalized server config.
   * @returns {Promise<{ ok: true, tools: Array<object> } | { ok: false, error: string }>}
   */
  async function testOne(name, server) {
    const client = new Client({ ...CLIENT_INFO });
    const transport = makeTransport(server);
    try {
      await client.connect(transport, { signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS) });
      const response = await client.listTools(undefined, { signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS) });
      const tools = (Array.isArray(response?.tools) ? response.tools : []).map((tool) => ({
        name: typeof tool?.name === 'string' ? tool.name : '',
        description: typeof tool?.description === 'string' ? tool.description : '',
      })).filter((tool) => tool.name !== '');
      await client.close();
      return { ok: true, tools };
    } catch (error) {
      try {
        await client.close();
      } catch { /* ignore */ }
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Bridge one tool call through the shared pool.
   *
   * @param {string} name - server namespace.
   * @param {string} rawName - server-side tool name.
   * @param {object} args - JSON arguments.
   * @param {AbortSignal} signal - cancellation from the tool runtime.
   * @returns {Promise<object>} the MCP CallToolResult.
   */
  async function call(name, rawName, args, signal) {
    const entry = pool.get(name);
    if (entry === undefined || entry.state !== 'connected') {
      throw new Error(`MCP server "${name}" is not connected (test it in Settings → MCP & Skills)`);
    }
    return entry.client.callTool({ name: rawName, arguments: args }, { signal });
  }

  /**
   * Build ToolRuntime definitions for one server's current snapshot. Each
   * definition bridges execution to the shared pool.
   *
   * @param {string} name - server namespace.
   * @returns {Array<object>} definitions ready for ctx.tools.register.
   */
  function definitionsFor(name) {
    const entry = pool.get(name);
    if (entry === undefined || entry.state !== 'connected') return [];
    // The user-authored server note rides every tool description: the model
    // reads it wherever it reads what a tool does (registry, pickers), so a
    // one-line "what is this MCP for" becomes part of the tool contract.
    const note = typeof entry.server.description === 'string' && entry.server.description !== ''
      ? `[${name}] ${entry.server.description}`
      : null;
    return entry.tools.map((tool) => ({
      name: tool.publicName,
      description: note === null
        ? (tool.description === '' ? `MCP tool ${name}/${tool.name}` : tool.description)
        : `${note} — ${tool.description === '' ? `MCP tool ${name}/${tool.name}` : tool.description}`,
      parameters: tool.inputSchema,
      output: {
        schema: {
          type: 'object',
          properties: {
            content: { type: 'array', items: {} },
          },
          required: ['content'],
          additionalProperties: false,
        },
        render(_args, value) {
          return [{ type: 'text', text: extractText(value?.content) }];
        },
      },
      async execute(args, exec) {
        const signal = exec?.signal ?? new AbortController().signal;
        const result = await call(name, tool.name, typeof args === 'object' && args !== null ? args : {}, signal);
        const content = Array.isArray(result?.content) ? result.content : [];
        if (result?.isError === true) throw new Error(extractText(content) || `MCP tool ${name}/${tool.name} failed`);
        return { content };
      },
    }));
  }

  /**
   * Record one manual test outcome for /state consumers. Pure bookkeeping —
   * never touches pool state or registered tools.
   *
   * @param {string} name - server name.
   * @param {{ ok: boolean, tools?: Array<object>, error?: string }} result - testOne outcome.
   * @returns {void}
   */
  function recordTest(name, result) {
    lastTests.set(name, {
      ok: result.ok === true,
      toolCount: Array.isArray(result.tools) ? result.tools.length : 0,
      error: result.ok === true ? null : String(result.error ?? 'unknown'),
      at: Date.now(),
    });
  }

  /** Snapshot of every pool entry for /state. */
  function status() {
    /** @type {Record<string, object>} */
    const out = {};
    for (const [name, entry] of pool) {
      out[name] = {
        state: entry.state,
        error: entry.error,
        enabled: entry.server.enabled !== false,
        transport: entry.server.transport,
        toolCount: entry.tools.length,
        tools: entry.tools.map((tool) => ({ name: tool.name, publicName: tool.publicName, description: tool.description })),
        lastTest: lastTests.get(name) ?? null,
      };
    }
    return out;
  }

  /**
   * Subscribe to snapshot/state changes.
   *
   * @param {() => void} listener
   * @returns {() => void} disposer.
   */
  function onChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  /** Stop everything; the supervisor cannot be reused afterwards. */
  async function dispose() {
    disposed = true;
    const stopping = [...pool.values()].map((entry) => close(entry));
    pool.clear();
    listeners.clear();
    await Promise.all(stopping);
  }

  return {
    sync,
    testOne,
    recordTest,
    call,
    definitionsFor,
    status,
    onChange,
    dispose,
  };
}
