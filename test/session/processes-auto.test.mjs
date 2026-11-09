import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProcessStore } from '../../src/host/session/processes.js';

test('record: auto bridge registrations carry source "auto"', async () => {
  const store = createProcessStore();
  const result = await store.record('session-1', '', { name: 'npm run dev', command: 'npm run dev', source: 'auto' });
  assert.equal(result.ok, true);
  assert.equal(result.record.source, 'auto');
  assert.equal(result.record.status, 'running');
  assert.equal(result.record.pid, undefined);
});

test('record: a manual report takes over an auto record', async () => {
  const store = createProcessStore();
  await store.record('session-1', '', { name: 'vite dev server', command: 'vite', source: 'auto' });
  const takeover = await store.record('session-1', 'session-1', { name: 'vite dev server', port: 5173, pid: 4242, url: 'http://127.0.0.1:5173' });
  assert.equal(takeover.ok, true);
  assert.equal(takeover.record.source, 'main');
  assert.deepEqual(takeover.record.ports, [5173]);
  assert.equal(takeover.record.pid, 4242);
  assert.equal(takeover.created, false, 'the manual report updated, not duplicated');
  const all = store.list('session-1');
  assert.equal(all.length, 1);
});

test('record: an auto update never downgrades a manual record', async () => {
  const store = createProcessStore();
  await store.record('session-1', 'session-1', { name: 'java app', port: 8080, pid: 100 });
  const auto = await store.record('session-1', '', { name: 'java app', status: 'exited', source: 'auto', message: 'background job settled (finished)' });
  assert.equal(auto.ok, true);
  // The auto settle still updates the status (the process did end) but the
  // record keeps its manual origin and inherited fields.
  assert.equal(auto.record.status, 'exited');
  assert.equal(auto.record.source, 'main');
  assert.deepEqual(auto.record.ports, [8080]);
});

test('record: auto settle maps a killed job to stopped', async () => {
  const store = createProcessStore();
  await store.record('s', '', { name: 'svc', source: 'auto' });
  const settled = await store.record('s', '', { name: 'svc', status: 'stopped', source: 'auto', message: 'background job settled (stopped)' });
  assert.equal(settled.record.status, 'stopped');
  assert.equal(settled.record.source, 'auto');
});

test('record: subagent attribution still works next to the auto path', async () => {
  const store = createProcessStore();
  const result = await store.record('root', 'child', { name: 'db', port: 5432 });
  assert.equal(result.record.source, 'subagent');
});
