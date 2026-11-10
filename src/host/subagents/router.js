/**
 * Subagent delegation router: turns configured roles into model-facing
 * delegation tools over the Host `ctx.subagents` seam.
 *
 * Each enabled role becomes one `delegate_<role>` tool. The tool's `model`
 * parameter is an enum over the role's candidate routes and its description
 * carries each candidate's user-authored description, so the main agent can
 * pick a model per call. One call is one attempt: the child runs through
 * `startActivation` with `delivery: 'caller'`, the tool awaits the result,
 * and a model-attributable failure is reported back with the remaining
 * candidates so the main agent can re-select and call again.
 *
 * @module
 */

/** Prefix every generated tool name carries. */
export const TOOL_PREFIX = 'delegate_';

/**
 * Stable identity for one provider/model pair inside a role's candidate list.
 *
 * @param {{ provider: string, model: string }} candidate
 * @returns {string}
 */
export function routeKey(candidate) {
  return `${candidate.provider}/${candidate.model}`;
}

/**
 * Split a route key back into its provider/model pair.
 *
 * @param {string} key
 * @returns {{ provider: string, model: string } | null}
 */
export function parseRouteKey(key) {
  const separator = key.indexOf('/');
  if (separator <= 0 || separator === key.length - 1) return null;
  return { provider: key.slice(0, separator), model: key.slice(separator + 1) };
}

/**
 * Compose the model-facing tool description for one role: role purpose, the
 * candidate catalogue with descriptions, and the failure-retry contract.
 *
 * @param {string} roleName - sanitized role id.
 * @param {object} role - normalized role record.
 * @returns {string}
 */
export function resolveCandidates(role, pool) {
  if (role.openPool === true) {
    // Only enabled AND exposed entries are offered to the main model; an
    // unexposed pool entry stays usable for explicit role candidates but
    // never appears in the delegate model enum.
    return (pool ?? []).filter((entry) => entry.enabled !== false && entry.expose !== false);
  }
  return (role.models ?? []).map((candidate) => {
    const pooled = (pool ?? []).find((entry) => entry.provider === candidate.provider && entry.model === candidate.model);
    if (pooled === undefined) return candidate;
    return {
      ...candidate,
      description: pooled.description ?? candidate.description,
      reasoningEffort: candidate.reasoningEffort ?? pooled.reasoningEffort,
    };
  });
}

/**
 * Ask a remote OpenAI-compatible decision model to pick one candidate for the
 * task. Returns the matched route key, or null when the answer is unusable.
 *
 * @param {{ baseURL: string, model: string, apiKey?: string }} decision
 * @param {string} task - the delegation task text.
 * @param {Array<object>} candidates - resolved candidate routes.
 * @param {typeof fetch} [fetchImpl] - injectable fetch for tests.
 * @returns {Promise<string|null>}
 */
export async function decideRemote(decision, task, candidates, fetchImpl) {
	const doFetch = fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
	if (doFetch === undefined) return null;
	const system = 'You are a model-routing decision function. Pick exactly one model for the task from the candidate list. Answer with strict JSON only: {"provider":"...","model":"...","reason":"..."} .';
	const user = `Task: ${task}\n\nCandidates:\n${candidates.map((candidate) => `- ${routeKey(candidate)}${candidate.description === undefined ? '' : `: ${candidate.description}`}`).join('\n')}`;
	const response = await doFetch(`${decision.baseURL.replace(/\/$/, '')}/chat/completions`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			...(decision.apiKey === undefined ? {} : { authorization: `Bearer ${decision.apiKey}` }),
		},
		body: JSON.stringify({
			model: decision.model,
			messages: [
				{ role: 'system', content: system },
				{ role: 'user', content: user },
			],
			temperature: 0,
			max_tokens: 200,
		}),
	});
	if (!response.ok) throw new Error(`decision endpoint HTTP ${response.status}`);
	const payload = await response.json();
	const content = payload?.choices?.[0]?.message?.content ?? '';
	const match = /\{[\s\S]*\}/.exec(String(content));
	if (match === null) return null;
	let parsed;
	try {
		parsed = JSON.parse(match[0]);
	} catch {
		return null;
	}
	const key = typeof parsed?.provider === 'string' && typeof parsed?.model === 'string' ? `${parsed.provider}/${parsed.model}` : (typeof parsed?.model === 'string' ? parsed.model : null);
	if (key === null) return null;
	return candidates.some((candidate) => routeKey(candidate) === key) ? key : null;
}

export function poolListing(pool) {
  const lines = [];
  for (const entry of pool ?? []) {
    if (entry.enabled === false || entry.expose === false) continue;
    const parts = [`${entry.provider}/${entry.model}`];
    if (entry.name !== undefined) parts.push(entry.name);
    lines.push(parts.join(' — ') + (entry.description === undefined ? '' : `: ${entry.description}`) + (entry.reasoningEffort === undefined ? '' : ` (default effort: ${entry.reasoningEffort})`));
  }
  return lines.length === 0 ? '(the model pool is empty)' : lines.join('\n');
}

