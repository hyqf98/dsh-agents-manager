import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRoleTools,
  resolveCandidates,
  resolveRoleMcp,
  resolveRoleSkills,
  poolListing,
  buildPoolListTool,
  buildRoleTool,
  outcomeReport,
  parseRouteKey,
  remainingCandidates,
  routeKey,
  joinText,
  TOOL_PREFIX,
} from '../../src/host/subagents/router.js';

const ROLE = {
  description: 'research and summarize',
  enabled: true,
  models: [
    { provider: 'p1', model: 'm1', description: 'primary line' },
    { provider: 'p2', model: 'm2', description: 'backup line' },
    { provider: 'p3', model: 'm3' },
  ],
};

/** A subagents-seam double recording activations and disposals. */
function stubSeam(overrides = {}) {
  const calls = { activations: [], disposed: 0 };
  return {
    calls,
    resolveMaxDepth: () => (overrides.maxDepth === undefined ? 2 : overrides.maxDepth),
    startActivation: async (spec) => {
      calls.activations.push(spec);
      return {
        childId: 'child-1',
        result: overrides.result
          ? Promise.resolve(overrides.result)
          : Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'final answer' }] }),
        dispose: async () => { calls.disposed += 1; },
      };
    },
  };
}

/** An llm double that optionally fails route preflight. */
function stubLlm(failure) {
  return {
    resolveCallConfig: async () => {
      if (failure !== undefined) throw new Error(failure);
      return {};
    },
  };
}

test('route keys round-trip', () => {
  const key = routeKey({ provider: 'p', model: 'm/x' });
  assert.equal(key, 'p/m/x');
  assert.deepEqual(parseRouteKey(key), { provider: 'p', model: 'm/x' });
  assert.equal(parseRouteKey('no-slash'), null);
  assert.equal(parseRouteKey('/lead'), null);
  assert.equal(parseRouteKey('trail/'), null);
});

test('buildRoleTools skips disabled roles and exposes the candidate catalogue', () => {
  const roles = {
    on: ROLE,
    off: { ...ROLE, enabled: false },
  };
  const tools = buildRoleTools(roles, { subagents: {} });
  assert.equal(tools.length, 1);
  const tool = tools[0];
  assert.equal(tool.name, `${TOOL_PREFIX}on`);
  assert.match(tool.description, /research and summarize/);
  assert.match(tool.description, /p1\/m1 — primary line/);
  assert.match(tool.description, /p2\/m2 — backup line/);
  assert.match(tool.description, /re-call/i);
  assert.deepEqual(tool.parameters.properties.model.enum, ['p1/m1', 'p2/m2', 'p3/m3']);
  assert.deepEqual(tool.parameters.required, ['task']);
  assert.equal(typeof tool.isConcurrencySafe, 'function');
});

test('execute: completed result returns the child text and disposes the run', async () => {
  const seam = stubSeam();
  const tool = buildRoleTool('researcher', ROLE, { subagents: seam, llm: stubLlm() });
  const agent = { id: 'parent-1' };
  const text = await tool.execute({ task: 'do it' }, { agent });
  assert.equal(text, 'final answer');
  assert.equal(seam.calls.activations.length, 1);
  assert.equal(seam.calls.disposed, 1);
  const spec = seam.calls.activations[0];
  assert.equal(spec.provider, 'spawn');
  assert.equal(spec.delivery, 'caller');
  assert.equal(spec.label, 'delegate_researcher: do it');
  assert.equal(spec.request.parent, agent);
  assert.deepEqual(spec.request.agentOptions, { provider: 'p1', model: 'm1' });
  assert.deepEqual(spec.request.prompt, [{ type: 'text', text: 'do it' }]);
  assert.equal(spec.request.maxDepth, 2);
});

test('execute: promptPrefix, preset, maxTokens, cwd, and chosen route travel to the request', async () => {
  const seam = stubSeam();
  const role = {
    ...ROLE,
    promptPrefix: 'You are a research specialist.',
    preset: 'minimal',
    maxTokens: 4096,
    models: [ROLE.models[0]],
  };
  const tool = buildRoleTool('researcher', role, { subagents: seam });
  await tool.execute({ task: 'task', model: 'p1/m1', cwd: '/tmp' }, { agent: {} });
  const request = seam.calls.activations[0].request;
  assert.deepEqual(request.prompt, [{ type: 'text', text: 'You are a research specialist.\n\ntask' }]);
  assert.equal(request.agentPreset, 'minimal');
  assert.deepEqual(request.agentOptions, { provider: 'p1', model: 'm1', maxTokens: 4096 });
  assert.equal(request.cwd, '/tmp');
});

