/**
 * Service-processes feature row (`agents-manager-processes`).
 *
 * Owns the per-session process registry behind the `report_service_process`
 * callback tool, the three-layer "report always happens" machinery
 * (pre/post-execute detect + the jobs auto-registration bridge), the
 * child→root session resolver, and the「进程」conversation-view tab's HTTP
 * services. When this row is disabled the tool never registers and the
 * client hides the tab (via /state.features).
 *
 * @module
 */
import { createProcessStore, createRootResolver } from '../session/processes.js';
import { buildProcessReportTool } from '../session/process-tools.js';
import { createServiceDetect, looksLikeServiceStart } from '../session/service-detect.js';

/**
 * Compose the processes feature against the core service.
 *
 * @param {object} ctx - plugin host context for this row.
 * @returns {void}
 */
export function apply(ctx) {
  ctx.inject(['agents-manager:core'], (scope) => {
    const core = typeof scope.get === 'function' ? scope.get('agents-manager:core') : scope['agents-manager:core'];
    if (core === undefined || core === null) return;

    const warn = (message) => { try { ctx.logger?.warn?.(message); } catch { /* logging is optional */ } };

    /**
     * Supplementary child→parent map fed by global `subagent/start` events:
     * a second parent source for the root resolver next to session headers.
     *
     * @type {Map<string, string>}
     */
    const subagentParents = new Map();
    const resolveRoot = createRootResolver({
      resolveSessions: () => core.serviceOf('sessions'),
      parentHintOf: (id) => subagentParents.get(id),
      log: warn,
    });

    const processStore = createProcessStore({
      log: warn,
      // Lazy on purpose: the jobs service composes later than this store and
      // is absent entirely in headless profiles.
      killJob: (jobId, ownerSessionId, reason) => {
        const jobs = core.serviceOf('jobs');
        if (jobs === undefined || typeof jobs.kill !== 'function') {
          return Promise.reject(new Error('jobs service unavailable'));
        }
        return Promise.resolve(jobs.kill(jobId, ownerSessionId, reason));
      },
      // Liveness for auto-registered services: fenced by the owning root
      // session; a job neither running nor stopping is gone.
      jobAlive: (jobId, ownerSessionId) => {
        const jobs = core.serviceOf('jobs');
        if (jobs === undefined || typeof jobs.list !== 'function') return true; // unknown = keep showing
        try {
          const owned = jobs.list(ownerSessionId);
          const job = (Array.isArray(owned) ? owned : []).find((entry) => String(entry?.id ?? '') === String(jobId));
          return job !== undefined && (job.status === 'running' || job.status === 'stopping');
        } catch {
          return true; // the registry's word is unavailable: keep the last status
        }
      },
    });

    /**
     * Layers 1-2 of the "report always happens" machinery: a per-agent
     * pending table driven by tools/pre-execute over shell calls and settled
     * by a tools/post-execute notice. One shared instance; listeners are
     * registered per agent inside the core's binding sync through the
     * contribution hooks below.
     */
    const serviceDetect = createServiceDetect({ log: warn });

    // Subagent lineage for the root resolver: remember each child→parent
    // pair the runtime announces. Field names probed defensively.
    const offSubagentStart = ctx.on('subagent/start', (info) => {
      try {
        const child = info?.childId ?? info?.childSessionId ?? info?.sessionId;
        const parent = info?.parentSessionId ?? info?.parentId ?? info?.rootSessionId;
        if (typeof child === 'string' && child !== '' && typeof parent === 'string' && parent !== '' && child !== parent) {
          subagentParents.set(child, parent);
        }
      } catch { /* lineage hints are advisory */ }
    });

    /**
     * Layer 3 — the jobs bridge: subscribe to the kernel background-job
     * registry and auto-register service-looking bash jobs, so the user sees
     * them even when the model never reports. Registered only while the
     * `jobs` service is composed (headless keeps layers 1-2 only).
     *
     * @param {object} jobsScope - context carrying the jobs service.
     */
    function mountJobsBridge(jobsScope) {
      const jobs = typeof jobsScope.get === 'function' ? jobsScope.get('jobs') : jobsScope.jobs;
      if (jobs === undefined || typeof jobs.events?.subscribe !== 'function') return;
      /** jobId → root session id, so `settled` finds the record again. */
      const autoByJob = new Map();
      const unsubscribe = jobs.events.subscribe({ owners: 'all' }, (event) => {
        try {
          if (event?.type === 'registered') {
            const job = event.job;
            if (job?.kind !== 'bash' || !looksLikeServiceStart(String(job.label ?? ''))) return;
            const ownerAgent = typeof job.owner === 'string' ? core.serviceOf('agents')?.get(job.owner) : undefined;
            const rootId = ownerAgent === undefined ? '' : resolveRoot(ownerAgent).rootId;
            if (rootId === '') return;
            const name = String(job.label ?? '').trim().slice(0, 80) || 'background service';
            autoByJob.set(String(job.id), { rootId, name });
            void processStore.record(rootId, '', { name, command: String(job.label ?? '').slice(0, 500), source: 'auto', jobId: String(job.id) })
              .catch(() => { /* advisory registration */ });
          } else if (event?.type === 'settled') {
            const info = autoByJob.get(String(event.job?.id ?? ''));
            if (info === undefined) return;
            autoByJob.delete(String(event.job?.id ?? ''));
            const cause = String(event.cause ?? '');
            const status = cause === 'kill' ? 'stopped' : 'exited';
            void processStore.record(info.rootId, '', { name: info.name, status, source: 'auto', message: `background job settled (${cause === 'kill' ? 'stopped' : 'finished'})` })
              .catch(() => { /* advisory registration */ });
          }
        } catch { /* the bridge is advisory */ }
      });
      try {
        ctx.effect(() => () => {
          autoByJob.clear();
          try { unsubscribe(); } catch { /* already gone */ }
        }, 'agents-manager: jobs bridge');
      } catch { /* manual unsubscribe on teardown */ }
    }

    if (typeof ctx.inject === 'function') {
      ctx.inject(['jobs'], mountJobsBridge);
    } else {
      mountJobsBridge(ctx);
    }

    ctx.effect(() => () => {
      offSubagentStart();
      processStore.dispose();
    }, 'agents-manager: processes row teardown');

    const disposeProcesses = core.features.register('processes', {
      /**
       * Tool contributions per agent binding: the report tool plus the
       * service-detect listeners (registered on the agent's own ctx).
       *
       * @returns {{ tools: Array<object>, detect: object }}
       */
      contributions() {
        return {
          tools: [buildProcessReportTool({
            store: processStore,
            resolveRoot,
            onReported: (reportingAgent) => serviceDetect.consumeAgent(reportingAgent),
          })],
          detect: serviceDetect,
        };
      },
      /** HTTP services for the「进程」tab's /session/processes routes. */
      apiServices() {
        return { processStore };
      },
    });
    // Agents bound before this row resolved (boot order is not guaranteed)
    // must re-sync to pick the report tool + detect listeners up.
    core.syncAllAgents();
    try {
      ctx.effect(() => () => disposeProcesses(), 'agents-manager: processes row feature disposer');
    } catch { /* manual detach on row teardown */ }
  });
}

export const inject = ['agents-manager:core'];