/**
 * Resolve the MCP-server names one role's children may use. `null` or an
 * absent field means "all enabled servers" (the composer default); an array
 * whitelists exactly those names, intersected with the session's own
 * selection.
 *
 * @param {object} role - normalized role record.
 * @param {Array<string>} enabled - session-enabled server names.
 * @returns {Array<string>}
 */
export function resolveRoleMcp(role, enabled) {
  if (role.mcp === null || role.mcp === undefined) return enabled;
  return role.mcp.filter((name) => enabled.includes(name));
}

/**
 * Resolve the skill names one role's children may load, with the same
 * null/array semantics as MCP.
 *
 * @param {object} role - normalized role record.
 * @param {Array<string>} enabled - session-enabled skill names.
 * @returns {Array<string>}
 */
export function resolveRoleSkills(role, enabled) {
  if (role.skills === null || role.skills === undefined) return enabled;
  return role.skills.filter((name) => enabled.includes(name));
}

export function roleToolDescription(roleName, role, pool = []) {
  const resolved = resolveCandidates(role, pool);
  if (resolved.length === 0) {
    return `Delegate a self-contained task to the "${roleName}" subagent (${role.description}). The child inherits the parent agent's model and runs in its own context; this tool returns its final answer.`;
  }
  const lines = [
    `Delegate a self-contained task to the "${roleName}" subagent (${role.description}). The child runs in its own context and this tool returns its final answer.`,
    'Select the child model with `model`; candidates ("<provider>/<model>"):',
  ];
  for (const candidate of resolved) {
    lines.push(`- ${routeKey(candidate)}${candidate.description === undefined ? '' : ` — ${candidate.description}`}`);
  }
  lines.push('If the call fails on the selected model, the error lists the remaining candidates; re-call this tool with another `model` value to retry the task on a different model.');
  return lines.join('\n');
}

/**
 * Build the JSON-Schema parameters object for one role.
 *
 * @param {object} role - normalized role record.
 * @returns {object}
 */
export function roleToolParameters(role, pool = []) {
  const models = resolveCandidates(role, pool);
  if (models.length === 0) {
    return {
      type: 'object',
      additionalProperties: false,
      properties: {
        task: {
          type: 'string',
          description: 'The complete, self-contained task for the subagent. It does not see this conversation.',
        },
        cwd: {
          type: 'string',
          description: 'Initial child working directory. Relative paths use your current directory; omitted inherits it.',
        },
      },
      required: ['task'],
    };
  }
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      task: {
        type: 'string',
        description: 'The complete, self-contained task for the subagent. It does not see this conversation.',
      },
      model: {
        type: 'string',
        enum: models.map(routeKey),
        description: `Model candidate for the child, as "<provider>/<model>". Omit to use ${routeKey(models[0])}.`,
      },
      cwd: {
        type: 'string',
        description: 'Initial child working directory. Relative paths use your current directory; omitted inherits it.',
      },
    },
    required: ['task'],
  };
}

/**
 * Join the text blocks of a child result into report text.
 *
 * @param {Array<object> | undefined} blocks - content blocks from the activation result.
 * @returns {string}
 */
export function joinText(blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .filter((text) => text.trim() !== '')
    .join('\n\n');
}

/**
 * Candidate keys that remain after one attempted route.
 *
 * @param {object} role - normalized role record.
 * @param {string} chosenKey - the attempted route key.
 * @returns {Array<string>}
 */
export function remainingCandidates(role, chosenKey) {
  return role.models.map(routeKey).filter((key) => key !== chosenKey);
}

/**
 * Render the outcome of one delegation attempt for the model.
 *
 * @param {string} roleName - sanitized role id.
 * @param {object} role - normalized role record.
 * @param {string} chosenKey - the attempted route key.
 * @param {{ output?: Array<object>, structured?: unknown, stopReason?: string }} result
 * @returns {{ ok: boolean, text: string }}
 */
