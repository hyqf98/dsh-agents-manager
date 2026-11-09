/**
 * Retry HTTP API tests: /retry/state, /retry/rules, /retry/rules/test,
 * /retry/policy, /retry/reset — driven against stub services.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHandler, API_BASE } from '../../src/host/http/api.js';
import { normalizeRule } from '../../src/host/retry/rules.js';

function fakeReq(method, pathname, body) {
  const req = new EventEmitter();
  req.method = method;
  req.url = pathname;
  queueMicrotask(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

function fakeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    headersSent: false,
    sent: null,
    setHeader(key, value) { res.headers[key.toLowerCase()] = String(value); },
    end(text) {
      res.body = String(text ?? '');
      res.headersSent = true;
      res.sent = JSON.parse(res.body);
    },
  };
  return res;
}

const ZHIPU_RULE = {
  name: 'zhipu-5h',
  when: '已达到\\s*5\\s*小时的?使用上限',
  codes: ['RATE_LIMIT', 'QUOTA', 'PI_AI_ERROR'],
  wait: { kind: 'reset-at', tz: '+08:00' },
};

function makeServices() {
  let doc = { rules: [], fallback: { maxDelayMs: 6 * 60 * 60 * 1000 } };
  const retryStore = {
    readDocument: async () => ({ rules: [...doc.rules], fallback: { ...doc.fallback } }),
    saveDocument: async (rules, fallback) => {
      const normalized = rules.map((rule) => normalizeRule(rule)).filter((r) => r.ok);
      if (normalized.length !== rules.length) return { ok: false, error: 'write-failed' };
      doc = { rules: normalized.map((r) => r.rule), fallback };
      return { ok: true };
    },
    storeInfo: () => ({ kind: 'domain', fallbackPath: '/tmp/retry.json', error: null, ruleCount: doc.rules.length }),
  };
  const monitor = () => ({ active: [], recent: [] });
  let policyWrites = [];
  let policyResets = [];
  const services = {
    retryStore,
    retryMonitor: monitor,
    listRetryTargets: async () => [
      { provider: 'magpie', displayName: 'Magpie', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'magpie'], editable: true, policy: { mode: 'normal', maxRetries: 5 } },
    ],
    writeRetryPolicy: async (provider, policy) => {
      policyWrites.push([provider, policy]);
      return { ok: true };
    },
    resetRetryPolicy: async (provider) => {
      policyResets.push(provider);
      return { ok: true };
    },
    retryNow: () => Date.UTC(2026, 8, 22, 5, 0, 0),
  };
  return { ...services, policyWrites: () => policyWrites, policyResets: () => policyResets };
}

async function call(services, method, pathname, body) {
  const handler = createHandler(services);
  const req = fakeReq(method, pathname, body);
  const res = fakeRes();
  await handler(req, res);
  return res;
}

test('GET /retry/state returns targets, rules, presets, monitor', async () => {
  const services = makeServices();
  const res = await call(services, 'GET', `${API_BASE}/retry/state`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.sent.targets[0].provider, 'magpie');
  assert.deepEqual(res.sent.rules, []);
  assert.ok(Array.isArray(res.sent.presets) && res.sent.presets.length >= 13);
  assert.equal(res.sent.fallback.maxDelayMs, 6 * 60 * 60 * 1000);
});

test('POST /retry/rules saves merged rules and validates', async () => {
  const services = makeServices();
  const saved = await call(services, 'POST', `${API_BASE}/retry/rules`, { rules: [ZHIPU_RULE] });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.sent.rules.length, 1);

  const invalid = await call(services, 'POST', `${API_BASE}/retry/rules`, { rules: [{ name: 'x', when: '(', wait: { kind: 'retry-after' } }] });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.sent.error, 'bad-when');

  const merge = await call(services, 'POST', `${API_BASE}/retry/rules`, { rules: [{ name: 'second', when: 'overloaded', wait: { kind: 'retry-after', defaultMs: 5000 } }] });
  assert.equal(merge.sent.rules.length, 2);

  const replace = await call(services, 'POST', `${API_BASE}/retry/rules`, { rules: [{ name: 'only', when: 'x', wait: { kind: 'retry-after' } }], replace: true });
  assert.equal(replace.sent.rules.length, 1);
});

test('POST /retry/rules/test evaluates a rule against pasted text', async () => {
  const services = makeServices();
  const res = await call(services, 'POST', `${API_BASE}/retry/rules/test`, {
    rule: ZHIPU_RULE,
    text: '{"error":{"code":"1308","message":"已达到 5 小时的使用上限。您的限额将在 2026-09-22 13:45:14 重置。"}}',
    code: 'PI_AI_ERROR',
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.sent.outcome.matched, true);
  assert.equal(res.sent.outcome.waitMs, Date.UTC(2026, 8, 22, 5, 45, 14) - Date.UTC(2026, 8, 22, 5, 0, 0));

  const miss = await call(services, 'POST', `${API_BASE}/retry/rules/test`, { rule: ZHIPU_RULE, text: 'nothing' });
  assert.equal(miss.sent.outcome.matched, false);

  const bad = await call(services, 'POST', `${API_BASE}/retry/rules/test`, { rule: { when: '(' }, text: 'x' });
  assert.equal(bad.statusCode, 400);
});

test('POST /retry/policy and /retry/reset write through the manager', async () => {
  const services = makeServices();
  const written = await call(services, 'POST', `${API_BASE}/retry/policy`, {
    provider: 'magpie',
    policy: { mode: 'normal', maxRetries: 8, backoff: { initialDelayMs: 1000, maxDelayMs: 30000 } },
  });
  assert.equal(written.statusCode, 200);
  assert.equal(services.policyWrites().length, 1);
  assert.equal(services.policyWrites()[0][0], 'magpie');

  const badPolicy = await call(services, 'POST', `${API_BASE}/retry/policy`, { provider: 'magpie', policy: { mode: 'nope' } });
  assert.equal(badPolicy.statusCode, 400);

  const reset = await call(services, 'POST', `${API_BASE}/retry/reset`, { provider: 'magpie' });
  assert.equal(reset.statusCode, 200);
  assert.deepEqual(services.policyResets(), ['magpie']);
});

test('retry routes without services degrade to 501', async () => {
  const res = await call({}, 'GET', `${API_BASE}/retry/state`);
  assert.equal(res.statusCode, 501);
  const write = await call({}, 'POST', `${API_BASE}/retry/rules`, { rules: [] });
  assert.equal(write.statusCode, 501);
});
