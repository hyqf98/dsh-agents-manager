import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

const client = await readFile(new URL('../../client/client.js', import.meta.url), 'utf8');

/** The procs dictionary slice, so format() placeholders resolve in tests. */
const DICT = {
  'procs.title': '服务进程',
  'procs.tab': '进程',
  'procs.empty': '本会话暂无运行中的服务进程。AI 启动服务后会自动出现在这里。',
  'procs.pill': '{n} 个服务进程',
  'procs.subagent': '子代理',
  'procs.auto': '自动登记',
  'procs.stop': '停止',
  'procs.stopConfirm': '确定停止进程「{name}」？',
  'procs.stopping': '停止中…',
  'procs.errStop': '停止失败：{message}',
  'procs.errNoPid': '该记录未上报 PID，无法远程停止；请让 AI 停止或补报 pid。',
  'procs.errNetwork': '网络异常，请稍后重试。',
  'procs.colName': '服务',
  'procs.colProcess': '进程',
  'procs.colPorts': '端口',
  'procs.colCommand': '启动命令',
  'procs.colAction': '操作',
  'page.loading': '正在加载…',
};

const reply = (body, status = 200) => ({ ok: status === 200, status, text: async () => JSON.stringify(body) });

/**
 * Mount the shipped CJS factory's composer seat (probe path) together with
 * the「进程」conversation-view tab, against a scripted HTTP sandbox.
 */
function fixture(t, options = {}) {
  const requests = [];
  const stops = [];
  const intervals = new Map();
  let nextTimer = 0;
  let factory;
  let Entry;
  let View;
  let root = null;
  let confirmCalls = 0;
  let confirmResult = options.confirmResult ?? true;
  let procsReply = options.procs !== undefined ? options.procs : { ok: true, processes: [] };
  let stopReply = options.stopReply !== undefined ? options.stopReply : () => reply({ ok: true, process: { name: 'vite', status: 'stopped' } });

  const sandbox = {
    console,
    window: {
      __ModuleLoader__: { load(entry) { factory = entry.factory; } },
      confirm() { confirmCalls += 1; return confirmResult; },
      innerWidth: 1440,
    },
    document: {
      querySelectorAll: () => [],
      querySelector: () => ({}),
      addEventListener() {},
      removeEventListener() {},
    },
    fetch: async (url, init) => {
      const href = String(url);
      requests.push(href);
      if (href.includes('/session/processes/stop')) {
        stops.push(init !== undefined && init.body !== undefined ? JSON.parse(init.body) : null);
        return stopReply();
      }
      if (href.includes('/session/processes?')) return reply(procsReply);
      if (href.includes('/session/fresh?')) return reply({ fresh: true });
      // /state answers with every feature row so apply() seats the tab.
      return reply({ ok: true, servers: {}, skills: [], pool: {}, features: ['mcp', 'subagents', 'retry', 'processes'] });
    },
    setInterval(fn, ms) { intervals.set(++nextTimer, { fn, ms }); return nextTimer; },
    clearInterval(id) { intervals.delete(id); },
    setTimeout(fn, ms) { return 0; },
    clearTimeout() {},
  };
  runInNewContext(client, sandbox, { filename: 'client/client.js' });
  const plugin = factory((name) => { assert.equal(name, 'react'); return React; });
  plugin.apply({
    locale: { register() {}, bind: () => (key) => DICT[key] || key, subscribe: () => () => {} },
    slots: {
      inject: (_key, effect) => effect(),
      register(meta, component) {
        if (meta.name === 'conversation.input.left') Entry = component;
        if (meta.name === 'conversation.view' && meta.id === 'agents-manager-processes') View = component;
      },
    },
  });
  // apply() seats every surface after the /state feature fetch resolves:
  // the composer probe (mcp core) and the「进程」tab (processes row).
  async function seatSettles() {
    for (let spin = 0; spin < 40 && (Entry === undefined || View === undefined); spin += 1) {
      await Promise.resolve();
      await Promise.resolve();
    }
  }

  async function render(entryProps = {}) {
    await seatSettles();
    assert.equal(typeof Entry, 'function', 'the composer probe seats for the mcp core');
    assert.equal(typeof View, 'function', 'the process tab seats for the processes feature');
    await act(async () => {
      const element = React.createElement('div', null,
        React.createElement(Entry, entryProps),
        React.createElement(View, null));
      if (root) root.update(element);
      else root = TestRenderer.create(element);
    });
  }

  const findAll = (predicate) => root.root.findAll(predicate);
  const regions = () => findAll((node) => String(node.props.className || '') === 'am-procview');
  const items = () => findAll((node) => String(node.props.className || '') === 'am-proc-item');
  const spansWithText = (text) => findAll((node) => node.type === 'span' && node.props.children === text);
  const hintsWithText = (text) => findAll((node) => node.type === 'p' && node.props.children === text);

  async function click(node) {
    await act(async () => { node.props.onClick({}); });
  }

  const f = {
    requests, stops, intervals,
    render,
    regions, items, spansWithText, hintsWithText, click,
    /** The red icon stop button of the first row (class-based; the glyph carries no text). */
    stopIconButtons: () => regions()[0]
      ? regions()[0].findAll((node) => node.type === 'button' && String(node.props.className || '').includes('am-proc-stop'))
      : [],
    set procsReply(next) { procsReply = next; },
    get confirmCalls() { return confirmCalls; },
    set confirmResult(next) { confirmResult = next; },
    procFetches: () => requests.filter((href) => href.includes('/session/processes?')),
    async unmount() { if (root) await act(async () => { root.unmount(); }); root = null; },
  };
  t.after(f.unmount);
  return f;
}