test('execute: model failure report carries diagnostics, remaining candidates, and guidance', async () => {
  const seam = stubSeam({
    result: {
      stopReason: 'error',
      output: [{ type: 'text', text: 'RATE_LIMIT from upstream' }],
    },
  });
  const tool = buildRoleTool('researcher', ROLE, { subagents: seam });
  await assert.rejects(
    () => tool.execute({ task: 't', model: 'p1/m1' }, { agent: {} }),
    (error) => {
      assert.match(error.message, /failed on model p1\/m1/);
      assert.match(error.message, /RATE_LIMIT from upstream/);
      assert.match(error.message, /p2\/m2 — backup line/);
      assert.match(error.message, /p3\/m3(?! —)/);
      assert.match(error.message, /Re-call delegate_researcher/);
      return true;
    },
  );
  assert.equal(seam.calls.disposed, 1);
});

test('execute: non-model stop reasons report without candidate guidance', async () => {
  const seam = stubSeam({ result: { stopReason: 'max-tokens', output: [] } });
  const tool = buildRoleTool('researcher', ROLE, { subagents: seam });
  await assert.rejects(
    () => tool.execute({ task: 't' }, { agent: {} }),
    (error) => {
      assert.match(error.message, /max-tokens/);
      assert.doesNotMatch(error.message, /Remaining model candidates/);
      return true;
    },
  );
});

test('execute: unknown model and missing agent fail fast without starting a child', async () => {
  const seam = stubSeam();
  const tool = buildRoleTool('researcher', ROLE, { subagents: seam });
  await assert.rejects(() => tool.execute({ task: 't', model: 'nope/x' }, { agent: {} }), /unknown `model`/);
  await assert.rejects(() => tool.execute({ task: 't' }, {}), /exec\.agent/);
  await assert.rejects(() => tool.execute({ task: '' }, { agent: {} }), /non-empty/);
  assert.equal(seam.calls.activations.length, 0);
});

test('execute: preflight failure names the route and the candidates', async () => {
  const seam = stubSeam();
  const tool = buildRoleTool('researcher', ROLE, { subagents: seam, llm: stubLlm('NO_ADAPTER') });
  await assert.rejects(
    () => tool.execute({ task: 't', model: 'p2/m2' }, { agent: {} }),
    (error) => {
      assert.match(error.message, /p2\/m2 is not usable: NO_ADAPTER/);
      assert.match(error.message, /p1\/m1, p2\/m2, p3\/m3/);
      return true;
    },
  );
  assert.equal(seam.calls.activations.length, 0);
});

test('execute: cancellation rejects, disposes, and never settles the child result', async () => {
  const seam = stubSeam({ result: new Promise(() => {}) });
  const tool = buildRoleTool('researcher', ROLE, { subagents: seam });
  const controller = new AbortController();
  const pending = tool.execute({ task: 't' }, { agent: {}, signal: controller.signal });
  controller.abort();
  await assert.rejects(() => pending, /cancelled/);
  assert.equal(seam.calls.disposed, 1);
});

test('outcomeReport and helpers cover the pure mapping surface', () => {
  assert.deepEqual(remainingCandidates(ROLE, 'p1/m1'), ['p2/m2', 'p3/m3']);
  assert.equal(joinText([{ type: 'text', text: 'a' }, { type: 'thinking', text: 'x' }, { type: 'text', text: 'b' }]), 'a\n\nb');
  assert.equal(joinText(undefined), '');

  const done = outcomeReport('r', ROLE, 'p1/m1', {
    stopReason: 'completed',
    output: [{ type: 'text', text: 'answer' }],
    structured: { ok: 1 },
  });
  assert.equal(done.ok, true);
  assert.match(done.text, /answer/);
  assert.match(done.text, /Structured result: {"ok":1}/);

  const silent = outcomeReport('r', ROLE, 'p1/m1', { stopReason: 'completed', output: [] });
  assert.equal(silent.ok, true);
  assert.match(silent.text, /no closing message/i);

  const lastCandidate = outcomeReport('r', { ...ROLE, models: [ROLE.models[0]] }, 'p1/m1', { stopReason: 'error', output: [] });
  assert.equal(lastCandidate.ok, false);
  assert.match(lastCandidate.text, /No model candidates remain/);
});

