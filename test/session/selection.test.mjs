import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSelectionStore } from '../../src/host/session/selection.js';

test('default selection is all (null)', () => {
  const store = createSelectionStore();
  assert.deepEqual(store.get('s1'), { mcp: null, skills: null });
  assert.equal(store.mcpEnabled('s1', 'anything'), true);
  assert.equal(store.skillEnabled('s1', 'anything'), true);
});

test('set stores explicit arrays and resets with null', () => {
  const store = createSelectionStore();
  store.set('s1', { mcp: ['a', 'b'], skills: ['x'] });
  assert.deepEqual(store.get('s1'), { mcp: ['a', 'b'], skills: ['x'] });
  assert.equal(store.mcpEnabled('s1', 'a'), true);
  assert.equal(store.mcpEnabled('s1', 'c'), false);
  assert.equal(store.skillEnabled('s1', 'x'), true);
  assert.equal(store.skillEnabled('s1', 'y'), false);
  store.set('s1', { mcp: null, skills: null });
  assert.deepEqual(store.get('s1'), { mcp: null, skills: null });
  assert.equal(store.mcpEnabled('s1', 'c'), true);
});

test('set dedupes and drops non-string entries', () => {
  const store = createSelectionStore();
  store.set('s1', { mcp: ['a', 'a', 'b'], skills: ['x', 42] });
  assert.deepEqual(store.get('s1'), { mcp: ['a', 'b'], skills: ['x'] });
});

test('onChange fires on change and clear drops the session', () => {
  const store = createSelectionStore();
  const seen = [];
  store.onChange((sessionId) => seen.push(sessionId));
  store.set('s1', { mcp: ['a'] });
  assert.deepEqual(seen, ['s1']);
  // A no-op set (already all) does not fire.
  store.set('s2', {});
  assert.deepEqual(seen, ['s1']);
  store.clear('s1');
  assert.deepEqual(store.get('s1'), { mcp: null, skills: null });
});