export function outcomeReport(roleName, role, chosenKey, result, models) {
  const roleModels = models ?? role.models;
  const text = joinText(result?.output);
  const structured = result?.structured === undefined ? '' : `Structured result: ${JSON.stringify(result.structured)}`;
  const stopReason = typeof result?.stopReason === 'string' ? result.stopReason : 'error';
  if (stopReason === 'completed') {
    const body = [text, structured].filter((part) => part !== '').join('\n\n');
    return { ok: true, text: body === '' ? 'The subagent finished but left no closing message.' : body };
  }
  if (stopReason === 'error') {
    const lines = [
      `subagent failed on model ${chosenKey}.`,
      text === '' ? 'The subagent failed and left no diagnostic output.' : text,
    ];
    const remaining = roleModels.map(routeKey).filter((key) => key !== chosenKey);
    if (remaining.length > 0) {
      lines.push('Remaining model candidates:');
      for (const candidate of roleModels) {
        const key = routeKey(candidate);
        if (key === chosenKey) continue;
        lines.push(`- ${key}${candidate.description === undefined ? '' : ` — ${candidate.description}`}`);
      }
      lines.push(`Re-call ${TOOL_PREFIX}${roleName} with another \`model\` value to retry the task on a different model.`);
    } else {
      lines.push('No model candidates remain for this role.');
    }
    return { ok: false, text: lines.join('\n\n') };
  }
  const detail = text === '' ? 'It left no closing message.' : text;
  return { ok: false, text: `subagent ended before finishing (stop reason: ${stopReason}). ${detail}` };
}

/**
 * Await a promise while an optional abort signal is live; abort rejects with
 * a stable cancellation error and the listener is always removed.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<T>}
 */
function raceAbort(promise, signal) {
  if (signal === undefined) return promise;
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('delegation cancelled before the subagent started'));
      return;
    }
    /** @param {() => void} settle */
    const onAbort = () => {
      cleanup();
      reject(new Error('delegation cancelled'));
    };
    /** @param {T} value */
    const onSettle = (value) => {
      cleanup();
      resolve(value);
    };
    /** @param {Error} error */
    const onReject = (error) => {
      cleanup();
      reject(error);
    };
    function cleanup() {
      signal.removeEventListener('abort', onAbort);
    }
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(onSettle, onReject);
  });
}

/**
 * Build the delegation tool definition for one enabled role.
 *
 * @param {string} roleName - sanitized role id.
 * @param {object} role - normalized role record.
 * @param {object} services - `{ subagents, llm? }` host services.
 * @param {(message: string) => void} [log] - diagnostic sink.
 * @returns {object} definition ready for ctx.tools.register.
 */