const RUNNING = [
  { name: 'vite', status: 'running', ports: [5173], pid: 42, url: 'http://127.0.0.1:5173', command: 'pnpm dev', output: 'VITE ready in 321 ms', source: 'main', startedAt: 1, updatedAt: 2 },
  { name: 'api', status: 'running', ports: [8080], source: 'subagent', startedAt: 3, updatedAt: 4 },
];

test('no active session polls nothing and shows the empty tab', async (t) => {
  const f = fixture(t);
  await f.render({});
  assert.equal(f.procFetches().length, 0, 'no session means no process fetch');
  assert.equal(f.hintsWithText(DICT['procs.empty']).length, 1, 'the tab explains itself when idle');
});

test('an active session with no records shows the empty hint but has polled', async (t) => {
  const f = fixture(t);
  await f.render({ sessionId: 's1' });
  assert.equal(f.procFetches().length, 1);
  assert.match(f.procFetches()[0], /id=s1/);
  assert.equal(f.hintsWithText(DICT['procs.empty']).length, 1);
});

test('records render as table rows with per-row stop affordances', async (t) => {
  const f = fixture(t, { procs: { ok: true, processes: RUNNING } });
  await f.render({ sessionId: 's1' });
  assert.equal(f.regions().length, 1);
  assert.equal(f.items().length, 2);
  assert.equal(f.spansWithText('2 个服务进程').length, 1, 'the header shows the record count');

  // One row per service: dot + name + stop button only when running with a pid.
  assert.equal(f.spansWithText('vite').length, 1);
  assert.equal(f.spansWithText('api').length, 1);
  // Every row renders a red icon stop button (■); rows without a pid/jobId
  // stay disabled with an aria-label/title that explains why.
  const allButtons = f.regions()[0].findAll((node) => node.type === 'button' && String(node.props.className || '').includes('am-proc-stop'));
  assert.equal(allButtons.length, 2, 'every row renders an icon stop button');
  const enabledStops = allButtons.filter((button) => button.props['aria-disabled'] !== 'true');
  assert.equal(enabledStops.length, 1, 'only the running pid record can actually stop');
  const disabledStops = allButtons.filter((button) => button.props['aria-disabled'] === 'true');
  assert.match(String(disabledStops[0].props['aria-label'] || ''), /无法远程停止/, 'disabled stop explains itself via aria-label');
  assert.equal(String(allButtons[0].props.children || ''), '■', 'the stop affordance is the icon glyph');

  // Details ride the hover card: a fixed-position card materialised on row
  // mouseenter (outside the table, so it can never be clipped).
  assert.equal(typeof f.items()[0].props.onMouseEnter, 'function', 'rows carry a hover handler');
  assert.equal(typeof f.items()[0].props.onMouseLeave, 'function', 'rows carry a leave handler');
  const rect = { bottom: 120, right: 340 };
  f.items()[0].props.onMouseEnter({ currentTarget: { getBoundingClientRect: () => rect } });
  await Promise.resolve();
  let cards = f.regions()[0].findAll((node) => String(node.props.className || '') === 'am-proc-info');
  assert.equal(cards.length, 1, 'the hover card materialises');
  assert.match(String(cards[0].props.children), /pnpm dev/);
  assert.match(String(cards[0].props.children), /:5173/);
  assert.match(String(cards[0].props.children), /PID 42/);
  assert.match(String(cards[0].props.children), /VITE ready in 321 ms/);
  assert.match(String(cards[0].props.style.top), /px/, 'the card is viewport-positioned');
  f.items()[0].props.onMouseLeave();
  await Promise.resolve();
  cards = f.regions()[0].findAll((node) => String(node.props.className || '') === 'am-proc-info');
  assert.equal(cards.length, 0, 'the card unmounts on leave');

  // Visible columns: name, process id (bare, no prefix), ports, command.
  const badges = f.regions()[0].findAll((node) => String(node.props.className || '').includes('am-badge'));
  const badgeText = badges.map((b) => String(b.props.children)).join('|');
  assert.match(badgeText, /\b42\b/, 'the process column shows the bare pid');
  assert.doesNotMatch(badgeText, /PID 42/, 'without the PID prefix (the header names the column)');
  const headRow = f.regions()[0].findAll((node) => String(node.props.className || '') === 'am-proc-headrow');
  assert.equal(headRow.length, 1, 'the table carries a header row');
  assert.match(String(headRow[0].props.children[0].props.children), /服务|Service/, 'the header names the columns');
  const cmdColumns = f.regions()[0].findAll((node) => String(node.props.className || '') === 'am-proc-cmd');
  assert.match(String(cmdColumns[0].props.children), /pnpm dev/, 'the command column shows the launch command');
});

