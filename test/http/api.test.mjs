import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHandler, API_BASE } from '../../src/host/http/api.js';
import { createSelectionStore } from '../../src/host/session/selection.js';
import { createProcessStore } from '../../src/host/session/processes.js';
import * as skillsStore from '../../src/host/skills/store.js';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Fake request stream; body (if any) is JSON-emitted asynchronously. */
function fakeReq(method, pathname, body) {
  const req = new EventEmitter();
  req.method = method;
  req.url = pathname;
  queueMicrotask(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

/** Fake response capturing status, headers, and the parsed JSON body. */
function fakeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    headersSent: false,
    sent: null,
    setHeader(key, value) {
      res.headers[key.toLowerCase()] = String(value);
    },
    end(text) {
      res.body = String(text ?? '');
      res.headersSent = true;
      res.sent = JSON.parse(res.body);
    },
  };
  return res;
}

const SERVERS = {
  good: { transport: 'stdio', command: 'npx', enabled: true },
  bad: { transport: 'streamable-http', url: 'http://127.0.0.1:9/mcp', enabled: true },
  off: { transport: 'stdio', command: 'x', enabled: false },
};

function makeServices(skillsRoot) {
  const writes = [];
  const synced = [];
  /** Last-test records captured by the supervisor stub's recordTest. */
  const recorded = {};
  const selectionStore = createSelectionStore();
  let roleWrites = 0;
  let servers = { ...SERVERS };
  const store = {
    listServers: async () => servers,
    putServer: async (name, server) => {
      writes.push([name, server]);
      servers = { ...servers, [name]: server };
      return { ok: true };
    },
    removeServer: async (name) => {
      if (servers[name] === undefined) return { ok: false, error: 'not-found' };
      const next = { ...servers };
      delete next[name];
      servers = next;
      return { ok: true };
    },
    readAgentsFile: async () => ({ ok: true, exists: true, count: Object.keys(SERVERS).length, error: null }),
    agentsFileEntries: async () => ({
      ok: true,
      entries: Object.entries(SERVERS).map(([name, server]) => ({ name, server, issue: servers[name] !== undefined ? 'name-exists' : null })),
    }),
    storeInfo: () => ({ kind: 'domain', fallbackPath: '/tmp/x', agentsPath: '/tmp/y', error: null, migrated: 0 }),
  };
  const supervisor = {
    status: () => ({
      good: { state: 'connected', error: null, toolCount: 2, tools: [{ name: 'a', publicName: 'mcp__good__a', description: '' }] },
      bad: { state: 'failed', error: 'connect ECONNREFUSED', toolCount: 0, tools: [] },
    }),
    testOne: async (name) => (name === 'good'
      ? { ok: true, tools: [{ name: 'a', description: 'd' }] }
      : { ok: false, error: 'boom' }),
    recordTest: (name, result) => {
      recorded[name] = {
        ok: result.ok === true,
        toolCount: Array.isArray(result.tools) ? result.tools.length : 0,
        error: result.ok === true ? null : String(result.error ?? 'unknown'),
      };
    },
    call: async (name, tool, args) => {
      if (name !== 'good') throw new Error('not connected');
      return { content: [{ type: 'text', text: 'echo:' + tool + ':' + JSON.stringify(args) }] };
    },
    sync: async (next) => {
      synced.push(next);
    },
    definitionsFor: () => [],
    onChange: () => () => {},
    dispose: async () => {},
  };
  let roles = {};
  const subagentsStore = {
    listRoles: async () => roles,
    putRole: async (name, role) => {
      roles = { ...roles, [name]: role };
      return { ok: true };
    },
    removeRole: async (name) => {
      if (roles[name] === undefined) return { ok: false, error: 'not-found' };
      const next = { ...roles };
      delete next[name];
      roles = next;
      return { ok: true };
    },
    storeInfo: () => ({ kind: 'domain', fallbackPath: '/tmp/s.json', error: null }),
  };
  const services = {
    store,
    supervisor,
    skillsRoot,
    skillsStore,
    selectionStore,
    listSkills: async () => [{ dir: 'alpha', name: 'Alpha', description: 'd', hasSkillMd: true, fileCount: 1 }],
    onSelectionChanged: undefined,
    installSkillFromGithub: async (source) => (source.startsWith('ok/')
      ? { ok: true, installed: [{ name: 'alpha', status: 'installed', files: 2 }], skipped: [] }
      : { ok: false, error: 'no-skill-md' }),
    subagentsStore,
    onSubagentsChanged: () => { roleWrites += 1; },
    listLlmCatalog: async () => [{ id: 'p1', name: 'P One', models: [{ id: 'm1', name: 'M One' }] }],
    sessionFresh: (id) => id !== 'subagent' && id !== 'started',
  };
  return { ...services, writes, synced, recorded, store, selectionStore, roleWrites: () => roleWrites };
}

