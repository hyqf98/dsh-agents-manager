/**
 * Model-facing retry tools: let the main agent read live retry state, test
 * candidate rules against real failure text, and persist rules — so a user
 * can paste a vendor error into chat and let the agent build the extractor.
 *
 * Registered per-agent alongside the delegation-role tools, with
 * agent-experience-shaped descriptions that state the contract, the
 * guardrails (clamps, budgets, turn-scoped counting), and what each call
 * returns.
 *
 * @module
 */
import { normalizeRule, testRule } from './rules.js';

/** Read-back cap for recent events served to the model. */
const RECENT_FOR_MODEL = 20;
/** Longest failure text echoed back into a tool result. */
const MAX_ECHO = 1500;

/**
 * Build the three tool definitions around the host collaborators.
 *
 * @param {object} services
 * @param {() => { rules: Array<object>, fallback: object }} services.rules - compiled snapshot.
 * @param {() => { active: Array<object>, recent: Array<object> }} services.monitor - monitor snapshot.
 * @param {() => Promise<Array<object>>} services.listTargets - provider policy targets.
 * @param {(rules: Array<object>, fallback: object) => Promise<{ ok: boolean, error?: string }>} services.saveDocument
 * @param {(rule: object) => Promise<{ ok: boolean, error?: string }>} [services.putRule]
 * @param {() => Array<object>} services.presets - the built-in preset catalog.
 * @param {() => number} [services.now] - injectable clock.
 * @returns {Array<object>} tool definitions for ctx.tools.register.
 */