test('stop asks for confirmation, posts, and rows drop once nothing runs', async (t) => {
  const f = fixture(t, { procs: { ok: true, processes: RUNNING } });
  await f.render({ sessionId: 's1' });
  // The stop settles server-side: the refetch after the POST reads this.
  f.procsReply = { ok: true, processes: [{ ...RUNNING[0], status: 'stopped' }] };
  await f.click(f.stopIconButtons()[0]);
  assert.equal(f.confirmCalls, 1);
  assert.deepEqual(f.stops, [{ sessionId: 's1', name: 'vite' }]);
  assert.equal(f.items().length, 0, 'settled services drop out of the table');
  assert.equal(f.hintsWithText(DICT['procs.empty']).length, 1, 'nothing running shows the empty hint');
});

test('a tab whose every record already settled shows only the empty hint', async (t) => {
  const f = fixture(t, {
    procs: { ok: true, processes: [
      { ...RUNNING[0], status: 'stopped' },
      { ...RUNNING[1], status: 'exited' },
    ] },
  });
  await f.render({ sessionId: 's1' });
  assert.equal(f.procFetches().length, 1, 'the poll still runs');
  assert.equal(f.items().length, 0);
  assert.equal(f.hintsWithText(DICT['procs.empty']).length, 1);
});

test('a declined confirmation never posts; a no-pid failure explains itself', async (t) => {
  const declined = fixture(t, { procs: { ok: true, processes: RUNNING }, confirmResult: false });
  await declined.render({ sessionId: 's1' });
  await declined.click(declined.stopIconButtons()[0]);
  assert.equal(declined.confirmCalls, 1);
  assert.deepEqual(declined.stops, []);

  const noPid = fixture(t, {
    procs: { ok: true, processes: [{ ...RUNNING[1], pid: 7 }] },
    stopReply: () => reply({ ok: false, error: 'no-pid' }, 409),
  });
  await noPid.render({ sessionId: 's1' });
  await noPid.click(noPid.stopIconButtons()[0]);
  assert.deepEqual(noPid.stops, [{ sessionId: 's1', name: 'api' }]);
  const alert = noPid.regions()[0].findAll((node) => String(node.props.className || '') === 'am-proc-msg' && node.props.role === 'alert');
  assert.match(alert[0].props.children, /PID/);
});

test('switching sessions refetches for the new id', async (t) => {
  const f = fixture(t, { procs: { ok: true, processes: RUNNING } });
  await f.render({ sessionId: 's1' });
  assert.match(f.procFetches()[0], /id=s1/);
  await f.render({ sessionId: 's2' });
  assert.equal(f.procFetches().length, 2);
  assert.match(f.procFetches()[1], /id=s2/);
});

test('the tab polls on an interval and cleans it up on unmount', async (t) => {
  const f = fixture(t, { procs: { ok: true, processes: RUNNING } });
  await f.render({ sessionId: 's1' });
  const pollTimers = [...f.intervals.values()].filter((timer) => timer.ms === 4000);
  assert.equal(pollTimers.length, 1);
  await act(async () => { pollTimers[0].fn(); });
  assert.equal(f.procFetches().length, 2);
  await f.unmount();
  assert.equal([...f.intervals.values()].filter((timer) => timer.ms === 4000).length, 0);
});
