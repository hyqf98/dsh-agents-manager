import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeServer,
  normalizeDocument,
  parsePasted,
  publicToolName,
  buildChildEnv,
  readConfig,
  writeConfig,
} from '../../src/host/mcp/config.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('normalizeServer infers stdio from command', () => {
  const result = normalizeServer({ command: 'npx', args: ['-y', 'server'], env: { A: '1' } });
  assert.equal(result.ok, true);
  assert.equal(result.server.transport, 'stdio');
  assert.equal(result.server.command, 'npx');
  assert.deepEqual(result.server.args, ['-y', 'server']);
  assert.deepEqual(result.server.env, { A: '1' });
  assert.equal(result.server.enabled, true);
});

test('normalizeServer infers streamable-http from url and accepts type aliases', () => {
  for (const alias of ['http', 'streamable_http', 'streamable-http']) {
    const result = normalizeServer({ type: alias, url: 'http://localhost:3000/mcp', headers: { Authorization: 'Bearer x' } });
    assert.equal(result.ok, true, alias);
    assert.equal(result.server.transport, 'streamable-http');
  }
  const bare = normalizeServer({ url: 'https://example.com/mcp' });
  assert.equal(bare.ok, true);
  assert.equal(bare.server.transport, 'streamable-http');
});

test('normalizeServer accepts zcode-style type/timeout aliases', () => {
  const zcode = normalizeServer({ type: 'stdio', command: 'npx', args: ['-y', 'x'], timeoutMs: 120000 });
  assert.equal(zcode.ok, true);
  assert.equal(zcode.server.transport, 'stdio');
  assert.equal(zcode.server.toolCallTimeoutMs, 120000);
  for (const alias of ['http', 'sse', 'remote']) {
    const result = normalizeServer({ type: alias, url: 'http://localhost/mcp' });
    assert.equal(result.ok, true, alias);
    assert.equal(result.server.transport, 'streamable-http');
  }
});

test('normalizeServer rejects bad entries with stable codes', () => {
  assert.equal(normalizeServer('nope').ok, false);
  assert.equal(normalizeServer({}).ok, false);
  assert.equal(normalizeServer({ transport: 'stdio' }).error, 'missing-command');
  assert.equal(normalizeServer({ transport: 'streamable-http' }).error, 'bad-url');
  assert.equal(normalizeServer({ transport: 'stdio', command: 'x', args: [1] }).error, 'bad-args');
  assert.equal(normalizeServer({ transport: 'stdio', command: 'x', env: { A: 1 } }).error, 'bad-env');
  assert.equal(normalizeServer({ transport: 'stdio', command: 'x', toolCallTimeoutMs: 5 }).error, 'bad-timeout');
  assert.equal(normalizeServer({ url: 'ftp://x' }).error, 'bad-url');
});

test('normalizeDocument accepts the standard mcpServers wrapper and bare maps', () => {
  const wrapped = normalizeDocument({ mcpServers: { github: { command: 'npx' } } });
  assert.equal(wrapped.ok, true);
  assert.ok(wrapped.servers.github);
  const bare = normalizeDocument({ github: { url: 'http://a' } });
  assert.equal(bare.ok, true);
  assert.ok(bare.servers.github);
  const badName = normalizeDocument({ mcpServers: { 'bad name!': { command: 'x' } } });
  assert.equal(badName.ok, false);
  assert.equal(badName.error, 'bad-name');
});

test('parsePasted accepts wrapper, bare map, single object, and array', () => {
  const wrapped = parsePasted(JSON.stringify({ mcpServers: { a: { command: 'x' } } }));
  assert.equal(wrapped.ok, true);
  assert.deepEqual(wrapped.entries.map((e) => e.name), ['a']);
  assert.equal(wrapped.entries[0].issue, null);

  const single = parsePasted(JSON.stringify({ name: 'solo', command: 'x' }));
  assert.equal(single.ok, true);
  assert.equal(single.entries[0].name, 'solo');

  const array = parsePasted(JSON.stringify([{ name: 'one', url: 'http://a' }, { name: 'two', command: 'x' }]));
  assert.equal(array.ok, true);
  assert.equal(array.entries.length, 2);

  const bare = parsePasted(JSON.stringify({ a: { command: 'x' }, b: { url: 'http://b' } }));
  assert.equal(bare.ok, true);
  assert.equal(bare.entries.length, 2);

  assert.equal(parsePasted('not json').ok, false);
  assert.equal(parsePasted('[]').ok, false);
  assert.equal(parsePasted('{"unrelated": 1}').ok, false);
  const unnamed = parsePasted(JSON.stringify({ command: 'x' }));
  assert.equal(unnamed.ok, true);
  assert.equal(unnamed.entries[0].issue, 'bad-name');
});