export function buildRetryTools(services) {
  const now = services.now ?? (() => Date.now());
  const listPresets = services.presets ?? (() => []);

  /** @type {object} */
  const readRetryState = {
    name: 'read_retry_state',
    description: [
      'Read the automatic model-request retry state for this DSH deployment.',
      'Returns three things: (1) each provider route (with the vendor labels its models cover) and its currently effective built-in retry policy (mode, retries, retryable codes, backoff); (2) the user-defined expression rules currently stored (ordered, first match wins); (3) the most recent model-request failures this plugin observed through the retry pipeline, including the provider error text verbatim — rows the rules passed on appear as NOT-RETRIED(no-rules|no-match|budget-exhausted).',
      'Use it to understand why a request is being retried or why it is NOT being retried, and to collect the exact vendor error text before constructing a new rule.',
      'Built-in codes: EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT (retryable by default); QUOTA, ACCOUNT_QUOTA, AUTH, INVALID_CREDENTIAL, INVALID_REQUEST, CONTEXT_WINDOW_EXCEEDED, PI_AI_ERROR (not retried unless a rule or retryableCodes includes them).',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
      required: [],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    isConcurrencySafe: () => true,
    async execute() {
      const targets = await services.listTargets().catch(() => []);
      const { rules } = services.rules();
      const { recent } = services.monitor();
      const presets = listPresets();
      const lines = [];
      lines.push('== Provider routes and effective built-in policies ==');
      if (targets.length === 0) lines.push('(no provider routes registered)');
      for (const target of targets) {
        const policy = target.policy ?? { mode: 'normal (defaults)' };
        const vendors = Array.isArray(target.vendors) && target.vendors.length > 0 ? ` vendors=${target.vendors.join('/')}` : '';
        lines.push(`- ${target.provider}${vendors} [${target.editable ? 'editable' : 'not editable'}]: ${JSON.stringify(policy)}`);
      }
      lines.push('');
      lines.push('== User retry rules (ordered; first match wins) ==');
      if (rules.length === 0) lines.push('(none — consider importing a preset with write_retry_rules)');
      rules.forEach((rule, index) => {
        lines.push(`${index + 1}. ${JSON.stringify(rule)}`);
      });
      lines.push('');
      lines.push('== Built-in presets available for import ==');
      for (const preset of presets) {
        lines.push(`- ${preset.id}: ${preset.title}`);
      }
      lines.push('');
      lines.push(`== Recent retry-pipeline failures (latest ${RECENT_FOR_MODEL}) ==`);
      const recentTail = recent.slice(0, RECENT_FOR_MODEL);
      if (recentTail.length === 0) lines.push('(none observed yet)');
      for (const entry of recentTail.reverse()) {
        const rule = entry.ruleName ? ` rule=${entry.ruleName}` : '';
        const delay = entry.delayMs !== null && entry.delayMs !== undefined ? ` wait=${entry.delayMs}ms` : '';
        const miss = entry.kind === 'failure'
          ? ` NOT-RETRIED(${entry.reason ?? '?'})${typeof entry.count === 'number' && entry.count > 1 ? ` x${entry.count}` : ''}`
          : '';
        const text = String(entry.failure?.message ?? entry.message ?? '').slice(0, MAX_ECHO);
        lines.push(`- [${new Date(entry.time).toISOString()}] provider=${entry.provider} code=${entry.failure?.code ?? ''}${rule}${delay}${miss}`);
        if (text !== '') lines.push(`  error text: ${text}`);
      }
      return lines.join('\n');
    },
  };

  /** @type {object} */
  const testRetryRule = {
    name: 'test_retry_rule',
    description: [
      'Test one candidate retry rule against a sample provider failure BEFORE saving it, and get back whether it matched, the extracted wait duration, and the failure reason when it did not.',
      'The rule object uses the same shape write_retry_rules persists: { name, when: <JavaScript regex source over the failure text>, flags: "i", codes: ["RATE_LIMIT", ...] (optional pre-filter on the normalized failure code), providers: ["magpie", ...] (optional route filter), wait: { kind, ... } }.',
      'wait.kind selects the extractor: "retry-after" (use the provider Retry-After/providerRetryAfterMs, with optional defaultMs fallback), "fixed" (a constant wait.ms interval the user chose, ignoring any provider hint — pair with when "[\\\\s\\\\S]+" and no codes for a catch-all), "duration-text" (English durations like "resets in 4h 5min", "Try again in 23h 59m", "quota will reset after 3h19m30s"), "duration-cn" (请 1 分钟后重试 / 30秒后再试), "reset-at" (absolute time like "您的限额将在 2026-09-22 13:45:14 重置", with optional tz like "+08:00" for texts that name no zone), "unix-seconds" (embedded epoch like usage limit reached|1760000000), "epoch-json" (JSON fields error.resets_at / error.resets_in_seconds), "clock-time" (请于 17:00 后重试).',
      'wait.group (1-based capture group index) narrows where the extractor looks. Every extracted wait is clamped between 1s and the rule clampMs (default 6h, hard max 24h).',
      'Pass sampleMessage with the verbatim vendor error text; optionally also provider, code (normalized failure code), and status (HTTP status number) to exercise the pre-filters.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        rule: { type: 'object', description: 'The candidate rule, same shape write_retry_rules persists. May carry name "test" when unnamed.' },
        sampleMessage: { type: 'string', description: 'Verbatim provider error text to test against.' },
        provider: { type: 'string', description: 'Optional provider route id for the provider pre-filter.' },
        code: { type: 'string', description: 'Optional normalized failure code (e.g. RATE_LIMIT) for the code pre-filter.' },
        status: { type: 'number', description: 'Optional HTTP status number for the status pre-filter.' },
        providerRetryAfterMs: { type: 'number', description: 'Optional provider Retry-After in ms, as the harness failure would carry it.' },
      },
      required: ['rule', 'sampleMessage'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const rawRule = args?.rule;
      if (rawRule === null || typeof rawRule !== 'object') {
        throw new Error('`rule` must be a rule object');
      }
      const sample = typeof args?.sampleMessage === 'string' ? args.sampleMessage : '';
      if (sample === '') throw new Error('`sampleMessage` must be a non-empty string');
      let normalized;
      if (typeof rawRule.name === 'string' && rawRule.name.trim() !== '') {
        normalized = normalizeRule(rawRule);
      } else {
        normalized = normalizeRule({ ...rawRule, name: 'probe' });
      }
      if (!normalized.ok) {
        return `INVALID RULE — ${normalized.error}. Fix the rule and test again.`;
      }
      const outcome = testRule(normalized.rule, {
        message: sample,
        provider: typeof args?.provider === 'string' ? args.provider : undefined,
        code: typeof args?.code === 'string' ? args.code : undefined,
        status: typeof args?.status === 'number' ? args.status : undefined,
        providerRetryAfterMs: typeof args?.providerRetryAfterMs === 'number' ? args.providerRetryAfterMs : undefined,
      }, now(), services.rules().fallback);
      if (!outcome.matched) {
        return `NO MATCH — reason: ${outcome.reason}. The rule stays silent for this failure; the built-in executor keeps its default behavior.`;
      }
      if (outcome.waitMs === null || outcome.waitMs === undefined) {
        return `MATCHED but NO WAIT EXTRACTED (matched text: "${outcome.matchText}"). The extractor found no usable duration/time; adjust the wait.kind or capture group.`;
      }
      const seconds = Math.round(outcome.waitMs / 100) / 10;
      const at = new Date(now() + outcome.waitMs).toISOString();
      return `MATCHED. matched text: "${outcome.matchText}". Wait: ${outcome.waitMs} ms (~${seconds}s), would resume at ${at} (if saved and this failure recurs).`;
    },
  };

  /** @type {object} */
  const writeRetryRules = {
    name: 'write_retry_rules',
    description: [
      'Persist retry rules for automatic model-request recovery. Rules are evaluated in order against provider failure text; the first match schedules a durable wait and retries the failed request in the same turn.',
      'Modes: { rules: [...], replace: false } appends/merges the supplied rules by name (existing rules with the same name are replaced); { rules: [...], replace: true } replaces the whole rule list. Optionally pass fallback: { maxDelayMs } to set the global wait ceiling (default 6h, hard max 24h).',
      'Before persisting an unverified rule, call test_retry_rule with the real vendor error text. Read exact vendor error texts from read_retry_state (recent failures section).',
      'Each rule is validated: when must compile as a JavaScript regex; codes must be non-empty non-duplicate strings; wait.kind must be one of retry-after, fixed, duration-text, duration-cn, reset-at, unix-seconds, epoch-json, clock-time; maxRetries (0-100, 0 = unlimited per turn) is the per-turn budget for that rule; clampMs (1000-86400000) bounds that rule\'s wait.',
      'Guardrails you must respect when authoring rules: keep clamps as low as the vendor reset actually requires; prefer codes/providers pre-filters to avoid over-matching; a wait longer than a few hours only makes sense when the user explicitly wants the session to pause until the vendor limit resets.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        rules: {
          type: 'array',
          description: 'Rule objects to persist.',
          items: { type: 'object' },
        },
        replace: { type: 'boolean', description: 'true to replace the whole rule list; false/omitted to merge by name.' },
        fallback: { type: 'object', description: 'Optional { maxDelayMs } global wait ceiling.' },
      },
      required: ['rules'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      if (!Array.isArray(args?.rules)) throw new Error('`rules` must be an array');
      const incoming = [];
      for (const raw of args.rules) {
        const normalized = normalizeRule(raw);
        if (!normalized.ok) {
          throw new Error(`rule ${JSON.stringify(raw?.name ?? '?')} is invalid: ${normalized.error}`);
        }
        incoming.push(normalized.rule);
      }
      const current = services.rules();
      let nextRules = incoming;
      let fallback = current.fallback;
      if (args?.replace !== true) {
        const byName = new Map(current.rules.map((rule) => [rule.name, rule]));
        for (const rule of incoming) byName.set(rule.name, rule);
        nextRules = [...byName.values()];
      }
      if (args?.fallback !== null && typeof args?.fallback === 'object' && typeof args.fallback.maxDelayMs === 'number') {
        if (!Number.isInteger(args.fallback.maxDelayMs) || args.fallback.maxDelayMs < 1000 || args.fallback.maxDelayMs > 24 * 60 * 60 * 1000) {
          throw new Error('fallback.maxDelayMs must be an integer between 1000 and 86400000');
        }
        fallback = { maxDelayMs: args.fallback.maxDelayMs };
      }
      const saved = await services.saveDocument(nextRules, fallback);
      if (!saved.ok) {
        throw new Error(`persisting rules failed: ${saved.error}`);
      }
      return `Saved ${nextRules.length} rule(s)${args?.replace === true ? ' (replaced list)' : ' (merged by name)'}. Effective immediately for the next failure.`;
    },
  };

  return [readRetryState, testRetryRule, writeRetryRules];
}
