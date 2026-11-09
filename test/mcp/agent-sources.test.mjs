import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCodexToml, detectAgentSources } from '../../src/host/mcp/agent-sources.js';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('parseCodexToml reads mcp_servers tables with args/env arrays and inline tables', () => {
  const toml = [
    'model = "gpt-5"',
    '[mcp_servers.context7]',
    'command = "npx"',
    'args = ["-y", "@upstash/context7-mcp@latest"]',
    'env = { API_KEY = "k", DEBUG = "true" }',
    '',
    '[mcp_servers.remote]',
    'url = "http://localhost:3333/mcp"',
    '',
    '[other_table]',
    'ignored = true',
  ].join('\n');
  const tables = parseCodexToml(toml);
  assert.deepEqual(Object.keys(tables).sort(), ['context7', 'remote']);
  assert.equal(tables.context7.command, 'npx');
  assert.deepEqual(tables.context7.args, ['-y', '@upstash/context7-mcp@latest']);
  assert.deepEqual(tables.context7.env, { API_KEY: 'k', DEBUG: 'true' });
  assert.equal(tables.remote.url, 'http://localhost:3333/mcp');
});

test('detectAgentSources finds claude/codex/zcode/cursor configs and sanitizes names', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agents-home-'));
  try {
    await writeFile(join(home, '.claude.json'), JSON.stringify({
      mcpServers: {
        'claude-std': { command: 'npx', args: ['-y', 'x'] },
        'bad/name!': { command: 'y' },
      },
    }), 'utf8');
    await mkdir(join(home, '.codex'), { recursive: true });
    await writeFile(join(home, '.codex', 'config.toml'), [
      '[mcp_servers.codex_one]',
      'command = "uvx"',
      'args = ["mcp-server-git"]',
    ].join('\n'), 'utf8');
    await mkdir(join(home, '.zcode', 'cli'), { recursive: true });
    await writeFile(join(home, '.zcode', 'cli', 'config.json'), JSON.stringify({
      mcp: { servers: { 'zcode-http': { type: 'http', url: 'http://z/mcp' } } },
    }), 'utf8');
    await mkdir(join(home, '.cursor'), { recursive: true });
    await writeFile(join(home, '.cursor', 'mcp.json'), JSON.stringify({
      mcpServers: { cursorio: { url: 'http://c/mcp', type: 'http' } },
    }), 'utf8');

    const sources = await detectAgentSources({ home, knownServers: async () => ({ 'claude-std': {} }) });
    assert.deepEqual(sources.map((source) => source.id), ['claude-code', 'codex', 'zcode', 'cursor']);

    const claude = sources[0];
    assert.equal(claude.exists, true);
    const claudeOk = claude.entries.find((entry) => entry.name === 'claude-std');
    assert.equal(claudeOk.issue, 'name-exists'); // already in our store
    const claudeSanitized = claude.entries.find((entry) => entry.name === 'bad-name');
    assert.ok(claudeSanitized, 'invalid characters sanitized to a safe name');
    assert.equal(claudeSanitized.issue, null);

    const codex = sources[1];
    assert.equal(codex.entries[0].name, 'codex_one');
    assert.equal(codex.entries[0].server.transport, 'stdio');
    assert.equal(codex.entries[0].server.command, 'uvx');

    const zcode = sources[2];
    assert.equal(zcode.entries[0].server.transport, 'streamable-http');

    const cursor = sources[3];
    assert.equal(cursor.entries[0].name, 'cursorio');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('detectAgentSources reports absent sources without errors', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agents-empty-'));
  try {
    const sources = await detectAgentSources({ home });
    for (const source of sources) {
      assert.equal(source.exists, false);
      assert.equal(source.error, null);
      assert.deepEqual(source.entries, []);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