test('publicToolName follows the pinned contract', () => {
  assert.equal(publicToolName('github', 'create_issue'), 'mcp__github__create_issue');
  const weird = publicToolName('github', 'a b/c');
  assert.ok(weird.startsWith('mcp__github__a_b_c'));
  assert.ok(weird.length <= 64);
  assert.match(weird, /_[0-9a-f]{12}$/);
  // Deterministic identity: same inputs, same hash.
  assert.equal(publicToolName('github', 'a b/c'), weird);
  // Long names truncate but stay distinct across raw identities.
  const longA = publicToolName('srv', 'x'.repeat(80) + 'a');
  const longB = publicToolName('srv', 'x'.repeat(80) + 'b');
  assert.notEqual(longA, longB);
  assert.ok(longA.length <= 64 && longB.length <= 64);
});

test('buildChildEnv scrubs credential-shaped and DSH_ names', () => {
  const env = buildChildEnv(
    { PATH: '/bin', API_KEY: 'secret', MY_TOKEN: 't', DSH_PROFILE: 'x', OK_VAR: '1' },
    { EXPLICIT: 'yes' },
  );
  assert.equal(env.PATH, '/bin');
  assert.equal(env.OK_VAR, '1');
  assert.equal(env.EXPLICIT, 'yes');
  assert.equal(env.API_KEY, undefined);
  assert.equal(env.MY_TOKEN, undefined);
  assert.equal(env.DSH_PROFILE, undefined);
});

test('buildChildEnv drops the harness NODE_USE_ENV_PROXY injection but keeps plain proxy vars', () => {
  const env = buildChildEnv(
    {
      NODE_USE_ENV_PROXY: '1',
      HTTPS_PROXY: 'http://127.0.0.1:7890/',
      https_proxy: 'http://127.0.0.1:7890',
      NO_PROXY: 'localhost,127.0.0.1',
    },
    undefined,
  );
  // Without the flag a Node child's fetch() ignores the proxy variables —
  // the same default every other MCP host (zcode included) gives a server.
  assert.equal(env.NODE_USE_ENV_PROXY, undefined);
  // Non-Node servers (curl, Python, Go) still read the plain variables.
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7890/');
  assert.equal(env.https_proxy, 'http://127.0.0.1:7890');
  assert.equal(env.NO_PROXY, 'localhost,127.0.0.1');
});

test('buildChildEnv lets a server opt back into the env proxy explicitly', () => {
  const env = buildChildEnv(
    { NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'http://127.0.0.1:7890/' },
    { NODE_USE_ENV_PROXY: '1' },
  );
  assert.equal(env.NODE_USE_ENV_PROXY, '1');
});

test('readConfig treats a missing file as empty and surfaces malformed JSON', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agents-manager-'));
  try {
    const missing = await readConfig(join(dir, 'mcp.json'));
    assert.equal(missing.ok, true);
    assert.equal(missing.exists, false);
    assert.deepEqual(missing.servers, {});

    const path = join(dir, 'mcp.json');
    await writeFile(path, '{broken', 'utf8');
    const broken = await readConfig(path);
    assert.equal(broken.ok, false);
    assert.match(broken.error, /^bad-json:/);

    await writeFile(path, JSON.stringify({ mcpServers: { ok: { command: 'x' } } }), 'utf8');
    const good = await readConfig(path);
    assert.equal(good.ok, true);
    assert.ok(good.servers.ok);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('writeConfig roundtrips and keeps a .bak of the previous file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agents-manager-'));
  try {
    const path = join(dir, 'nested', 'mcp.json');
    const first = await writeConfig(path, { a: { transport: 'stdio', command: 'x', enabled: true } });
    assert.equal(first.ok, true);
    const second = await writeConfig(path, { b: { transport: 'stdio', command: 'y', enabled: true } });
    assert.equal(second.ok, true);
    const read = await readConfig(path);
    assert.deepEqual(Object.keys(read.servers), ['b']);
    const backup = await readConfig(`${path}.bak`);
    assert.deepEqual(Object.keys(backup.servers), ['a']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
