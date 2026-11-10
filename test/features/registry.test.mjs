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

test('row locale meta resolves through the package self-reference like the host reads it', async () => {
  // dsh-app-boot's readPluginMeta resolves `<specifier>/locale/en.json` through
  // the Node resolver (ERR_PACKAGE_PATH_NOT_EXPORTED = no meta = the detail page
  // falls back to the raw module id as the row title). Resolve the same way and
  // read every locale file in the directory, mirroring dictionariesOf.
  const { createRequire } = await import('node:module');
  const { readdirSync, readFileSync } = await import('node:fs');
  const { dirname: dirnameOf } = await import('node:path');
  const req = createRequire(join(here, '../../src/host/index.js'));
  for (const name of ['capabilities', 'subagents', 'retry', 'processes']) {
    const specifier = `dsh-agents-manager/${name}`;
    const en = req.resolve(`${specifier}/locale/en.json`);
    for (const file of readdirSync(dirnameOf(en))) {
      if (!file.endsWith('.json')) continue;
      const resolved = req.resolve(`${specifier}/locale/${file}`);
      const meta = JSON.parse(readFileSync(resolved, 'utf8')).meta;
      assert.equal(typeof meta?.title, 'string', `${name}/locale/${file} meta.title`);
      assert.ok(meta.title.trim() !== '', `${name}/locale/${file} meta.title is non-empty`);
      assert.equal(typeof meta?.description, 'string', `${name}/locale/${file} meta.description`);
    }
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


test('core + processes row registers report_service_process on the agent binding', async () => {
  const { apply: applyCore } = await import('../../src/host/index.js');
  const { apply: applyProcesses } = await import('../../src/host/features/processes.js');

  let coreService = null;
  /** @type {Record<string, Array<(payload: object) => void>>} */
  const onHandlers = {};
  const makeCtx = (name) => ({
    logger: { warn: (message) => { throw new Error(`unexpected warn from ${name}: ${String(message)}`); } },
    on: (evt, fn) => { (onHandlers[evt] ??= []).push(fn); return () => {}; },
    effect: (fn) => { try { fn(); } catch { /* effects are advisory here */ } return () => {}; },
    provide: (id, svc) => { if (id === 'agents-manager:core') coreService = svc; },
    inject: (names, fn) => {
      if (names.includes('agents-manager:core')) fn({ get: (n) => (n === 'agents-manager:core' ? coreService : undefined) });
      else fn({ get: () => undefined });
    },
  });

  applyCore(makeCtx('core'));
  applyProcesses(makeCtx('processes'));
  assert.deepEqual(coreService.features.activeFeatures(), ['processes']);

  const registered = [];
  const toolsSvc = {
    register: (definition) => { registered.push(definition.name); return () => {}; },
    guard: () => () => {},
    get: () => undefined,
  };
  const detectEvents = [];
  const agent = {
    id: 'sess-1',
    session: { id: 'sess-1' },
    ctx: {
      get: (n) => (n === 'tools' ? toolsSvc : undefined),
      effect: (fn) => { try { fn(); } catch { /* advisory */ } return () => {}; },
      on: (evt) => { detectEvents.push(evt); return () => {}; },
    },
  };
  for (const fn of onHandlers['agent/created'] ?? []) fn({ agent });

  // The report tool rides the raw contribution bundle (not toolDefinitions);
  // this is exactly the wiring both historical breakages lived in.
  assert.ok(registered.includes('report_service_process'), `report tool registered (got: ${registered.join(',') || 'none'})`);
  assert.deepEqual([...new Set(detectEvents)].sort(), ['tools/post-execute', 'tools/pre-execute']);
});
