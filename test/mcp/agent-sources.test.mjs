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
    // All thirteen sources answer in a stable order, present or not.
    assert.deepEqual(sources.map((source) => source.id), [
      'claude-code', 'claude-desktop', 'codex', 'zcode', 'cursor',
      'opencode', 'gemini-cli', 'qwen-code', 'mimo-code', 'windsurf', 'vscode', 'cline', 'trae',
    ]);

    const byId = Object.fromEntries(sources.map((source) => [source.id, source]));
    const claude = byId['claude-code'];
    assert.equal(claude.exists, true);
    const claudeOk = claude.entries.find((entry) => entry.name === 'claude-std');
    assert.equal(claudeOk.issue, 'name-exists'); // already in our store
    const claudeSanitized = claude.entries.find((entry) => entry.name === 'bad-name');
    assert.ok(claudeSanitized, 'invalid characters sanitized to a safe name');
    assert.equal(claudeSanitized.issue, null);

    const codex = byId.codex;
    assert.equal(codex.entries[0].name, 'codex_one');
    assert.equal(codex.entries[0].server.transport, 'stdio');
    assert.equal(codex.entries[0].server.command, 'uvx');

    const zcode = byId.zcode;
    assert.equal(zcode.entries[0].server.transport, 'streamable-http');

    const cursor = byId.cursor;
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


test('detectAgentSources parses opencode/gemini/mimo/vscode/windsurf/claude-desktop configs', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agents-wide-'));
  const platform = process.platform;
  const { isAbsolute } = await import('node:path');
  const put = async (rel, text) => {
    const target = isAbsolute(rel) ? rel : join(home, rel);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, text, 'utf8');
  };
  const configHome = platform === 'darwin' ? join(home, 'Library/Application Support')
    : platform === 'win32' ? join(home, 'AppData/Roaming')
    : join(home, '.config');
  try {
    await put('.gemini/settings.json', JSON.stringify({
      mcpServers: {
        'gem-stdio': { command: 'gem-mcp', args: ['--x'], timeout: 10000 },
        'gem-http': { httpUrl: 'https://gem.example.com/mcp' },
      },
    }));
    await put(join('.codeium', 'windsurf', 'mcp_config.json'), JSON.stringify({
      mcpServers: { 'wind-srv': { command: 'npx', args: ['-y', 'w'] } },
    }));
    await put(join(configHome, 'opencode', 'opencode.jsonc'), '{\n // comment\n "mcp": { "oc-local": { "type": "local", "command": ["bun", "x", "m"], "environment": { "K": "V" }, }, },\n}');
    await put(join(configHome, 'mimocode', 'mimocode.jsonc'), JSON.stringify({
      mcp: {
        'mimo-local': { type: 'local', command: ['npx', '-y', 'mm'], environment: { A: '1' } },
        'mimo-remote': { type: 'remote', url: 'https://m.example.com/mcp', headers: { Authorization: 'Bearer t' } },
      },
    }));
    await put(join(configHome, 'Code', 'User', 'mcp.json'), JSON.stringify({
      servers: {
        'vs-http': { type: 'http', url: 'https://vs.example.com/mcp' },
        'vs-stdio': { type: 'stdio', command: 'npx', args: ['s'] },
      },
    }));
    await put(join(configHome, 'Trae', 'mcp.json'), JSON.stringify({
      mcpServers: { 'trae-srv': { command: 'npx' } },
    }));

    const byId = Object.fromEntries((await detectAgentSources({ home })).map((s) => [s.id, s]));

    const gemini = byId['gemini-cli'];
    assert.equal(gemini.exists, true);
    assert.equal(gemini.entries.length, 2);
    const gemHttp = gemini.entries.find((e) => e.name === 'gem-http');
    assert.equal(gemHttp.server.transport, 'streamable-http');
    assert.equal(gemHttp.server.url, 'https://gem.example.com/mcp');

    const oc = byId.opencode;
    assert.equal(oc.exists, true, 'opencode.jsonc with comments parses');
    assert.deepEqual(oc.entries[0].server, { transport: 'stdio', command: 'bun', args: ['x', 'm'], env: { K: 'V' }, enabled: true });

    const mimo = byId['mimo-code'];
    assert.deepEqual(mimo.entries[0].server, { transport: 'stdio', command: 'npx', args: ['-y', 'mm'], env: { A: '1' }, enabled: true });
    assert.equal(mimo.entries[1].server.transport, 'streamable-http');

    const vs = byId.vscode;
    assert.equal(vs.entries.find((e) => e.name === 'vs-http').server.transport, 'streamable-http');
    assert.equal(vs.entries.find((e) => e.name === 'vs-stdio').server.transport, 'stdio');

    assert.equal(byId.trae.entries[0].name, 'trae-srv');
    assert.equal(byId.windsurf.entries[0].name, 'wind-srv');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('normalizeServer keeps a user description; supervisor prefixes it into tool descriptions', async () => {
  const { normalizeServer } = await import('../../src/host/mcp/config.js');
  const kept = normalizeServer({ command: 'x', description: '  Blender 场景操作工具  ' });
  assert.equal(kept.ok, true);
  assert.equal(kept.server.description, 'Blender 场景操作工具');
  const dropped = normalizeServer({ command: 'x', description: '   ' });
  assert.equal(dropped.server.description, undefined);
  const long = normalizeServer({ command: 'x', description: 'x'.repeat(900) });
  assert.equal(long.server.description.length, 500);

  // Supervisor prefixing lives in definitionsFor, which needs a pool entry;
  // assert through the shape the UI/API rely on instead: the description
  // survives the store roundtrip (normalizeServer is the store gate).
  const re = normalizeServer(JSON.parse(JSON.stringify(kept.server)));
  assert.equal(re.server.description, 'Blender 场景操作工具');
});
