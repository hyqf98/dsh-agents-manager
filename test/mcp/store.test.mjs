import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpStore, DOMAIN_SPEC } from '../../src/host/mcp/store.js';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GOOD = { transport: 'stdio', command: 'npx', args: ['-y', 'x'], enabled: true };
const GOOD2 = { transport: 'streamable-http', url: 'http://localhost/mcp', enabled: true };

async function makeDirs() {
  const base = await mkdtemp(join(tmpdir(), 'mcp-store-'));
  const dirs = {
    base,
    fallback: join(base, 'store', 'mcp.json'),
    agents: join(base, 'agents', 'mcp.json'),
  };
  await mkdir(join(base, 'store'), { recursive: true });
  await mkdir(join(base, 'agents'), { recursive: true });
  return dirs;
}

/** A minimal DomainFacility double honoring the contract the store relies on. */
function fakeFacility(persisted = { global: structuredClone(DOMAIN_SPEC.global.initial), records: new Map() }) {
  const opened = [];
  return {
    opened,
    async open(spec) {
      assert.equal(spec.name, 'agents_manager');
      opened.push(spec);
      const records = persisted.records;
      return {
        table: (name) => ({
          get: (key) => records.get(key),
          entries: () => records.entries(),
          put: async (key, value) => {
            DOMAIN_SPEC.tables.servers.valueSchema.parse(value);
            records.set(key, value);
          },
          delete: async (key) => records.delete(key),
        }),
        get global() {
          return {
            get: () => persisted.global,
            set: async (value) => { persisted.global = value; },
          };
        },
        close: async () => { /* the medium persists across opens */ },
      };
    },
  };
}

test('file fallback: roundtrip put/list/remove without touching the agents file', async () => {
  const dirs = await makeDirs();
  try {
    const store = createMcpStore({ storageDomain: null, fallbackPath: dirs.fallback, agentsPath: dirs.agents });
    await store.init();
    assert.deepEqual(await store.listServers(), {});
    assert.equal((await store.putServer('a', GOOD)).ok, true);
    assert.equal((await store.putServer('b', GOOD2)).ok, true);
    assert.deepEqual(Object.keys(await store.listServers()).sort(), ['a', 'b']);
    assert.equal((await store.removeServer('a')).ok, true);
    assert.deepEqual(Object.keys(await store.listServers()), ['b']);
    const written = JSON.parse(await readFile(dirs.fallback, 'utf8'));
    assert.deepEqual(Object.keys(written.mcpServers), ['b']);
    const info = store.storeInfo();
    assert.equal(info.kind, 'file');
    assert.equal(info.migrated, 0);
    await store.dispose();
  } finally {
    await rm(dirs.base, { recursive: true, force: true });
  }
});

test('file fallback: one-shot migration imports ~/.agents/mcp.json once', async () => {
  const dirs = await makeDirs();
  try {
    await writeFile(dirs.agents, JSON.stringify({ mcpServers: { mig: GOOD } }), 'utf8');
    const store = createMcpStore({ storageDomain: null, fallbackPath: dirs.fallback, agentsPath: dirs.agents });
    await store.init();
    assert.equal(store.storeInfo().migrated, 1);
    assert.deepEqual(Object.keys(await store.listServers()), ['mig']);
    // The agents file is never modified.
    assert.deepEqual(JSON.parse(await readFile(dirs.agents, 'utf8')).mcpServers, { mig: GOOD });

    // A second store (next boot) does not re-import, and new writes stay in the fallback.
    const second = createMcpStore({ storageDomain: null, fallbackPath: dirs.fallback, agentsPath: dirs.agents });
    await second.init();
    assert.equal(second.storeInfo().migrated, 0);
    await second.putServer('extra', GOOD2);
    await writeFile(dirs.agents, JSON.stringify({ mcpServers: { other: GOOD } }), 'utf8');
    assert.equal((await second.agentsFileEntries()).ok, true);
    const names = (await second.agentsFileEntries()).entries.map((entry) => entry.name);
    assert.deepEqual(names, ['other']);
    await second.dispose();
  } finally {
    await rm(dirs.base, { recursive: true, force: true });
  }
});

test('domain backend: writes go through the facility and migration uses the global flag', async () => {
  const dirs = await makeDirs();
  try {
    await writeFile(dirs.agents, JSON.stringify({ mcpServers: { dom: GOOD } }), 'utf8');
    const persisted = { global: structuredClone(DOMAIN_SPEC.global.initial), records: new Map() };
    const facility = fakeFacility(persisted);
    const store = createMcpStore({ storageDomain: facility, fallbackPath: dirs.fallback, agentsPath: dirs.agents });
    await store.init();
    assert.equal(store.storeInfo().kind, 'domain');
    assert.equal(store.storeInfo().migrated, 1);
    assert.deepEqual(Object.keys(await store.listServers()), ['dom']);
    assert.equal((await store.putServer('added', GOOD2)).ok, true);
    assert.deepEqual(Object.keys(await store.listServers()).sort(), ['added', 'dom']);
    assert.equal((await store.removeServer('dom')).ok, true);
    assert.deepEqual(Object.keys(await store.listServers()), ['added']);
    // The fallback file was never created.
    await assert.rejects(() => readFile(dirs.fallback, 'utf8'));
    // Reopening the same medium (fresh facility over the same persistence)
    // does not re-import: the domain global kept the migration flag.
    const reopened = createMcpStore({ storageDomain: fakeFacility(persisted), fallbackPath: dirs.fallback, agentsPath: dirs.agents });
    await reopened.init();
    assert.equal(reopened.storeInfo().migrated, 0);
    await reopened.dispose();
    await store.dispose();
  } finally {
    await rm(dirs.base, { recursive: true, force: true });
  }
});

test('domain open failure degrades to the file backend with a recorded error', async () => {
  const dirs = await makeDirs();
  try {
    const failing = { open: async () => { throw new Error('backend-not-found'); } };
    const store = createMcpStore({ storageDomain: failing, fallbackPath: dirs.fallback, agentsPath: dirs.agents });
    await store.init();
    assert.equal(store.storeInfo().kind, 'file');
    assert.match(store.storeInfo().error, /domain-open-failed/);
    assert.equal((await store.putServer('x', GOOD)).ok, true);
    assert.deepEqual(Object.keys(await store.listServers()), ['x']);
    await store.dispose();
  } finally {
    await rm(dirs.base, { recursive: true, force: true });
  }
});

test('agents file status reports existence and counts', async () => {
  const dirs = await makeDirs();
  try {
    const store = createMcpStore({ storageDomain: null, fallbackPath: dirs.fallback, agentsPath: dirs.agents });
    await store.init();
    const missing = await store.readAgentsFile();
    assert.equal(missing.ok, true);
    assert.equal(missing.exists, false);
    assert.equal(missing.count, 0);
    await writeFile(dirs.agents, JSON.stringify({ mcpServers: { a: GOOD, b: GOOD2 } }), 'utf8');
    const present = await store.readAgentsFile();
    assert.equal(present.count, 2);
    await store.dispose();
  } finally {
    await rm(dirs.base, { recursive: true, force: true });
  }
});
