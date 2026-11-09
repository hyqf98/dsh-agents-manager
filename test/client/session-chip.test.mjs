import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

const client = await readFile(new URL('../../client/client.js', import.meta.url), 'utf8');

/** Controller-shaped source used by real React subscription hooks. */
function source(initial) {
  let value = initial;
  const listeners = new Set();
  return {
    getSnapshot: () => value,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    publish(next) { value = next; for (const fn of listeners) fn(); },
    get listenerCount() { return listeners.size; },
  };
}

/** Implements the public Slot selector contract, not a custom renderer. */
function selectorHook(store) {
  return function useSnapshot(select) {
    return select(React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot));
  };
}

function blank(id, overrides = {}) {
  return {
    sessionId: id, blank: true, openState: 'open', subagent: null, removed: false,
    running: false, pendingSubmissions: [], promptAttempted: false, awaitingFirstTurn: false,
    ...overrides,
  };
}
const reply = (body, status = 200) => ({ ok: status === 200, status, text: async () => JSON.stringify(body) });
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

/**
 * Mount the actual composer registration from the shipped CJS factory. The
 * chip gate reads the seat's own per-session projection face
 * (useProjection('sessionListMetadata'), the official keyed-hook contract),
 * so the fixture materializes one source per (sessionId, key), exactly like
 * binding.session.projections.faceOf(key) resolves per session scope.
 */
async function fixture(t, options = {}) {
  const session = source(options.session ?? blank('s'));
  const seeded = options.projections ?? {};
  const projections = new Map();
  let currentId = String(session.getSnapshot().sessionId);
  const useProjection = (key) => {
    const k = `${currentId}\n${key}`;
    let s = projections.get(k);
    if (s === undefined) {
      s = source(Object.prototype.hasOwnProperty.call(seeded, currentId) ? seeded[currentId]?.[key] : undefined);
      projections.set(k, s);
    }
    return React.useSyncExternalStore(s.subscribe, s.getSnapshot, s.getSnapshot);
  };
  const requests = [], intervals = new Map(), timeouts = new Map(), domListeners = new Set();
  let nextTimer = 0, factory, Entry, root;
  const sandbox = {
    console,
    window: { __ModuleLoader__: { load(entry) { factory = entry.factory; } } },
    document: {
      querySelectorAll: () => [], querySelector: () => ({}),
      addEventListener: (_type, fn) => domListeners.add(fn),
      removeEventListener: (_type, fn) => domListeners.delete(fn),
    },
    fetch: async (url) => {
      requests.push(url);
      if (url.includes('/session/fresh?')) return options.fresh ? options.fresh(url) : reply({ fresh: true });
      if (url.includes('/session/selection?')) return reply({ selection: { mcp: null, skills: null } });
      return reply({ servers: {}, skills: [], pool: {}, features: ['capabilities', 'subagents', 'retry', 'processes'] });
    },
    setInterval(fn, ms) { intervals.set(++nextTimer, { fn, ms }); return nextTimer; },
    clearInterval(id) { intervals.delete(id); },
    setTimeout(fn, ms) { timeouts.set(++nextTimer, { fn, ms }); return nextTimer; },
    clearTimeout(id) { timeouts.delete(id); },
  };
  runInNewContext(client, sandbox, { filename: 'client/client.js' });
  const plugin = factory((name) => { assert.equal(name, 'react'); return React; });
  plugin.apply({
    locale: { register() {}, bind: () => (key) => key, subscribe: () => () => {} },
    slots: {
      inject: (_key, effect) => effect(),
      register(meta, component) {
        if (meta.name === 'conversation.input.left') Entry = component;
        return () => {};
      },
    },
  });
  // apply() seats the chip after the /state feature fetch resolves.
  for (let spin = 0; spin < 40 && Entry === undefined; spin += 1) {
    await Promise.resolve();
    await Promise.resolve();
  }
  assert.equal(typeof Entry, 'function');
  let props = { sessionId: currentId, useSession: selectorHook(session), useProjection };
  /** Chip-relevant polls: everything except the one-time /state feature read. */
  const chipRequests = () => requests.filter((url) => !String(url).includes('/state'));
  const f = {
    session, useProjection, requests, chipRequests, intervals, timeouts, domListeners,
    /** Publish one session's projected value, as the opened page or a control frame would. */
    projection(id, key, value) { projections.get(`${id}\n${key}`)?.publish(value); },
    listenersOf(id, key) { return projections.get(`${id}\n${key}`)?.listenerCount ?? 0; },
    async render(patch = {}) {
      props = { ...props, ...patch };
      if (props.sessionId !== undefined && props.sessionId !== null) currentId = String(props.sessionId);
      await act(async () => {
        const element = React.createElement(Entry, props);
        if (root) root.update(element);
        else root = TestRenderer.create(element);
      });
    },
    chips: () => root.root.findAll((node) => node.type === 'button' && node.props.className === 'am-chip'),
    popovers: () => root.root.findAll((node) => node.props.className === 'am-pop'),
    async unmount() { if (root) await act(async () => root.unmount()); root = null; },
  };
  t.after(f.unmount);
  return f;
}

