/**
 * Manager tests: vendor derivation and the enriched retry-target listing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveVendors, listRetryTargets } from '../../src/host/retry/manager.js';

test('deriveVendors: vendors sort by model count, ties keep canonical order', () => {
  const vendors = deriveVendors([
    { id: 'group/gpt-6-astra' },
    { id: 'hj/glm-5.3' },
    { id: 'zcode/GLM-5.3' },
  ]);
  assert.deepEqual(vendors, ['GLM', 'GPT']);
  assert.deepEqual(deriveVendors([
    { id: 'gpt-a' }, { id: 'gpt-b' }, { id: 'gpt-c' }, { id: 'hj/glm-5.3' },
  ]), ['GPT', 'GLM']);
});

test('deriveVendors: a stray minor vendor never makes the title', () => {
  // The magpie-anthropic shape: six GLM models plus one stray deepseek flash —
  // the card title must read GLM alone, not "DeepSeek · GLM".
  const models = [
    { id: 'siji/deepseek-v4.1-flash' },
    { id: 'siji/glm-5.3' },
    { id: 'siji/glm-5.3-flash' },
    { id: 'zcode/GLM-5.3-Flash' },
    { id: 'zcode/GLM-5.2' },
    { id: 'zcode/GLM-5-Turbo' },
    { id: 'zcode/GLM-5.3' },
  ];
  assert.deepEqual(deriveVendors(models), ['GLM']);
});

test('deriveVendors: comparable co-leading vendors both stay', () => {
  const vendors = deriveVendors([
    { id: 'group/gpt-6-astra' },
    { id: 'jiyu/gpt-6-luna' },
    { id: 'jiyu/GLM-5.3' },
    { id: 'hj/glm-5.3' },
    { id: 'hj/glm-5.3-flash' },
  ]);
  assert.deepEqual(vendors, ['GLM', 'GPT']);
});

test('deriveVendors: model names are scanned too', () => {
  assert.deepEqual(deriveVendors([{ id: 'm-unknown', name: 'Kimi K2' }]), ['Kimi']);
  assert.deepEqual(deriveVendors(['kimi/moonshot-v2']), ['Kimi']);
});

test('deriveVendors: unknown models contribute nothing', () => {
  assert.deepEqual(deriveVendors([{ id: 'qoder/qfmodel' }, { id: 'mystery' }]), []);
  assert.deepEqual(deriveVendors([]), []);
  assert.deepEqual(deriveVendors(null), []);
});

/** Fake llm service for listRetryTargets. */
function makeLlm(models, { failListModels = false } = {}) {
  let listCalls = 0;
  return {
    llm: {
      listProviders: () => [{ id: 'magpie', name: 'Magpie' }, { id: 'deepseek-official', name: 'DeepSeek' }],
      listConfigurableProviders: () => [{ provider: 'magpie', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'magpie'] }],
      providerRetryPolicy: () => null,
      listModels: failListModels
        ? async () => { throw new Error('catalog down'); }
        : async (id) => { listCalls += 1; return id === 'magpie' ? models : [{ id: 'deepseek-v4-pro' }]; },
    },
    listCalls: () => listCalls,
  };
}

const ctxOf = (llm) => ({ get: (name) => (name === 'llm' ? llm : undefined) });

test('listRetryTargets: attaches vendors and modelCount per route', async () => {
  const fake = makeLlm([{ id: 'hj/glm-5.3' }, { id: 'group/gpt-6-astra' }, { id: 'claude-opus-5' }]);
  const targets = await listRetryTargets(ctxOf(fake.llm));
  assert.equal(targets.length, 2);
  const magpie = targets.find((t) => t.provider === 'magpie');
  assert.deepEqual(magpie.vendors, ['GLM', 'GPT', 'Claude']);
  assert.equal(magpie.modelCount, 3);
  const official = targets.find((t) => t.provider === 'deepseek-official');
  assert.deepEqual(official.vendors, ['DeepSeek']);
  assert.equal(official.modelCount, 1);
});

test('listRetryTargets: catalog failures degrade to empty vendors', async () => {
  const fake = makeLlm([], { failListModels: true });
  const targets = await listRetryTargets(ctxOf(fake.llm), { cache: new Map() });
  for (const target of targets) {
    assert.deepEqual(target.vendors, []);
    assert.equal(target.modelCount, 0);
  }
});

test('listRetryTargets: model catalog reads go through a TTL cache', async () => {
  const fake = makeLlm([{ id: 'hj/glm-5.3' }]);
  let tick = 0;
  const options = { cache: new Map(), now: () => tick, ttlMs: 10_000 };
  await listRetryTargets(ctxOf(fake.llm), options);
  await listRetryTargets(ctxOf(fake.llm), options); // within TTL: no new read
  assert.equal(fake.listCalls(), 2); // one per provider, first pass only
  tick = 10_001; // TTL elapsed: catalogs re-read
  await listRetryTargets(ctxOf(fake.llm), options);
  assert.equal(fake.listCalls(), 4);
});