export function buildRoleTool(roleName, role, services, pool = [], log = () => {}) {
  const toolName = `${TOOL_PREFIX}${roleName}`;
  const candidates = resolveCandidates(role, pool);
  return {
    name: toolName,
    description: roleToolDescription(roleName, role, pool),
    parameters: roleToolParameters(role, pool),
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec?.agent;
      if (parent === undefined || parent === null) {
        throw new Error(`${toolName} requires a calling agent (exec.agent was undefined)`);
      }
      const seam = services.subagents;
      if (seam === undefined || seam === null) {
        throw new Error(`${toolName}: the subagents service is unavailable in this composition`);
      }
      const task = typeof args?.task === 'string' ? args.task.trim() : '';
      if (task === '') throw new Error('`task` must be a non-empty string');

      // Per-role capability selection: queue the child's effective sets for
      // this plugin's agent/created hook to apply when the child appears.
      // The child never sees more than its parent session selected, and the
      // role's whitelist narrows further. Unrestricted groups are omitted so
      // the child falls back to inheriting the parent session's selection.
      const parentSessionId = parent?.session?.id ?? parent?.id ?? parent?.sessionId;
      const roleRestricts = role.mcp !== undefined || role.skills !== undefined;
      if (roleRestricts && typeof parentSessionId === 'string' && parentSessionId !== '' && typeof services.delegateCapabilities === 'function') {
        try {
          /** @type {{ mcp: string[] | null, skills: string[] | null }} */
          const sessionSelection = typeof services.sessionSelection === 'function'
            ? services.sessionSelection(parentSessionId)
            : { mcp: null, skills: null };
          const enabledMcp = typeof services.sessionMcpEnabled === 'function' ? services.sessionMcpEnabled() : [];
          const enabledSkills = typeof services.sessionSkillsEnabled === 'function' ? await services.sessionSkillsEnabled() : [];
          const sessionMcp = sessionSelection.mcp === null ? enabledMcp : enabledMcp.filter((name) => sessionSelection.mcp.includes(name));
          const sessionSkills = sessionSelection.skills === null ? enabledSkills : enabledSkills.filter((name) => sessionSelection.skills.includes(name));
          services.delegateCapabilities(parentSessionId, {
            mcp: role.mcp === undefined || role.mcp === null ? null : resolveRoleMcp(role, sessionMcp),
            skills: role.skills === undefined || role.skills === null ? null : resolveRoleSkills(role, sessionSkills),
          });
        } catch (error) {
          log(`agents-manager: capability delegation for ${toolName} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      const hasCandidates = candidates.length > 0;
      const explicitModel = hasCandidates && typeof args?.model === 'string' && args.model !== '' ? args.model : '';
      let chosenKey = hasCandidates ? (explicitModel !== '' ? explicitModel : routeKey(candidates[0])) : '';
      let decisionNote = '';
      if (explicitModel === '' && hasCandidates && role.decision?.type === 'remote') {
        try {
          const picked = await decideRemote(role.decision, task, candidates);
          if (picked !== null) {
            chosenKey = picked;
            decisionNote = `Model selected by the remote decision model: ${picked}.`;
          } else {
            decisionNote = `The remote decision model returned no usable choice; fell back to ${chosenKey}.`;
          }
        } catch (decisionError) {
          decisionNote = `The remote decision model failed (${decisionError instanceof Error ? decisionError.message : String(decisionError)}); fell back to ${chosenKey}.`;
        }
      }
      const chosen = hasCandidates ? candidates.find((candidate) => routeKey(candidate) === chosenKey) : undefined;
      if (hasCandidates && chosen === undefined) {
        throw new Error(`unknown \`model\` "${chosenKey}"; candidates: ${candidates.map(routeKey).join(', ')}`);
      }

      // Route preflight: fail fast on an unregistered provider or an unknown
      // model before any child session exists.
      if (hasCandidates && chosen !== undefined && services.llm !== undefined && services.llm !== null) {
        try {
          await services.llm.resolveCallConfig({
            provider: chosen.provider,
            model: chosen.model,
            ...chosen.reasoningEffort === undefined ? {} : { reasoningEffort: chosen.reasoningEffort },
          }, exec?.signal);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(`model route ${chosenKey} is not usable: ${detail}. Candidates: ${candidates.map(routeKey).join(', ')}`);
        }
      }

      /** @type {Record<string, unknown>} */
      const agentOptions = {};
      if (hasCandidates && chosen !== undefined) {
        agentOptions.provider = chosen.provider;
        agentOptions.model = chosen.model;
        if (chosen.reasoningEffort !== undefined) agentOptions.reasoningEffort = chosen.reasoningEffort;
      }
      if (role.maxTokens !== undefined) agentOptions.maxTokens = role.maxTokens;

      /** @type {Record<string, unknown>} */
      const request = {
        prompt: [{
          type: 'text',
          text: role.promptPrefix === undefined ? task : `${role.promptPrefix}\n\n${task}`,
        }],
        parent,
        ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
      };
      if (role.preset !== undefined) request.agentPreset = role.preset;
      if (typeof args?.cwd === 'string' && args.cwd !== '') request.cwd = args.cwd;
      try {
        const maxDepth = seam.resolveMaxDepth();
        if (maxDepth !== undefined && maxDepth !== null) request.maxDepth = maxDepth;
      } catch { /* a seam without depth resolution keeps the host default */ }

      const label = `${toolName}: ${task.slice(0, 60)}`;
      const run = await seam.startActivation({
        provider: 'spawn',
        label,
        delivery: 'caller',
        signal: exec?.signal,
        request,
      });

      let result;
      try {
        result = await raceAbort(run.result, exec?.signal);
      } finally {
        try {
          await run.dispose();
        } catch (error) {
          log(`agents-manager: subagent run dispose failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      const report = hasCandidates
        ? outcomeReport(roleName, role, chosenKey, result, candidates)
        : { ok: true, text: joinText(result?.output) || 'The subagent finished but left no closing message.' };
      if (!report.ok) throw new Error(decisionNote === '' ? report.text : `${decisionNote}\n\n${report.text}`);
      return decisionNote === '' ? report.text : `${decisionNote}\n\n${report.text}`;
    },
  };
}

export function buildPoolListTool(pool = []) {
  const enabled = (pool ?? []).filter((entry) => entry.enabled !== false && entry.expose !== false);
  if (enabled.length === 0) return null;
  return {
    name: 'list_delegation_models',
    description: "List the configured model pool with each model's usage description (for example: vision, heavy reasoning, or a routing/decision model). Read this before choosing the `model` argument of a delegate_* tool; match the task kind to the described purpose.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute() {
      return poolListing(pool);
    },
  };
}

/**
 * Build tool definitions for every enabled role.
 *
 * @param {Record<string, object>} roles - normalized role records keyed by sanitized name.
 * @param {object} services - `{ subagents, llm? }` host services.
 * @param {(message: string) => void} [log] - diagnostic sink.
 * @returns {Array<object>} definitions ready for ctx.tools.register.
 */
export function buildRoleTools(roles, services, pool = [], log = () => {}) {
  /** @type {Array<object>} */
  const tools = [];
  for (const [roleName, role] of Object.entries(roles)) {
    if (role.enabled === false) continue;
    try {
      tools.push(buildRoleTool(roleName, role, services, pool, log));
    } catch (error) {
      log(`agents-manager: role "${roleName}" produced no tool: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return tools;
}
