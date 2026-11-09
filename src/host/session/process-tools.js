/**
 * Model-facing session process tool: `report_service_process`, the callback
 * the AI invokes right after it starts (or stops, or observes the death of)
 * a local service process, so the user sees the service's port(s), recent
 * output, and a stop button in the session's floating process panel.
 *
 * Registered per-agent alongside the retry tools; subagent agents get it
 * too, and their reports roll up to the root session's panel through the
 * root resolver.
 *
 * @module
 */
import { sessionIdOfAgent } from './processes.js';

/** Most registry entries echoed back into one tool result. */
const SUMMARY_MAX = 10;

/**
 * Build the tool definition around its host collaborators.
 *
 * @param {object} services
 * @param {object} services.store - process store handle.
 * @param {(agent: object) => { rootId: string, callerId: string, subagent: boolean }} services.resolveRoot - root-session resolver.
 * @param {(agent: object) => void} [services.onReported] - consumes the
 *        reporting agent's pending service-detect flags (idempotence for
 *        the layer-2 reminder).
 * @returns {object} tool definition ready for ctx.tools.register.
 */
export function buildProcessReportTool(services) {
  return {
    name: 'report_service_process',
    description: [
      'Report or update a local service process this conversation started (dev server, HTTP server, build watcher, database, …) so the user sees it in the session process panel with its port(s), recent output, and a stop button.',
      'MANDATORY after starting a local service: the user only sees services that were reported. A foreground shell call returns before the service finishes starting — report anyway with the port(s) you expect it to listen on, then re-report to correct them.',
      'Call it once right after the process is up: `name` plus port(s) are the minimum; include `pid` whenever you know it (the panel can only offer a working stop button with a pid), plus `url`, `command`, and the last lines of the startup output.',
      'Call it again with the same `name` to update that record: refresh the output excerpt, correct ports, or change `status` — "stopped" after you stop the process yourself, "failed" if it crashed. Fields you omit keep their last reported value. Each call returns the session\'s current process list.',
      'Subagent-started services roll up to the main session panel automatically; subagents should call this tool the same way.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: 'Short service name (1-80 chars), e.g. "vite dev server". The per-session key: reusing a name updates that record instead of adding one.' },
        port: { type: 'number', description: 'Primary listening port, 1-65535.' },
        ports: { type: 'array', items: { type: 'number' }, description: 'All listening ports when several (max 8 after dedupe); `port` is merged in.' },
        pid: { type: 'number', description: 'Process id of the started service. The panel stop button needs it.' },
        jobId: { type: 'string', description: 'Background job id (e.g. "bash-…" from a run_in_background bash call). An alternative stop handle when no pid is known: with it the panel stops the service through the jobs registry.' },
        url: { type: 'string', description: 'Full URL to open the service, e.g. http://127.0.0.1:5173.' },
        command: { type: 'string', description: 'Command line that started the process.' },
        output: { type: 'string', description: 'Recent process output (the startup lines are the most useful); replaces the previous excerpt, kept to 4000 chars.' },
        status: { type: 'string', enum: ['running', 'stopped', 'exited', 'failed'], description: 'Lifecycle status; omit when reporting a newly running service.' },
        message: { type: 'string', description: 'One-line note, e.g. why the process stopped.' },
      },
      required: ['name'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const agent = exec?.agent;
      if (agent === undefined || agent === null) {
        throw new Error('report_service_process requires a calling agent (exec.agent was undefined)');
      }
      const { rootId, callerId, subagent } = services.resolveRoot(agent);
      if (rootId === '') {
        throw new Error('report_service_process could not determine the calling session');
      }
      const recorded = await services.store.record(rootId, callerId, args ?? {});
      if (!recorded.ok) {
        throw new Error(`report_service_process rejected the report: ${recorded.error}`);
      }
      // The model did its duty: drop its pending service-detect flags so the
      // layer-2 reminder never fires for an already-reported call.
      try {
        services.onReported?.(agent);
      } catch { /* advisory */ }
      const item = recorded.record;
      const head = [
        `${recorded.created ? 'Recorded' : 'Updated'} service "${item.name}"${item.ports.length > 0 ? ` (port ${item.ports.join(', ')})` : ''}${item.pid === undefined ? '' : ` pid ${item.pid}`}`
          + ` as ${item.status}${subagent ? ' — rolled up to the main session panel' : ' — visible in the session process panel'}.`,
      ];
      const all = services.store.list(rootId);
      if (all.length > 0) {
        head.push(`Session processes (${all.length}):`);
        for (const one of all.slice(0, SUMMARY_MAX)) {
          head.push(`- ${one.name} ${one.status}${one.ports.length > 0 ? ` :${one.ports.join(',:')}` : ''}${one.pid === undefined ? '' : ` pid ${one.pid}`}${one.source === 'subagent' ? ' (subagent)' : one.source === 'auto' ? ' (auto-registered; report to enrich)' : ''}`);
        }
        if (all.length > SUMMARY_MAX) head.push(`… and ${all.length - SUMMARY_MAX} more`);
      }
      return head.join('\n');
    },
  };
}
