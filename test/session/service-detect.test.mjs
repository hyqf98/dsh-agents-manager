import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeServiceStart, createServiceDetect, serviceReportReminderText } from '../../src/host/session/service-detect.js';

test('looksLikeServiceStart: matches common service launch commands', () => {
  const commands = [
    'java -jar target/app.jar --server.port=8080',
    'java -Xmx2g -jar service.jar',
    'mvn spring-boot:run',
    'gradle bootRun',
    'npm run dev',
    'npm start',
    'pnpm dev',
    'yarn serve',
    'vite dev',
    'npx vite',
    'python3 -m http.server 8000',
    'python -m uvicorn main:app --port 9000',
    'uvicorn app:app',
    'flask run --port 5000',
    'node server.js',
    'redis-server --port 6379',
    'docker compose up -d',
    'docker-compose up',
    'php -S localhost:8000',
  ];
  for (const command of commands) {
    assert.equal(looksLikeServiceStart(command), true, `should match: ${command}`);
  }
});

test('looksLikeServiceStart: read-only commands that quote service tooling do not match', () => {
  const commands = [
    'grep "java -jar" README.md',
    'cat deploy.sh | grep spring-boot:run',
    'git status',
    'curl http://localhost:8080/health',
    'docker ps',
    'docker logs app-container',
    'ps aux | grep node',
    'lsof -i :8080',
    'ls -la',
    'rg "npm run dev" -n docs/',
    'ssh user@server',
    'echo "npm run dev"',
    '',
    '   ',
  ];
  for (const command of commands) {
    assert.equal(looksLikeServiceStart(command), false, `should NOT match: ${command}`);
  }
});

test('pre-execute flags a service-looking bash call and always passes through', async () => {
  const detect = createServiceDetect();
  const agent = { id: 'agent-1' };
  const seen = [];
  const next = async () => { seen.push('next'); return { kind: 'allow' }; };

  const decision = await detect.onPreExecute(
    { name: 'bash', agent, callId: 'call-1', arguments: { command: 'npm run dev', description: 'Start dev server' } },
    next,
  );
  assert.deepEqual(decision, { kind: 'allow' });
  assert.deepEqual(seen, ['next']);
  assert.deepEqual(detect.snapshot(agent), [{ callId: 'call-1', command: 'npm run dev', reminded: false }]);
});

test('pre-execute ignores ordinary commands and non-shell tools', async () => {
  const detect = createServiceDetect();
  const agent = { id: 'agent-1' };
  await detect.onPreExecute({ name: 'bash', agent, callId: 'c1', arguments: { command: 'git status' } }, async () => ({ kind: 'allow' }));
  await detect.onPreExecute({ name: 'read', agent, callId: 'c2', arguments: { file_path: '/x' } }, async () => ({ kind: 'allow' }));
  assert.deepEqual(detect.snapshot(agent), []);
});

test('pre-execute flags any run_in_background shell call', async () => {
  const detect = createServiceDetect();
  const agent = { id: 'a' };
  await detect.onPreExecute(
    { name: 'bash', agent, callId: 'bg-1', arguments: { command: 'tail -f /var/log/system.log', description: 'watch logs', run_in_background: true } },
    async () => ({ kind: 'allow' }),
  );
  assert.deepEqual(detect.snapshot(agent), [{ callId: 'bg-1', command: 'tail -f /var/log/system.log', reminded: false }]);
});

test('post-execute prepends exactly one reminder for a flagged call', async () => {
  const detect = createServiceDetect();
  const agent = { id: 'a' };
  await detect.onPreExecute(
    { name: 'bash', agent, callId: 'call-9', arguments: { command: 'java -jar app.jar' } },
    async () => ({ kind: 'allow' }),
  );

  const downstream = { kind: 'pass', additionalContexts: [{ id: 'other' }] };
  const first = await detect.onPostExecute(
    { name: 'bash', agent, callId: 'call-9' },
    { value: 'done' },
    async () => ({ ...downstream }),
  );
  assert.equal(first.kind, 'pass');
  assert.equal(first.additionalContexts.length, 2);
  assert.equal(first.additionalContexts[0].source.kind, 'agents-manager-process-report');
  assert.equal(first.additionalContexts[0].source.form, 'notice');
  assert.match(first.additionalContexts[0].content[0].text, /report_service_process/);
  // The pre-existing context is preserved untouched.
  assert.deepEqual(first.additionalContexts[1], { id: 'other' });

  // Second settle of the same call does not remind again.
  const second = await detect.onPostExecute(
    { name: 'bash', agent, callId: 'call-9' },
    {},
    async () => ({ kind: 'pass' }),
  );
  assert.equal(second.additionalContexts, undefined);
});

test('post-execute passes unflagged calls through untouched', async () => {
  const detect = createServiceDetect();
  const agent = { id: 'a' };
  const decision = await detect.onPostExecute(
    { name: 'bash', agent, callId: 'plain' },
    {},
    async () => ({ kind: 'pass' }),
  );
  assert.deepEqual(decision, { kind: 'pass' });
});

test('consumeAgent drops flags so a manual report suppresses the reminder', async () => {
  const detect = createServiceDetect();
  const agent = { id: 'a' };
  await detect.onPreExecute(
    { name: 'bash', agent, callId: 'call-r', arguments: { command: 'npm run dev' } },
    async () => ({ kind: 'allow' }),
  );
  detect.consumeAgent(agent);
  const decision = await detect.onPostExecute(
    { name: 'bash', agent, callId: 'call-r' },
    {},
    async () => ({ kind: 'pass' }),
  );
  assert.deepEqual(decision, { kind: 'pass' });
});

test('flags expire instead of pinning memory when a call never settles', async () => {
  let tick = 0;
  const detect = createServiceDetect({ now: () => tick });
  const agent = { id: 'a' };
  // Simulate the pre-execute write through the public listener.
  await detect.onPreExecute(
    { name: 'bash', agent, callId: 'stuck', arguments: { command: 'npm run dev' } },
    async () => ({ kind: 'allow' }),
  );
  tick = 30_001;
  // A later write sweeps the stale flag.
  await detect.onPreExecute(
    { name: 'bash', agent, callId: 'fresh', arguments: { command: 'vite' } },
    async () => ({ kind: 'allow' }),
  );
  const snapshot = detect.snapshot(agent);
  assert.equal(snapshot.length, 1);
  assert.equal(snapshot[0].callId, 'fresh');
});

test('a failing listener body never breaks the waterfall', async () => {
  const log = [];
  const detect = createServiceDetect({ log: (m) => log.push(m) });
  // exec with a getter that throws exercises the try/catch path.
  const badExec = {};
  Object.defineProperty(badExec, 'name', { get() { throw new Error('boom'); } });
  const decision = await detect.onPreExecute(badExec, async () => ({ kind: 'allow' }));
  assert.deepEqual(decision, { kind: 'allow' });
  const post = await detect.onPostExecute(badExec, {}, async () => ({ kind: 'pass' }));
  assert.deepEqual(post, { kind: 'pass' });
});

test('reminder text names the command and the tool', () => {
  const text = serviceReportReminderText('npm run dev');
  assert.match(text, /npm run dev/);
  assert.match(text, /report_service_process/);
});
