import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPendingCapabilities } from '../../src/host/session/pending-capabilities.js';

test('reserve/consume: single-use handoff keyed by the parent session', () => {
  const caps = createPendingCapabilities();
  caps.reserve('parent-1', { mcp: ['ops'], skills: null });
  const consumed = caps.consume('parent-1');
  assert.deepEqual(consumed, { mcp: ['ops'], skills: null });
  assert.equal(caps.consume('parent-1'), null, 'consumption is single-use');
  assert.equal(caps.consume('unknown'), null);
});

test('reserve: unconsumed reservations expire instead of leaking to later children', () => {
  let tick = 0;
  const caps = createPendingCapabilities({ now: () => tick });
  caps.reserve('p', { mcp: ['a'], skills: ['s'] });
  tick = 60_001;
  caps.reserve('other', { mcp: [], skills: [] }); // sweep runs on write
  assert.equal(caps.consume('p'), null, 'the stale reservation was swept');
  assert.deepEqual(caps.consume('other'), { mcp: [], skills: [] });
});

test('reserve: blank parent ids are ignored; dispose clears everything', () => {
  const caps = createPendingCapabilities();
  caps.reserve('', { mcp: ['a'], skills: null });
  assert.equal(caps.consume(''), null);
  caps.reserve('p', { mcp: null, skills: ['x'] });
  caps.dispose();
  assert.equal(caps.consume('p'), null);
});

test('disposeParent: a disposed delegating session drops its reservation', () => {
  const caps = createPendingCapabilities();
  caps.reserve('p', { mcp: ['a'], skills: null });
  caps.disposeParent('p');
  assert.equal(caps.consume('p'), null);
  // Unrelated reservations survive.
  caps.reserve('q', { mcp: ['b'], skills: null });
  caps.disposeParent('p');
  assert.deepEqual(caps.consume('q'), { mcp: ['b'], skills: null });
});
