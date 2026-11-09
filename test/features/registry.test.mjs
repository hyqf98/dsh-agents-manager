import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFeatureRegistry } from '../../src/host/features/registry.js';
import { apply as applySubagents } from '../../src/host/features/subagents.js';
import { apply as applyRetry } from '../../src/host/features/retry.js';
import { apply as applyProcesses } from '../../src/host/features/processes.js';

test('feature rows export the core injection contract', async () => {
  for (const row of [applySubagents, applyRetry, applyProcesses]) {
    assert.equal(typeof row, 'function');
  }
  const subagents = await import('../../src/host/features/subagents.js');
  assert.deepEqual(['agents-manager:core'], subagents.inject);
});

test('registry: register, live contributions, unregister', () => {
  const registry = createFeatureRegistry();
  assert.deepEqual(registry.activeFeatures(), []);

  const disposeA = registry.register('alpha', {
    toolDefinitions: () => [{ name: 'tool_a' }, { name: 'tool_a2' }],
    apiServices: () => ({ alphaStore: { marker: 'a' } }),
  });
  assert.deepEqual(registry.activeFeatures(), ['alpha']);
  assert.deepEqual(
    registry.toolDefinitions(null).map((definition) => definition.name),
    ['tool_a', 'tool_a2'],
  );
  assert.deepEqual(registry.apiServices(), { alphaStore: { marker: 'a' } });

  const disposeB = registry.register('beta', {
    toolDefinitions: () => [{ name: 'tool_b' }],
    apiServices: () => ({ betaStore: { marker: 'b' } }),
  });
  // Sorted ids, contributions in id order.
  assert.deepEqual(registry.activeFeatures(), ['alpha', 'beta']);
  assert.deepEqual(
    registry.toolDefinitions(null).map((definition) => definition.name),
    ['tool_a', 'tool_a2', 'tool_b'],
  );
  assert.deepEqual(registry.apiServices(), { alphaStore: { marker: 'a' }, betaStore: { marker: 'b' } });

  // A failing contribution never breaks the fold.
  disposeA();
  registry.register('gamma', {
    toolDefinitions: () => { throw new Error('broken'); },
    apiServices: () => { throw new Error('broken'); },
  });
  assert.deepEqual(registry.toolDefinitions(null).map((definition) => definition.name), ['tool_b']);
  assert.deepEqual(registry.apiServices(), { betaStore: { marker: 'b' } });

  disposeB();
  assert.deepEqual(registry.activeFeatures(), ['gamma']);
  // gamma's folds throw; the registry survives with empty contributions.
  assert.deepEqual(registry.toolDefinitions(null), []);
  assert.deepEqual(registry.apiServices(), {});
});
