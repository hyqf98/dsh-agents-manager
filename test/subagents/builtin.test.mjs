import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILTIN_ROLES,
  builtinRoleMap,
  builtinStates,
  builtinTombstone,
  isBuiltinRoleName,
  isBuiltinTombstone,
  mergeBuiltinRoles,
} from '../../src/host/subagents/builtin.js';
import { DOMAIN_SPEC, normalizeRole } from '../../src/host/subagents/store.js';

test('the built-in catalog is well-formed: unique bounded kebab names, non-empty texts, pool-open, no pinned models', () => {
  const seen = new Set();
  for (const def of BUILTIN_ROLES) {
    assert.match(def.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.ok(def.name.length <= 23);
    assert.equal(seen.has(def.name), false);
    seen.add(def.name);
    assert.notEqual(def.description.trim(), '');
    assert.notEqual(def.promptPrefix.trim(), '');
    assert.equal(def.enabled, true);
    assert.equal(def.openPool, true);
    assert.deepEqual(def.models, []);
    // A materialized builtin must satisfy the domain's role schema so a
    // customization round-trip never meets a shape storage rejects.
    const { name: _name, ...role } = def;
    DOMAIN_SPEC.tables.roles.valueSchema.parse(role);
  }
  // The nine shipped personas, in catalog order.
  assert.deepEqual(BUILTIN_ROLES.map((def) => def.name), [
    'frontend-dev',
    'backend-dev',
    'test-engineer',
    'architect',
    'product-designer',
    'visual-expert',
    'effort-estimator',
    'task-planner',
    'code-reviewer',
  ]);
  assert.equal(builtinRoleMap()['code-reviewer'] !== undefined, true);
});

test('mergeBuiltinRoles materializes defaults, overrides with user records, hides tombstones, passes user roles through', () => {
  const custom = { description: '自定义', enabled: true, models: [{ provider: 'p', model: 'm' }] };
  const merged = mergeBuiltinRoles({
    architect: custom,
    'frontend-dev': builtinTombstone('frontend-dev'),
    researcher: custom,
  });
  // The hidden builtin is dropped entirely; catalog order is preserved.
  assert.equal(merged['frontend-dev'], undefined);
  assert.equal(Object.keys(merged)[0], 'backend-dev');
  // A user record overrides its builtin wholesale; others materialize without
  // the catalog-only `name` key; non-builtin user roles pass through.
  assert.equal(merged.architect, custom);
  assert.equal(merged.researcher, custom);
  assert.equal('name' in merged['task-planner'], false);
  assert.notEqual(merged['task-planner'].promptPrefix, undefined);
  assert.equal(merged['task-planner'].openPool, true);
  // Absent user storage degrades to the catalog alone.
  assert.equal(Object.keys(mergeBuiltinRoles(null)).length, BUILTIN_ROLES.length);
});

test('builtinStates classifies each builtin from the stored records', () => {
  const states = builtinStates({
    architect: { description: 'x', enabled: true, models: [{ provider: 'p', model: 'm' }] },
    'frontend-dev': builtinTombstone('frontend-dev'),
  });
  assert.equal(states.architect, 'customized');
  assert.equal(states['frontend-dev'], 'hidden');
  assert.equal(states['task-planner'], 'default');
  assert.equal(Object.keys(states).length, BUILTIN_ROLES.length);
  // A disabled-but-modeled record is a customization, not a tombstone.
  assert.equal(builtinStates({ architect: builtinTombstone('architect') }).architect, 'hidden');
  assert.equal(builtinStates({
    architect: { ...builtinTombstone('architect'), models: [{ provider: 'p', model: 'm' }] },
  }).architect, 'customized');
});

test('tombstones are unambiguous and schema-valid', () => {
  const tombstone = builtinTombstone('frontend-dev');
  assert.equal(isBuiltinTombstone(tombstone), true);
  assert.equal(isBuiltinTombstone({ description: 'x', enabled: false, models: [{ provider: 'p', model: 'm' }] }), false);
  assert.equal(isBuiltinTombstone({ description: 'x', enabled: true, models: [] }), false);
  assert.equal(isBuiltinRoleName('frontend-dev'), true);
  assert.equal(isBuiltinRoleName('nope'), false);
  assert.equal(builtinTombstone('nope'), null);
  DOMAIN_SPEC.tables.roles.valueSchema.parse(tombstone);
  // …and the save path can never produce one by accident.
  assert.equal(normalizeRole(tombstone).error, 'missing-models');
});

test('normalizeRole keeps rejecting empty model lists unless the caller opts in', () => {
  const role = { description: 'd', enabled: true, models: [] };
  assert.equal(normalizeRole(role).error, 'missing-models');
  const allowed = normalizeRole(role, { allowEmptyModels: true });
  assert.equal(allowed.ok, true);
  assert.deepEqual(allowed.role.models, []);
});
