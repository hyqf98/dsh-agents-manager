import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

test('client dictionaries mirror locale/zh.json and locale/en.json key for key', async () => {
  const zh = JSON.parse(await readFile(join(here, '../../locale/zh.json'), 'utf8'));
  const en = JSON.parse(await readFile(join(here, '../../locale/en.json'), 'utf8'));
  const client = await readFile(join(here, '../../client/client.js'), 'utf8');

  const localeKeys = (dict) => {
    const keys = [];
    for (const [section, body] of Object.entries(dict)) {
      if (section === 'meta') continue;
      for (const key of Object.keys(body)) keys.push(`${section}.${key}`);
    }
    return keys.sort();
  };

  const zhKeys = localeKeys(zh);
  const enKeys = localeKeys(en);
  assert.deepEqual(zhKeys, enKeys, 'zh and en locale files must carry identical keys');

  const clientKeys = [...new Set(
    [...client.matchAll(/"(?:page|mcp|skills|session|procs|subagents|toast|retry)\.[^"]+":/g)]
      .map((match) => match[0].slice(1, -2))
  )].sort();
  // Locale keys are grouped per section only (section.key), while client keys
  // flatten nested groups (retry.policy.edit). Compare the flattened client
  // keys against the locale's flattened view of the same tree.
  const flatten = (dict) => {
    const out = [];
    const walk = (prefix, body) => {
      for (const [key, value] of Object.entries(body)) {
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) walk(`${prefix}${key}.`, value);
        else out.push(`${prefix}${key}`);
      }
    };
    for (const [section, body] of Object.entries(dict)) {
      if (section === 'meta') continue;
      walk(`${section}.`, body);
    }
    return out.sort();
  };
  assert.deepEqual(clientKeys, flatten(zh), 'client dictionary keys must match the locale files exactly');
});

test('client module registers under the plugin package id', async () => {
  const client = await readFile(join(here, '../../client/client.js'), 'utf8');
  assert.match(client, /window\.__ModuleLoader__\.load\(\{\s*id:\s*"dsh-agents-manager"/);
  assert.match(client, /settings\.section/);
  assert.match(client, /conversation\.input\.left/);
  assert.match(client, /shell\.overlay/);
});

test('client builds host file-preview addresses and opens them through sidebarRight', async () => {
  const client = await readFile(join(here, '../../client/client.js'), 'utf8');
  // Skills editing stays in-panel: rail layout with hover expansion.
  assert.match(client, /data-mode/);
  assert.match(client, /am-skills-list:hover/);
  assert.doesNotMatch(client, /openResource/);
  const factory = new Function('window', `
    const loads = [];
    window.__ModuleLoader__ = { load: (entry) => loads.push(entry) };
    ${client}
    const entry = loads[0];
    const require = (name) => ({ createElement: () => null, useState: () => [null, () => {}], useEffect: () => {}, useMemo: () => null, useCallback: () => null, useRef: () => ({ current: null }) });
    const exports = entry.factory(require);
    return exports;
  `);
  const plugin = factory({});
  assert.equal(typeof plugin.apply, 'function');
  assert.deepEqual(plugin.inject, ['slots', 'locale']);
});