async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), 'api-skills-'));
  await mkdir(join(root, 'alpha'));
  await writeFile(join(root, 'alpha', 'SKILL.md'), '---\nname: Alpha\n---\nhello', 'utf8');
  return root;
}

async function call(services, method, pathname, body) {
  const handler = createHandler(services);
  const req = fakeReq(method, pathname, body);
  const res = fakeRes();
  await handler(req, res);
  return res;
}

test('GET /state serves store servers, pool, skills, and store metadata', async () => {
  const root = await makeRoot();
  try {
    const services = makeServices(root);
    const res = await call(services, 'GET', `${API_BASE}/state`);
    assert.equal(res.statusCode, 200);
    // The features list drives the client's per-row UI gating; the stub
    // passes no features fn so the handler answers its full default set.
    assert.deepEqual(res.sent.features, ['mcp', 'subagents', 'retry', 'processes']);
    assert.equal(res.sent.ok, true);
    assert.ok(res.sent.servers.good);
    assert.equal(res.sent.pool.bad.state, 'failed');
    assert.equal(res.sent.skills[0].name, 'Alpha');
    assert.equal(res.sent.store.kind, 'domain');
    assert.equal(res.sent.store.agentsFile.count, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('GET /mcp/agents-file serves conflict-marked import entries', async () => {
  const root = await makeRoot();
  try {
    const services = makeServices(root);
    const res = await call(services, 'GET', `${API_BASE}/mcp/agents-file`);
    assert.equal(res.statusCode, 200);
    const names = res.sent.entries.map((entry) => entry.name).sort();
    assert.deepEqual(names, ['bad', 'good', 'off']);
    assert.equal(res.sent.entries.find((entry) => entry.name === 'good').issue, 'name-exists');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('POST /mcp/import parses and optionally tests entries', async () => {
  const root = await makeRoot();
  try {
    const services = makeServices(root);
    const text = JSON.stringify({ mcpServers: { good: { command: 'x' }, newone: { url: 'http://a' } } });
    const plain = await call(services, 'POST', `${API_BASE}/mcp/import`, { text });
    assert.equal(plain.sent.entries.find((entry) => entry.name === 'good').issue, 'name-exists');
    assert.equal(plain.sent.entries.find((entry) => entry.name === 'newone').issue, null);
    const tested = await call(services, 'POST', `${API_BASE}/mcp/import`, { text, test: true });
    const newone = tested.sent.entries.find((entry) => entry.name === 'newone');
    // 'newone' is not in SERVERS so testOne treats it like every unknown → boom.
    assert.deepEqual(newone.test, { ok: false, error: 'boom' });
    const bad = await call(services, 'POST', `${API_BASE}/mcp/import`, { text: 'nope{' });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.sent.error, 'bad-json');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('POST /mcp/import/commit merges selected entries and syncs the pool', async () => {
  const root = await makeRoot();
  try {
    const services = makeServices(root);
    const res = await call(services, 'POST', `${API_BASE}/mcp/import/commit`, {
      entries: [{ name: 'fresh', server: { command: 'y' } }, { name: 'bad name', server: { command: 'z' } }],
    });
    assert.equal(res.statusCode, 200);
    assert.ok(res.sent.servers.fresh);
    assert.equal(res.sent.servers['bad name'], undefined);
    assert.equal(services.writes.length, 1);
    assert.equal(services.synced.length, 1);
    const nothing = await call(services, 'POST', `${API_BASE}/mcp/import/commit`, { entries: [] });
    assert.equal(nothing.statusCode, 400);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('POST /mcp/save validates and writes; delete removes', async () => {
  const root = await makeRoot();
  try {
    const services = makeServices(root);
    const invalid = await call(services, 'POST', `${API_BASE}/mcp/save`, { name: 'x!', server: {} });
    assert.equal(invalid.statusCode, 400);
    const badServer = await call(services, 'POST', `${API_BASE}/mcp/save`, { name: 'x', server: { transport: 'stdio' } });
    assert.equal(badServer.sent.error, 'missing-command');
    const ok = await call(services, 'POST', `${API_BASE}/mcp/save`, { name: 'x', server: { command: 'run' } });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.sent.servers.x.transport, 'stdio');
    const del = await call(services, 'POST', `${API_BASE}/mcp/delete`, { name: 'off' });
    assert.equal(del.sent.servers.off, undefined);
    const missing = await call(services, 'POST', `${API_BASE}/mcp/delete`, { name: 'nope' });
    assert.equal(missing.statusCode, 404);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('POST /mcp/toggle flips enabled; pool sync runs in the background', async () => {
  const root = await makeRoot();
  try {
    const services = makeServices(root);
    // Make the background sync observably slow: without waiting, a toggle
    // response must already be back (the switch must never feel stuck).
    let syncStarted = 0;
    let finishSync = () => {};
    services.supervisor.sync = async () => {
      syncStarted += 1;
      await new Promise((resolve) => { finishSync = resolve; });
      services.synced.push(null);
    };
    const bad = await call(services, 'POST', `${API_BASE}/mcp/toggle`, { name: 'good' });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.sent.error, 'bad-body');
    const missing = await call(services, 'POST', `${API_BASE}/mcp/toggle`, { name: 'nope', enabled: true });
    assert.equal(missing.statusCode, 404);
    const off = await call(services, 'POST', `${API_BASE}/mcp/toggle`, { name: 'good', enabled: false });
    assert.equal(off.statusCode, 200);
    assert.equal(off.sent.servers.good.enabled, false);
    // The rest of the record is preserved untouched.
    assert.equal(off.sent.servers.good.command, 'npx');
    // The toggle went through putServer; the pool sync started but the
    // response did NOT wait for it to settle.
    assert.deepEqual(services.writes.at(-1), ['good', { transport: 'stdio', command: 'npx', enabled: false }]);
    assert.equal(syncStarted, 1);
    assert.equal(services.synced.length, 0);
    finishSync();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(services.synced.length, 1);
    const on = await call(services, 'POST', `${API_BASE}/mcp/toggle`, { name: 'good', enabled: true });
    assert.equal(on.statusCode, 200);
    assert.equal(on.sent.servers.good.enabled, true);
    assert.equal(syncStarted, 2);
    finishSync();
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('POST /mcp/test covers one server or all, reconciles the pool, and records last tests', async () => {
  const root = await makeRoot();
  try {
    const services = makeServices(root);
    const one = await call(services, 'POST', `${API_BASE}/mcp/test`, { name: 'good' });
    assert.deepEqual(one.sent.results.good, { ok: true, tools: [{ name: 'a', description: 'd' }] });
    // The manual test also re-syncs the pool so card statuses update.
    assert.equal(services.synced.length, 1);
    // The outcome is recorded as the server's last test for /state readers.
    assert.deepEqual(services.recorded.good, { ok: true, toolCount: 1, error: null });
    const all = await call(services, 'POST', `${API_BASE}/mcp/test`, {});
    assert.equal(all.sent.results.good.ok, true);
    assert.equal(all.sent.results.bad.ok, false);
    assert.equal(all.sent.results.off.error, 'disabled');
    // "disabled" placeholders are not real probes and never get recorded.
    assert.deepEqual(services.recorded.bad, { ok: false, toolCount: 0, error: 'boom' });
    assert.equal(services.recorded.off, undefined);
    assert.equal(services.synced.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('skills file routes read, write, and reject conflicts', async () => {
  const root = await makeRoot();
  try {
    const services = makeServices(root);
    const read = await call(services, 'POST', `${API_BASE}/skills/file/read`, { skill: 'alpha', path: 'SKILL.md' });
    assert.equal(read.sent.file.editable, true);
    const conflict = await call(services, 'POST', `${API_BASE}/skills/file/write`, {
      skill: 'alpha', path: 'SKILL.md', content: 'x', sha: 'stale',
    });
    assert.equal(conflict.statusCode, 409);
    const write = await call(services, 'POST', `${API_BASE}/skills/file/write`, {
      skill: 'alpha', path: 'SKILL.md', content: '---\nname: Alpha\n---\nnew', sha: read.sent.file.sha,
    });
    assert.equal(write.statusCode, 200);
    const traversal = await call(services, 'POST', `${API_BASE}/skills/file/read`, { skill: 'alpha', path: '../../mcp.json' });
    assert.equal(traversal.statusCode, 400);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('session selection GET and POST roundtrip', async () => {
  const root = await makeRoot();
  try {
    const services = makeServices(root);
    const post = await call(services, 'POST', `${API_BASE}/session/selection`, { sessionId: 's1', mcp: ['good'], skills: null });
    assert.deepEqual(post.sent.selection, { mcp: ['good'], skills: null });
    const get = await call(services, 'GET', `${API_BASE}/session/selection?id=s1`);
    assert.deepEqual(get.sent.selection, { mcp: ['good'], skills: null });
    const bad = await call(services, 'GET', `${API_BASE}/session/selection`);
    assert.equal(bad.statusCode, 400);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('POST /mcp/call bridges a tool invocation through the supervisor', async () => {
  const root = await makeRoot();
  try {
    const services = makeServices(root);
    const ok = await call(services, 'POST', `${API_BASE}/mcp/call`, { name: 'good', tool: 'echo', args: { x: 1 } });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.sent.result.content[0].text, 'echo:echo:{"x":1}');
    const badJson = await call(services, 'POST', `${API_BASE}/mcp/call`, { name: 'good', tool: 'echo', args: [] });
    assert.equal(badJson.statusCode, 200);
    const missing = await call(services, 'POST', `${API_BASE}/mcp/call`, { name: 'nope', tool: 'x' });
    assert.equal(missing.statusCode, 404);
    const badBody = await call(services, 'POST', `${API_BASE}/mcp/call`, { tool: 'x' });
    assert.equal(badBody.statusCode, 400);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('GET /session/fresh answers the subagent gate for the composer chip', async () => {
  const root = await makeRoot();
  try {
    const services = makeServices(root);
    // The chip is a new-session decision: an empty (blank-shell) session is
    // fresh, a session with turns is not, and subagent conversations are
    // always excluded.
    const fresh = await call(services, 'GET', `${API_BASE}/session/fresh?id=new-session`);
    assert.equal(fresh.statusCode, 200);
    assert.equal(fresh.sent.fresh, true);
    const started = await call(services, 'GET', `${API_BASE}/session/fresh?id=started`);
    assert.equal(started.statusCode, 200);
    assert.equal(started.sent.fresh, false);
    const subagent = await call(services, 'GET', `${API_BASE}/session/fresh?id=subagent`);
    assert.equal(subagent.statusCode, 200);
    assert.equal(subagent.sent.fresh, false);
    const badId = await call(services, 'GET', `${API_BASE}/session/fresh`);
    assert.equal(badId.statusCode, 400);
    const unsupported = makeServices(root);
    delete unsupported.sessionFresh;
    const missing = await call(unsupported, 'GET', `${API_BASE}/session/fresh?id=x`);
    assert.equal(missing.statusCode, 501);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** A real process store with injectable signals, plus its call log. */
function makeProcessStore() {
  const killCalls = [];
  let terminated42 = false;
  const store = createProcessStore({
    kill(pid, signal) {
      killCalls.push([pid, signal]);
      if (signal === 'SIGTERM' && pid === 42) {
        terminated42 = true;
        return;
      }
      if (signal === 0 && (pid === 9 || (pid === 42 && terminated42))) {
        const error = new Error('no such process');
        error.code = 'ESRCH';
        throw error;
      }
    },
    sleep: () => Promise.resolve(),
  });
  return { store, killCalls };
}

test('session process routes: list with liveness, stop with escalation mapping', async () => {
  const root = await makeRoot();
  try {
    const { store, killCalls } = makeProcessStore();
    const services = { ...makeServices(root), processStore: store };
    await store.record('s1', 's1', { name: 'vite', port: 5173, pid: 42, output: 'ready' });
    await store.record('s1', 'child', { name: 'api', port: 8080 });
    await store.record('s1', 's1', { name: 'dead', pid: 9 });

    const badId = await call(services, 'GET', `${API_BASE}/session/processes`);
    assert.equal(badId.statusCode, 400);
    assert.equal(badId.sent.error, 'bad-id');
    const listed = await call(services, 'GET', `${API_BASE}/session/processes?id=s1`);
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.sent.ok, true);
    const byName = Object.fromEntries(listed.sent.processes.map((item) => [item.name, item]));
    assert.equal(byName.vite.status, 'running');
    assert.equal(byName.api.source, 'subagent');
    assert.equal(byName.dead.status, 'exited', 'dead pid flips during the list read');

    const badBody = await call(services, 'POST', `${API_BASE}/session/processes/stop`, { sessionId: 's1' });
    assert.equal(badBody.statusCode, 400);
    const ghost = await call(services, 'POST', `${API_BASE}/session/processes/stop`, { sessionId: 's1', name: 'ghost' });
    assert.equal(ghost.statusCode, 404);
    const portOnly = await call(services, 'POST', `${API_BASE}/session/processes/stop`, { sessionId: 's1', name: 'api' });
    assert.equal(portOnly.statusCode, 409);
    assert.equal(portOnly.sent.error, 'no-pid');
    const stopped = await call(services, 'POST', `${API_BASE}/session/processes/stop`, { sessionId: 's1', name: 'vite' });
    assert.equal(stopped.statusCode, 200);
    assert.equal(stopped.sent.ok, true);
    assert.equal(stopped.sent.process.status, 'stopped');
    assert.deepEqual(killCalls.find(([, signal]) => signal === 'SIGTERM'), [42, 'SIGTERM']);
    assert.equal(killCalls.some(([, signal]) => signal === 'SIGKILL'), false);

    const missing = makeServices(root);
    delete missing.processStore;
    assert.equal((await call(missing, 'GET', `${API_BASE}/session/processes?id=x`)).statusCode, 501);
    assert.equal((await call(missing, 'POST', `${API_BASE}/session/processes/stop`, { sessionId: 'x', name: 'y' })).statusCode, 501);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('POST /skills/install-github installs through the service and maps failures', async () => {
  const root = await makeRoot();
  try {
    const services = makeServices(root);
    const ok = await call(services, 'POST', `${API_BASE}/skills/install-github`, { source: 'ok/repo' });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.sent.installed[0].name, 'alpha');
    const bad = await call(services, 'POST', `${API_BASE}/skills/install-github`, { source: 'weird/repo' });
    assert.equal(bad.statusCode, 502);
    assert.equal(bad.sent.error, 'no-skill-md');
    const empty = await call(services, 'POST', `${API_BASE}/skills/install-github`, { source: '' });
    assert.equal(empty.statusCode, 400);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('unknown routes answer 404 JSON', async () => {
  const root = await makeRoot();
  try {
    const services = makeServices(root);
    const res = await call(services, 'GET', `${API_BASE}/nope`);
    assert.equal(res.statusCode, 404);
    assert.equal(res.sent.error, 'not-found');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('subagents routes: list, save with name normalization, delete, catalog', async () => {
  const root = await makeRoot();
  const ROLE = {
    description: 'research',
    enabled: true,
    models: [{ provider: 'p1', model: 'm1', description: 'line one' }],
  };
  try {
    const services = makeServices(root);

    const empty = await call(services, 'GET', `${API_BASE}/subagents`);
    assert.equal(empty.statusCode, 200);
    assert.deepEqual(empty.sent.roles, {});

    const saved = await call(services, 'POST', `${API_BASE}/subagents/save`, { name: 'Web 调研', role: ROLE });
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.sent.name, 'web');
    assert.ok(saved.sent.roles.web);
    assert.equal(services.roleWrites(), 1);

    const invalid = await call(services, 'POST', `${API_BASE}/subagents/save`, { name: 'x', role: { description: '', models: [] } });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.sent.error, 'missing-description');

    const badName = await call(services, 'POST', `${API_BASE}/subagents/save`, { name: '  ', role: ROLE });
    assert.equal(badName.statusCode, 400);
    assert.equal(badName.sent.error, 'bad-name');

    const catalog = await call(services, 'GET', `${API_BASE}/subagents/catalog`);
    assert.equal(catalog.statusCode, 200);
    assert.equal(catalog.sent.providers[0].models[0].id, 'm1');

    const removed = await call(services, 'POST', `${API_BASE}/subagents/delete`, { name: 'web' });
    assert.equal(removed.statusCode, 200);
    assert.deepEqual(removed.sent.roles, {});
    const missing = await call(services, 'POST', `${API_BASE}/subagents/delete`, { name: 'web' });
    assert.equal(missing.statusCode, 404);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('subagents builtins: customize without models, delete hides via tombstone, restore resets', async () => {
  const root = await makeRoot();
  try {
    const services = makeServices(root);

    // Saving under a builtin name without candidates customizes the builtin.
    const saved = await call(services, 'POST', `${API_BASE}/subagents/save`, {
      name: 'frontend-dev',
      role: { description: '改', enabled: true, models: [] },
    });
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.sent.roles['frontend-dev'].description, '改');

    // Deleting a builtin writes a hide marker instead of removing a record.
    const hidden = await call(services, 'POST', `${API_BASE}/subagents/delete`, { name: 'frontend-dev' });
    assert.equal(hidden.statusCode, 200);
    assert.equal(hidden.sent.builtin['frontend-dev'], 'hidden');
    assert.equal(hidden.sent.roles['frontend-dev'].enabled, false);
    assert.deepEqual(hidden.sent.roles['frontend-dev'].models, []);

    // Restore drops the marker; restoring an already-default builtin is a no-op success.
    const restored = await call(services, 'POST', `${API_BASE}/subagents/restore`, { name: 'frontend-dev' });
    assert.equal(restored.statusCode, 200);
    assert.equal(restored.sent.builtin['frontend-dev'], 'default');
    const noop = await call(services, 'POST', `${API_BASE}/subagents/restore`, { name: 'frontend-dev' });
    assert.equal(noop.statusCode, 200);
    assert.equal(noop.sent.builtin['frontend-dev'], 'default');

    // Only builtin names can be restored.
    const notBuiltin = await call(services, 'POST', `${API_BASE}/subagents/restore`, { name: 'web' });
    assert.equal(notBuiltin.statusCode, 400);
    assert.equal(notBuiltin.sent.error, 'not-builtin');

    // A non-builtin save with empty models still fails; the plain delete keeps its 404.
    const invalid = await call(services, 'POST', `${API_BASE}/subagents/save`, { name: 'x', role: { description: 'd', models: [] } });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.sent.error, 'missing-models');
    const missing = await call(services, 'POST', `${API_BASE}/subagents/delete`, { name: 'ghost' });
    assert.equal(missing.statusCode, 404);

    // The listing carries per-builtin states for the UI badges.
    const list = await call(services, 'GET', `${API_BASE}/subagents`);
    assert.equal(list.sent.builtin['frontend-dev'], 'default');
    assert.equal(list.sent.builtin['task-planner'], 'default');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('POST /subagents/models/bulk imports every settings-page model, skipping existing', async () => {
  const root = await makeRoot();
  try {
    const services = makeServices(root);
    const pool = new Map();
    services.subagentsStore.listPoolModels = async () => [...pool.values()];
    services.subagentsStore.putPoolModel = async (key, entry) => {
      pool.set(key, entry);
      return { ok: true };
    };

    const first = await call(services, 'POST', `${API_BASE}/subagents/models/bulk`, {
      entries: [
        { provider: 'magpie', model: 'm1', name: 'M One' },
        { provider: 'magpie', model: 'm2' },
        { provider: 'magpie', model: 'm1' },
        { provider: '', model: 'm3' },
      ],
    });
    assert.equal(first.statusCode, 200);
    assert.equal(first.sent.imported.length, 2);
    assert.deepEqual(first.sent.skipped, ['magpie/m1']);
    assert.equal(first.sent.models.length, 2);

    const second = await call(services, 'POST', `${API_BASE}/subagents/models/bulk`, {
      entries: [{ provider: 'magpie', model: 'm1' }, { provider: 'p2', model: 'm9' }],
    });
    assert.equal(second.sent.imported.length, 1);
    assert.equal(second.sent.skipped.length, 1);
    assert.equal(second.sent.models.length, 3);

    const bad = await call(services, 'POST', `${API_BASE}/subagents/models/bulk`, { entries: 'nope' });
    assert.equal(bad.statusCode, 400);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