test('cold history stays hidden while its projection is unseeded, then stays hidden once folded', async (t) => {
  // Cold start: the Session object conservatively reports blank=true for an
  // id the list has not reconciled yet; only the opened page's own fold decides.
  const f = await fixture(t, { session: blank('history'), projections: { history: {} } });
  await f.render();
  assert.equal(f.chips().length, 0, 'unseeded sessionListMetadata never authorizes the chip');
  await act(async () => f.projection('history', 'sessionListMetadata', { blank: false, lastPromptAt: 1 }));
  assert.equal(f.chips().length, 0);
  assert.equal(f.chipRequests().length, 0, 'hidden history does not poll chip endpoints');
  assert.equal(f.timeouts.size, 0, 'no timeout bypasses authoritative state');
});

test('an authoritative history fold vetoes a stale blank session object', async (t) => {
  const f = await fixture(t, {
    session: blank('history'),
    projections: { history: { sessionListMetadata: { blank: false, lastPromptAt: 1 } } },
  });
  await f.render();
  assert.equal(f.chips().length, 0);
  assert.equal(f.chipRequests().length, 0);
});

test('a cold-start blank session appears once its opened page seeds blank metadata', async (t) => {
  const f = await fixture(t, { session: blank('s', { openState: 'loading' }), projections: { s: {} } });
  await f.render();
  assert.equal(f.chips().length, 0, 'still opening: not yet authorized');
  await act(async () => f.session.publish(blank('s')));
  assert.equal(f.chips().length, 0, 'opened but unseeded: still unknown');
  await act(async () => f.projection('s', 'sessionListMetadata', { blank: true, lastPromptAt: null }));
  assert.equal(f.chips().length, 1);
});

test('a missing projection hook never authorizes selection', async (t) => {
  const f = await fixture(t, { projections: { s: { sessionListMetadata: { blank: true, lastPromptAt: null } } } });
  await f.render();
  assert.equal(f.chips().length, 1);
  await f.render({ useProjection: undefined });
  assert.equal(f.chips().length, 0);
  await f.render({ useProjection: undefined, useSession: undefined });
  assert.equal(f.chips().length, 0);
  await f.render({ useProjection: f.useProjection, useSession: selectorHook(f.session) });
  assert.equal(f.chips().length, 1);
});

for (const [name, overrides] of [
  ['resident history', { blank: false }],
  ['subagent', { subagent: { address: {} } }],
  ['removed', { removed: true }],
  ['opening failed', { openState: 'error' }],
  ['running', { running: true }],
  ['prompt attempted', { promptAttempted: true }],
  ['awaiting first turn', { awaitingFirstTurn: true }],
]) {
  test(`${name} vetoes a seeded blank projection and Host fresh=true`, async (t) => {
    const f = await fixture(t, {
      session: blank('s', overrides),
      projections: { s: { sessionListMetadata: { blank: true, lastPromptAt: null } } },
    });
    await f.render();
    assert.equal(f.chips().length, 0);
    assert.equal(f.chipRequests().length, 0);
  });
}

test('first submission removes chip and popover immediately, before Host polling', async (t) => {
  const f = await fixture(t, { projections: { s: { sessionListMetadata: { blank: true, lastPromptAt: null } } } });
  await f.render();
  assert.equal(f.chips().length, 1);
  await act(async () => f.chips()[0].props.onClick());
  assert.equal(f.popovers().length, 1);
  await act(async () => f.session.publish(blank('s', { pendingSubmissions: [{ requestId: 'pending' }] })));
  assert.equal(f.chips().length, 0);
  assert.equal(f.popovers().length, 0);
  assert.equal(f.intervals.size, 0);
  assert.equal(f.domListeners.size, 0);
});

test('a later projection correction hides a visible chip', async (t) => {
  const f = await fixture(t, { projections: { s: { sessionListMetadata: { blank: true, lastPromptAt: null } } } });
  await f.render();
  assert.equal(f.chips().length, 1);
  await act(async () => f.projection('s', 'sessionListMetadata', { blank: false, lastPromptAt: 2 }));
  assert.equal(f.chips().length, 0);
});

test('history/new/history switching ignores an old session fold and a late Host response', async (t) => {
  const late = deferred();
  const f = await fixture(t, {
    session: blank('history', { blank: false }),
    projections: {
      history: { sessionListMetadata: { blank: false, lastPromptAt: 9 } },
      a: { sessionListMetadata: { blank: true, lastPromptAt: null } },
      b: { sessionListMetadata: { blank: true, lastPromptAt: null } },
    },
    fresh: (url) => url.endsWith('id=a') ? late.promise : reply({ fresh: true }),
  });
  await f.render();
  assert.equal(f.chips().length, 0);
  await act(async () => f.session.publish(blank('a')));
  await f.render({ sessionId: 'a' });
  assert.equal(f.chips().length, 0, 'fresh check still pending for a');
  await act(async () => f.session.publish(blank('b')));
  await f.render({ sessionId: 'b' });
  assert.equal(f.chips().length, 1);
  await act(async () => late.resolve(reply({ fresh: false })));
  assert.equal(f.chips().length, 1, 'late a veto must not hide b');
  await act(async () => {
    f.projection('history', 'sessionListMetadata', { blank: false, lastPromptAt: 9 });
    f.session.publish(blank('history', { blank: false }));
  });
  await f.render({ sessionId: 'history' });
  assert.equal(f.chips().length, 0);
});

