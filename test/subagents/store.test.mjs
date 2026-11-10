import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSubagentsStore,
  DOMAIN_SPEC,
  normalizeRole,
  normalizePoolModel,
  normalizeDocument,
  sanitizeRoleName,
} from '../../src/host/subagents/store.js';
import { BUILTIN_ROLES, builtinTombstone } from '../../src/host/subagents/builtin.js';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GOOD_ROLE = {
  description: '调研类任务',
  enabled: true,
  models: [
    { provider: 'magpie-responses', model: 'modelhub/glm-5.3', description: '主力线路' },
    { provider: 'magpie-anthropic', model: 'zcode/GLM-5.3', reasoningEffort: 'high' },
  ],
};

async function makeDirs() {
  const base = await mkdtemp(join(tmpdir(), 'subagents-store-'));
  const fallback = join(base, 'store', 'subagents.json');
  await mkdir(join(base, 'store'), { recursive: true });
  return { base, fallback };
}

/** A minimal DomainFacility double honoring the contract the store relies on. */
function fakeFacility(persisted = new Map()) {
  const opened = [];
  return {
    opened,
    async open(spec) {
      assert.equal(spec.name, 'agents_manager_subagents');
      opened.push(spec);
      const records = persisted;
      return {
        table: (name) => ({
          get: (key) => records.get(key),
          entries: () => records.entries(),
          put: async (key, value) => {
            DOMAIN_SPEC.tables.roles.valueSchema.parse(value);
            records.set(key, value);
          },
          delete: async (key) => records.delete(key),
        }),
        get global() {
          return { get: () => ({}), set: async () => {} };
        },
        close: async () => { /* the medium persists across opens */ },
      };
    },
  };
}

test('normalizeRole accepts a full record and fills defaults', () => {
  const result = normalizeRole(GOOD_ROLE);
  assert.equal(result.ok, true);
  assert.equal(result.role.description, '调研类任务');
  assert.equal(result.role.enabled, true);
  assert.equal(result.role.models.length, 2);
  assert.equal(result.role.models[0].description, '主力线路');
  assert.equal(result.role.models[1].reasoningEffort, 'high');
  assert.equal(result.role.promptPrefix, undefined);
});

test('normalizeRole rejects broken records with stable codes', () => {
  assert.equal(normalizeRole(null).error, 'not-object');
  assert.equal(normalizeRole({ models: GOOD_ROLE.models }).error, 'missing-description');
  assert.equal(normalizeRole({ description: 'x', models: [] }).error, 'missing-models');
  assert.equal(normalizeRole({ description: 'x', models: [{ provider: '', model: 'm' }] }).error, 'bad-model');
  assert.equal(
    normalizeRole({ description: 'x', models: [{ provider: 'a', model: 'm' }, { provider: 'a', model: 'm' }] }).error,
    'duplicate-model',
  );
  assert.equal(
    normalizeRole({ description: 'x', models: [{ provider: 'a', model: 'm', reasoningEffort: '  ' }] }).error,
    'bad-effort',
  );
  assert.equal(
    normalizeRole({ ...GOOD_ROLE, maxTokens: 0 }).error,
    'bad-max-tokens',
  );
});

test('normalizeRole validates and dedupes the per-role capability whitelists', () => {
  const clean = normalizeRole({ ...GOOD_ROLE, mcp: ['ops', 'ops', ' web '], skills: ['alpha'] });
  assert.equal(clean.ok, true);
  assert.deepEqual(clean.role.mcp, ['ops', 'web']);
  assert.deepEqual(clean.role.skills, ['alpha']);

  // Absent fields stay absent (follow-the-session semantics).
  const plain = normalizeRole(GOOD_ROLE);
  assert.equal(plain.ok, true);
  assert.equal('mcp' in plain.role, false);
  assert.equal('skills' in plain.role, false);

  // Explicit null means "all" — accepted and dropped (absent ≡ null).
  const all = normalizeRole({ ...GOOD_ROLE, mcp: null, skills: null });
  assert.equal(all.ok, true);
  assert.equal('mcp' in all.role, false);
  assert.equal('skills' in all.role, false);

  assert.equal(normalizeRole({ ...GOOD_ROLE, mcp: 'ops' }).error, 'bad-mcp');
  assert.equal(normalizeRole({ ...GOOD_ROLE, mcp: [''] }).error, 'bad-mcp');
  assert.equal(normalizeRole({ ...GOOD_ROLE, mcp: [42] }).error, 'bad-mcp');
  assert.equal(normalizeRole({ ...GOOD_ROLE, skills: [['x']] }).error, 'bad-skills');
  assert.equal(normalizeRole({ ...GOOD_ROLE, skills: [''] }).error, 'bad-skills');
});

