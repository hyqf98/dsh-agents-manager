import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSupervisor } from '../../src/host/mcp/supervisor.js';
import { publicToolName } from '../../src/host/mcp/config.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, '..', 'fixtures', 'echo-server.mjs');

test('supervisor connects to the stdio fixture, discovers tools, and bridges a call', async () => {
  const supervisor = createSupervisor();
  try {
    await supervisor.sync({
      echo: { transport: 'stdio', command: process.execPath, args: [fixture], enabled: true },
    });
    const status = supervisor.status();
    assert.equal(status.echo.state, 'connected', `state: ${JSON.stringify(status.echo)}`);
    assert.equal(status.echo.toolCount, 2);
    assert.deepEqual(
      status.echo.tools.map((tool) => tool.name).sort(),
      ['boom', 'echo'],
    );
    assert.equal(status.echo.tools[0].publicName, publicToolName('echo', status.echo.tools[0].name));

    const definitions = supervisor.definitionsFor('echo');
    assert.equal(definitions.length, 2);
    const echoDef = definitions.find((definition) => definition.name === 'mcp__echo__echo');
    assert.ok(echoDef, 'public name follows the pinned contract');
    assert.equal(echoDef.description, 'Echo back the message argument as text.');
    assert.deepEqual(echoDef.parameters.required, ['message']);

    const controller = new AbortController();
    const result = await echoDef.execute({ message: 'hello agents-manager' }, { signal: controller.signal });
    assert.deepEqual(result.content, [{ type: 'text', text: 'hello agents-manager' }]);
    assert.equal(echoDef.output.render({}, result)[0].text, 'hello agents-manager');

    const boomDef = definitions.find((definition) => definition.name === 'mcp__echo__boom');
    await assert.rejects(() => boomDef.execute({}, { signal: controller.signal }), /boom fixture failure/);

    // A failing server lands in the failed state beside a healthy one.
    await supervisor.sync({
      echo: { transport: 'stdio', command: process.execPath, args: [fixture], enabled: true },
      broken: { transport: 'stdio', command: '/nonexistent-echo-command', enabled: true },
    });
    const after = supervisor.status();
    assert.equal(after.echo.state, 'connected');
    assert.equal(after.broken.state, 'failed');
    assert.ok(typeof after.broken.error === 'string' && after.broken.error !== '');
  } finally {
    await supervisor.dispose();
  }
});

test('supervisor testOne uses an independent connection and never touches the pool', async () => {
  const supervisor = createSupervisor();
  try {
    const good = await supervisor.testOne('echo', { transport: 'stdio', command: process.execPath, args: [fixture], enabled: true });
    assert.equal(good.ok, true);
    assert.equal(good.tools.length, 2);
    const bad = await supervisor.testOne('broken', { transport: 'streamable-http', url: 'http://127.0.0.1:1/mcp', enabled: true });
    assert.equal(bad.ok, false);
    assert.ok(bad.error.length > 0);
    // No sync() happened, so the pool stays empty.
    assert.deepEqual(supervisor.status(), {});
  } finally {
    await supervisor.dispose();
  }
});

test('recordTest surfaces the last outcome in status() and sync clears it for disabled servers', async () => {
  const supervisor = createSupervisor();
  try {
    await supervisor.sync({
      echo: { transport: 'stdio', command: process.execPath, args: [fixture], enabled: true },
    });
    // Untested entry carries no lastTest.
    assert.equal(supervisor.status().echo.lastTest, null);

    // A recorded success shows up verbatim for every /state reader.
    supervisor.recordTest('echo', { ok: true, tools: [{ name: 'echo' }, { name: 'boom' }] });
    const okEntry = supervisor.status().echo;
    assert.equal(okEntry.lastTest.ok, true);
    assert.equal(okEntry.lastTest.toolCount, 2);
    assert.equal(okEntry.lastTest.error, null);
    assert.ok(Number.isFinite(okEntry.lastTest.at));
    // Pure bookkeeping: the live pool state did not change.
    assert.equal(okEntry.state, 'connected');

    // A recorded failure replaces the success.
    supervisor.recordTest('echo', { ok: false, error: 'connect ECONNREFUSED' });
    const failEntry = supervisor.status().echo;
    assert.equal(failEntry.lastTest.ok, false);
    assert.equal(failEntry.lastTest.toolCount, 0);
    assert.equal(failEntry.lastTest.error, 'connect ECONNREFUSED');

    // Disabling (or removing) the server drops the record with the entry.
    await supervisor.sync({
      echo: { transport: 'stdio', command: process.execPath, args: [fixture], enabled: false },
    });
    assert.equal(supervisor.status().echo, undefined);
    // Re-enabling starts clean: no stale test outcome survives.
    await supervisor.sync({
      echo: { transport: 'stdio', command: process.execPath, args: [fixture], enabled: true },
    });
    assert.equal(supervisor.status().echo.lastTest, null);
  } finally {
    await supervisor.dispose();
  }
});
