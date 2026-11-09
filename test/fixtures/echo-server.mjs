/**
 * Minimal stdio MCP server used by manual verification: newline-delimited
 * JSON-RPC 2.0 with an initialize handshake, one echo tool, and one failing
 * tool. No SDK dependency — the point is to exercise the real client in
 * src/host/mcp-supervisor.js against the wire protocol.
 *
 * Usage: node test/fixtures/echo-server.mjs
 */
import { createInterface } from 'node:readline';

const SERVER_INFO = { name: 'echo-fixture', version: '0.0.1' };
const TOOLS = [
  {
    name: 'echo',
    description: 'Echo back the message argument as text.',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string', description: 'Text to echo.' } },
      required: ['message'],
      additionalProperties: false,
    },
  },
  {
    name: 'boom',
    description: 'Always fails with an MCP error result.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

const stdin = process.stdin;
stdin.setEncoding('utf8');
const lines = createInterface({ input: stdin });

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

lines.on('line', (line) => {
  if (line.trim() === '') return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message === null || typeof message !== 'object') return;
  if (message.method === undefined) return; // client-side requests are out of scope
  const { id, method, params } = message;
  const isNotification = id === undefined || id === null;
  try {
    switch (method) {
      case 'initialize':
        send({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: params?.protocolVersion ?? '2026-07-28',
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
          },
        });
        break;
      case 'notifications/initialized':
      case 'notifications/cancelled':
        break;
      case 'tools/list':
        send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
        break;
      case 'tools/call': {
        const name = params?.name;
        if (name === 'echo') {
          send({
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text: String(params?.arguments?.message ?? '') }] },
          });
        } else if (name === 'boom') {
          send({
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text: 'boom fixture failure' }], isError: true },
          });
        } else {
          send({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${String(name)}` } });
        }
        break;
      }
      case 'ping':
        send({ jsonrpc: '2.0', id, result: {} });
        break;
      default:
        if (!isNotification) {
          send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${String(method)}` } });
        }
    }
  } catch (error) {
    if (!isNotification) {
      send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(error) } });
    }
  }
});
