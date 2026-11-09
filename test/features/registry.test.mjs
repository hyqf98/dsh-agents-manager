import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFeatureRegistry } from '../../src/host/features/registry.js';
import { apply as applyCapabilities } from '../../src/host/features/capabilities.js';
import { apply as applySubagents } from '../../src/host/features/subagents.js';
import { apply as applyRetry } from '../../src/host/features/retry.js';
import { apply as applyProcesses } from '../../src/host/features/processes.js';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

test('feature rows export the core injection contract', async () => {
  for (const row of [applyCapabilities, applySubagents, applyRetry, applyProcesses]) {
    assert.equal(typeof row, 'function');
  }
  for (const name of ['capabilities', 'subagents', 'retry', 'processes']) {
    const row = await import(`../../src/host/features/${name}.js`);
    assert.deepEqual(['agents-manager:core'], row.inject, `${name} row injects the core service`);
  }
});

test('each feature row ships zh+en locale meta for the plugin detail page', async () => {
  for (const name of ['capabilities', 'subagents', 'retry', 'processes']) {
    for (const lang of ['zh', 'en']) {
      const meta = JSON.parse(await readFile(join(here, '../../locale', name, `${lang}.json`), 'utf8')).meta;
      assert.equal(typeof meta.title, 'string', `${name}/${lang} meta.title`);
      assert.ok(meta.title.trim() !== '', `${name}/${lang} meta.title is non-empty`);
      assert.equal(typeof meta.description, 'string', `${name}/${lang} meta.description`);
      assert.ok(meta.description.trim() !== '', `${name}/${lang} meta.description is non-empty`);
    }
  }
});

test('patch rows and package exports cover every feature row', async () => {
  const patch = await readFile(join(here, '../../cordis.patch.yml'), 'utf8');
  const manifest = JSON.parse(await readFile(join(here, '../../package.json'), 'utf8'));
  for (const name of ['capabilities', 'subagents', 'retry', 'processes']) {
    assert.match(patch, new RegExp(`agents-manager-${name}`), `patch declares the ${name} row`);
    assert.ok(manifest.exports[`./${name}`], `exports maps ./${name}`);
    assert.ok(manifest.exports[`./${name}/locale/*.json`], `exports maps ./${name}/locale/*.json`);
  }
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
