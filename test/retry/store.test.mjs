/**
 * Retry-store tests: file fallback round-trips, snapshot refresh, validation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRetryStore, readConfig } from '../../src/host/retry/store.js';

const GOOD_RULE = {
  name: 'zhipu-5h',
  when: '已达到\\s*5\\s*小时的?使用上限',
  codes: ['RATE_LIMIT', 'QUOTA', 'PI_AI_ERROR'],
  wait: { kind: 'reset-at', tz: '+08:00' },
};

test('readConfig: missing file is an empty store', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retry-store-'));
  try {
    const read = await readConfig(join(root, 'retry.json'));
    assert.ok(read.ok);
    assert.deepEqual(read.rules, []);
    assert.equal(read.exists, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('file store: save, read, delete, snapshot refresh', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retry-store-'));
  try {
    const store = createRetryStore({ fallbackPath: join(root, 'retry.json') });
    await store.init();
    assert.equal(store.storeInfo().kind, 'file');

    const saved = await store.saveDocument([GOOD_RULE], { maxDelayMs: 21_600_000 });
    assert.ok(saved.ok);
    assert.equal(store.current().rules.length, 1);
    assert.equal(store.current().fallback.maxDelayMs, 21_600_000);

    // Round-trip through a fresh store (same file).
    const second = createRetryStore({ fallbackPath: join(root, 'retry.json') });
    await second.init();
    assert.equal(second.current().rules[0].name, 'zhipu-5h');
    assert.equal(second.current().fallback.maxDelayMs, 21_600_000);

    const removed = await second.removeRule('zhipu-5h');
    assert.ok(removed.ok);
    assert.equal(second.current().rules.length, 0);

    const missing = await second.removeRule('nope');
    assert.equal(missing.error, 'not-found');

    await store.dispose();
    await second.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('putRule upserts by name without duplicating', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retry-store-'));
  try {
    const store = createRetryStore({ fallbackPath: join(root, 'retry.json') });
    await store.init();
    await store.putRule(GOOD_RULE);
    await store.putRule({ ...GOOD_RULE, maxRetries: 9 });
    assert.equal(store.current().rules.length, 1);
    assert.equal(store.current().rules[0].maxRetries, 9);
    await store.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('invalid stored rules surface through storeInfo().error and degrade to empty', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retry-store-'));
  try {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(root, 'retry.json'), JSON.stringify({ rules: [{ name: 'bad', when: '(', wait: { kind: 'retry-after' } }] }), 'utf8');
    const store = createRetryStore({ fallbackPath: join(root, 'retry.json') });
    await store.init();
    assert.equal(store.current().rules.length, 0);
    // The un-normalizable rule is rejected at read time with its stable code.
    assert.match(store.storeInfo().error, /bad-when|invalid-rules/);
    await store.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('domain backend: open, save, snapshot, dispose', async () => {
  /** Minimal fake storageDomain facility. */
  const rules = new Map();
  let globals = {};
  const facility = {
    async open() {
      return {
        table: (name) => ({
          entries: () => [...rules.entries()],
          keys: () => [...rules.keys()],
          put: async (key, value) => { rules.set(key, value); },
          delete: async (key) => { rules.delete(key); },
        }),
        global: {
          get: () => globals,
          set: async (next) => { globals = next; },
        },
        close: async () => {},
      };
    },
  };
  const store = createRetryStore({ storageDomain: facility, fallbackPath: '/nonexistent/retry.json' });
  await store.init();
  assert.equal(store.storeInfo().kind, 'domain');
  await store.saveDocument([GOOD_RULE], { maxDelayMs: 3_600_000 });
  assert.equal(store.current().rules[0].name, 'zhipu-5h');
  assert.equal(store.current().fallback.maxDelayMs, 3_600_000);
  const removed = await store.removeRule('zhipu-5h');
  assert.ok(removed.ok);
  assert.equal(store.current().rules.length, 0);
  await store.dispose();
});

test('file→domain migration: an empty domain converges with the fallback file once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retry-store-'));
  try {
    const { writeFile } = await import('node:fs/promises');
    const fallbackPath = join(root, 'retry.json');
    // Rules were written through the file backend on a boot where the domain
    // facility was not composed yet.
    await writeFile(fallbackPath, JSON.stringify({ rules: [GOOD_RULE], fallback: { maxDelayMs: 7_200_000 } }), 'utf8');

    /** Minimal fake domain sharing the store's table shape. */
    const rules = new Map();
    let globals = {};
    const facility = {
      async open() {
        return {
          table: () => ({
            entries: () => [...rules.entries()],
            keys: () => [...rules.keys()],
            put: async (key, value) => { rules.set(key, value); },
            delete: async (key) => { rules.delete(key); },
          }),
          global: {
            get: () => globals,
            set: async (next) => { globals = next; },
          },
          close: async () => {},
        };
      },
    };
    const logs = [];
    const store = createRetryStore({ storageDomain: facility, fallbackPath, log: (m) => logs.push(m) });
    await store.init();
    assert.equal(store.storeInfo().kind, 'domain');
    assert.equal(store.current().rules.length, 1);
    assert.equal(store.current().rules[0].name, 'zhipu-5h');
    assert.equal(store.current().fallback.maxDelayMs, 7_200_000);
    assert.ok(logs.some((line) => line.includes('migrated 1 retry rule')));

    // Editing rules through the live (domain) store now wins over the stale file.
    rules.set('other', { name: 'other', when: 'x', wait: { kind: 'retry-after' } });
    await store.init();
    assert.equal(store.current().rules.length, 2);
    await store.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('file→domain migration: a non-empty domain is never overwritten by the file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retry-store-'));
  try {
    const { writeFile } = await import('node:fs/promises');
    const fallbackPath = join(root, 'retry.json');
    await writeFile(fallbackPath, JSON.stringify({ rules: [{ ...GOOD_RULE, name: 'stale-file-rule' }], fallback: {} }), 'utf8');

    const rules = new Map([['live-rule', { ...GOOD_RULE, name: 'live-rule' }]]);
    const facility = {
      async open() {
        return {
          table: () => ({
            entries: () => [...rules.entries()],
            keys: () => [...rules.keys()],
            put: async (key, value) => { rules.set(key, value); },
            delete: async (key) => { rules.delete(key); },
          }),
          global: { get: () => ({}), set: async () => {} },
          close: async () => {},
        };
      },
    };
    const store = createRetryStore({ storageDomain: facility, fallbackPath });
    await store.init();
    const names = store.current().rules.map((rule) => rule.name);
    assert.deepEqual(names, ['live-rule']);
    await store.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