test('sanitizeRoleName normalizes to a bounded kebab suffix', () => {
  assert.equal(sanitizeRoleName('Researcher'), 'researcher');
  assert.equal(sanitizeRoleName('  Web 调研 2 '), 'web-2');
  assert.equal(sanitizeRoleName('---'), '');
  assert.equal(sanitizeRoleName(42), '');
  assert.ok(sanitizeRoleName('a'.repeat(64)).length <= 23);
});

test('file fallback: roundtrip put/list/remove with .bak rotation', async () => {
  const dirs = await makeDirs();
  try {
    const store = createSubagentsStore({ storageDomain: null, fallbackPath: dirs.fallback, builtinRoles: [] });
    await store.init();
    assert.deepEqual(await store.listRoles(), {});
    assert.equal((await store.putRole('researcher', GOOD_ROLE)).ok, true);
    assert.deepEqual(Object.keys(await store.listRoles()), ['researcher']);
    const firstWrite = await readFile(dirs.fallback, 'utf8');
    assert.deepEqual(Object.keys(JSON.parse(firstWrite).roles), ['researcher']);

    const edited = { ...GOOD_ROLE, description: '改' };
    await store.putRole('researcher', edited);
    const backup = JSON.parse(await readFile(`${dirs.fallback}.bak`, 'utf8'));
    assert.deepEqual(backup.roles.researcher, GOOD_ROLE);

    assert.equal((await store.removeRole('researcher')).ok, true);
    assert.equal((await store.removeRole('researcher')).error, 'not-found');
    assert.deepEqual(await store.listRoles(), {});
    assert.equal(store.storeInfo().kind, 'file');
    await store.dispose();
  } finally {
    await rm(dirs.base, { recursive: true, force: true });
  }
});

test('file fallback: malformed config degrades to empty with a recorded error', async () => {
  const dirs = await makeDirs();
  try {
    await writeFile(dirs.fallback, '{not json', 'utf8');
    const store = createSubagentsStore({ storageDomain: null, fallbackPath: dirs.fallback, builtinRoles: [] });
    await store.init();
    assert.deepEqual(await store.listRoles(), {});
    assert.match(store.storeInfo().error ?? '', /bad-json/);
    await store.dispose();
  } finally {
    await rm(dirs.base, { recursive: true, force: true });
  }
});

test('unified storage: reads and writes go through the roles table', async () => {
  const persisted = new Map();
  const facility = fakeFacility(persisted);
  const store = createSubagentsStore({ storageDomain: facility, builtinRoles: [] });
  await store.init();
  assert.equal(store.storeInfo().kind, 'domain');
  await store.putRole('researcher', GOOD_ROLE);
  assert.equal(persisted.get('researcher').models.length, 2);
  assert.deepEqual(Object.keys(await store.listRoles()), ['researcher']);
  await store.removeRole('researcher');
  assert.deepEqual(await store.listRoles(), {});
  await store.dispose();
  assert.equal(facility.opened.length, 1);
});

test('listRoles merges builtins under user records; listUserRoles stays raw', async () => {
  const persisted = new Map();
  const store = createSubagentsStore({ storageDomain: fakeFacility(persisted) });
  await store.init();
  // Nothing stored: the whole catalog materializes without a single write.
  assert.deepEqual(Object.keys(await store.listRoles()), BUILTIN_ROLES.map((def) => def.name));
  assert.deepEqual(await store.listUserRoles(), {});

  // A customization overrides its builtin wholesale.
  const custom = { ...GOOD_ROLE, description: '自定义前端' };
  await store.putRole('frontend-dev', custom);
  assert.equal((await store.listRoles())['frontend-dev'], custom);

  // A tombstone hides its builtin while staying visible in the raw records.
  await store.putRole('architect', builtinTombstone('architect'));
  assert.equal((await store.listRoles()).architect, undefined);
  assert.deepEqual(Object.keys(await store.listUserRoles()).sort(), ['architect', 'frontend-dev']);
  await store.dispose();
});

test('normalizeDocument validates the whole fallback document', () => {
  assert.equal(normalizeDocument({ roles: { ok: GOOD_ROLE } }).ok, true);
  const broken = normalizeDocument({ roles: { bad: { description: '', models: [] } } });
  assert.equal(broken.ok, false);
  assert.match(broken.error, /^bad:/);
  assert.equal(normalizeDocument([]).error, 'not-object');
});


test('normalizePoolModel carries the expose flag (absent means exposed)', () => {
  const plain = normalizePoolModel({ provider: 'p1', model: 'm1' });
  assert.equal(plain.ok, true);
  assert.equal(plain.entry.expose, true, 'legacy entries stay exposed');

  const hidden = normalizePoolModel({ provider: 'p1', model: 'm1', expose: false });
  assert.equal(hidden.ok, true);
  assert.equal(hidden.entry.expose, false);

  const truthy = normalizePoolModel({ provider: 'p1', model: 'm1', expose: 'yes' });
  assert.equal(truthy.entry.expose, false, 'only explicit true counts');
});