test('pool overlay: pool descriptions win, openPool exposes the whole pool', () => {
  const pool = [
    { provider: 'p1', model: 'm1', description: '用于视觉', enabled: true },
    { provider: 'p2', model: 'm2', description: '复杂推理', reasoningEffort: 'high', enabled: true },
    { provider: 'p3', model: 'm3', enabled: false },
  ];
  const role = { ...ROLE, models: [{ provider: 'p1', model: 'm1' }, { provider: 'px', model: 'mx' }] };
  const resolved = resolveCandidates(role, pool);
  assert.equal(resolved[0].description, '用于视觉');
  assert.equal(resolved[1].description, undefined);
  const open = resolveCandidates({ ...role, openPool: true }, pool);
  assert.deepEqual(open.map(routeKey), ['p1/m1', 'p2/m2']);
  assert.match(poolListing(pool), /p1\/m1: 用于视觉/);
  assert.match(poolListing(pool), /p2\/m2: 复杂推理 \(default effort: high\)/);
  const tool = buildRoleTool('r', { ...role, openPool: true }, { subagents: stubSeam() }, pool);
  assert.deepEqual(tool.parameters.properties.model.enum, ['p1/m1', 'p2/m2']);
  const listTool = buildPoolListTool(pool);
  assert.equal(listTool.name, 'list_delegation_models');
  assert.equal(buildPoolListTool([]), null);
});

test('empty candidates: role inherits parent model, no model param, no crash', async () => {
  const seam = stubSeam();
  const role = { description: 'fallback role', enabled: true, models: [] };
  const tool = buildRoleTool('fallback', role, { subagents: seam });
  // No model property in schema
  assert.equal(tool.parameters.properties.model, undefined);
  // Description mentions inheritance
  assert.match(tool.description, /inherits the parent/);
  // Execute works: no agentOptions passed to startActivation
  const result = await tool.execute({ task: 'do it' }, { agent: {} });
  assert.equal(result, 'final answer');
  const spec = seam.calls.activations[0];
  assert.equal(spec.request.agentOptions, undefined);
  assert.equal(seam.calls.disposed, 1);
});

// ---------------------------------------------------------------------------
// Per-role capability selection
// ---------------------------------------------------------------------------

test('resolveRoleMcp/resolveRoleSkills: absent or null means all, arrays intersect', () => {
  const enabled = ['a', 'b', 'c'];
  assert.deepEqual(resolveRoleMcp({}, enabled), enabled);
  assert.deepEqual(resolveRoleMcp({ mcp: null }, enabled), enabled);
  assert.deepEqual(resolveRoleMcp({ mcp: ['a', 'missing'] }, enabled), ['a']);
  assert.deepEqual(resolveRoleMcp({ mcp: [] }, enabled), []);
  assert.deepEqual(resolveRoleSkills({ skills: ['b', 'zz'] }, ['b', 'z']), ['b']);
});

test('execute: a role-restricted delegation reserves the child capabilities', async () => {
  const reserved = [];
  const seam = stubSeam();
  const role = { ...ROLE, models: [ROLE.models[0]], mcp: ['ops', 'git'], skills: ['alpha'] };
  const services = {
    subagents: seam,
    delegateCapabilities: (parent, selection) => reserved.push([parent, selection]),
    sessionSelection: () => ({ mcp: ['ops', 'web'], skills: null }),
    sessionMcpEnabled: () => ['ops', 'web', 'git'],
    sessionSkillsEnabled: async () => ['alpha', 'beta'],
  };
  const tool = buildRoleTool('researcher', role, services);
  await tool.execute({ task: 'probe internal servers' }, { agent: { session: { id: 'parent-9' } } });
  assert.equal(reserved.length, 1);
  assert.equal(reserved[0][0], 'parent-9');
  // Whitelist ∩ session selection: 'git' survives (role picked it) even
  // though the session deselected it? No — intersection with the session's
  // selection wins: session kept 'ops' only from the role's list.
  assert.deepEqual(reserved[0][1].mcp, ['ops']);
  assert.deepEqual(reserved[0][1].skills, ['alpha']);
});

test('execute: unrestricted roles reserve nothing', async () => {
  const reserved = [];
  const seam = stubSeam();
  const services = {
    subagents: seam,
    delegateCapabilities: (parent, selection) => reserved.push([parent, selection]),
    sessionMcpEnabled: () => ['ops'],
    sessionSkillsEnabled: async () => ['alpha'],
  };
  const tool = buildRoleTool('researcher', { ...ROLE, models: [ROLE.models[0]] }, services);
  await tool.execute({ task: 'plain' }, { agent: { session: { id: 'p' } } });
  assert.equal(reserved.length, 0, 'roles without whitelists keep the session selection');
});

test('execute: capability reservation failures never break the delegation', async () => {
  const seam = stubSeam();
  const role = { ...ROLE, models: [ROLE.models[0]], mcp: ['ops'] };
  const services = {
    subagents: seam,
    delegateCapabilities: () => { throw new Error('store exploded'); },
  };
  const tool = buildRoleTool('researcher', role, services);
  const text = await tool.execute({ task: 'still works' }, { agent: { session: { id: 'p' } } });
  assert.equal(text, 'final answer');
});