test('new session cannot inherit a visible chip or popover while its check is pending', async (t) => {
  const pending = deferred();
  const f = await fixture(t, {
    projections: {
      s: { sessionListMetadata: { blank: true, lastPromptAt: null } },
      next: { sessionListMetadata: { blank: true, lastPromptAt: null } },
    },
    fresh: (url) => url.endsWith('id=next') ? pending.promise : reply({ fresh: true }),
  });
  await f.render();
  await act(async () => f.chips()[0].props.onClick());
  assert.equal(f.popovers().length, 1);
  await act(async () => f.session.publish(blank('next')));
  await f.render({ sessionId: 'next' });
  assert.equal(f.chips().length, 0);
  await act(async () => pending.resolve(reply({ fresh: true })));
  assert.equal(f.chips().length, 1);
  assert.equal(f.popovers().length, 0);
});

test('Host fresh=false remains a veto for a confirmed blank client', async (t) => {
  const f = await fixture(t, {
    fresh: () => reply({ fresh: false }),
    projections: { s: { sessionListMetadata: { blank: true, lastPromptAt: null } } },
  });
  await f.render();
  assert.equal(f.chips().length, 0);
});

test('legacy Host errors allow only a confirmed new session, never history', async (t) => {
  const f = await fixture(t, {
    fresh: () => reply({ error: 'not-supported' }, 501),
    projections: { s: { sessionListMetadata: { blank: true, lastPromptAt: null } } },
  });
  await f.render();
  assert.equal(f.chips().length, 1);
  await act(async () => f.session.publish(blank('s', { blank: false })));
  assert.equal(f.chips().length, 0);
});

test('a delayed fold never times out into visible history', async (t) => {
  const f = await fixture(t, { session: blank('history'), projections: { history: {} } });
  await f.render();
  // Exercise any legacy one-second retry timers past their former 30s limit.
  for (let second = 0; second < 60; second += 1) {
    await act(async () => {
      for (const [id, timer] of [...f.timeouts]) {
        f.timeouts.delete(id);
        timer.fn();
      }
    });
  }
  assert.equal(f.chips().length, 0, 'elapsed time is not evidence of a blank session');
  await act(async () => f.projection('history', 'sessionListMetadata', { blank: false, lastPromptAt: 1 }));
  assert.equal(f.chips().length, 0, 'late fold is observed without switching');
  assert.equal(f.timeouts.size, 0);
});

test('replacing Slot sources unsubscribes the old generation and observes the new one', async (t) => {
  const f = await fixture(t, { projections: { s: { sessionListMetadata: { blank: true, lastPromptAt: null } } } });
  await f.render();
  assert.equal(f.chips().length, 1);
  const nextSession = source(blank('s', { blank: false }));
  await f.render({ useSession: selectorHook(nextSession) });
  assert.equal(f.chips().length, 0);
  assert.equal(f.session.listenerCount, 0, 'old session source unsubscribed');
  assert.ok(f.listenersOf('s', 'sessionListMetadata') >= 0);
  await act(async () => {
    f.projection('s', 'sessionListMetadata', { blank: false, lastPromptAt: 3 });
    nextSession.publish(blank('s', { blank: false }));
  });
  assert.equal(f.chips().length, 0);
  await f.unmount();
  assert.equal(nextSession.listenerCount, 0);
});

test('network errors cannot authorize history but leave a confirmed blank session usable', async (t) => {
  const f = await fixture(t, {
    fresh: () => Promise.reject(new Error('offline')),
    projections: { s: { sessionListMetadata: { blank: true, lastPromptAt: null } } },
  });
  await f.render();
  assert.equal(f.chips().length, 1);
  await act(async () => f.projection('s', 'sessionListMetadata', { blank: false, lastPromptAt: 4 }));
  assert.equal(f.chips().length, 0);
});

test('unmount disposes Slot subscriptions, timers and popover listeners', async (t) => {
  const f = await fixture(t, { projections: { s: { sessionListMetadata: { blank: true, lastPromptAt: null } } } });
  await f.render();
  await act(async () => f.chips()[0].props.onClick());
  assert.ok(f.session.listenerCount > 0);
  assert.ok(f.listenersOf('s', 'sessionListMetadata') > 0);
  await f.unmount();
  assert.equal(f.session.listenerCount, 0);
  assert.equal(f.listenersOf('s', 'sessionListMetadata'), 0);
  assert.equal(f.intervals.size, 0);
  assert.equal(f.timeouts.size, 0);
  assert.equal(f.domListeners.size, 0);
});
