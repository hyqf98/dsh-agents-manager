/**
 * Built-in vendor retry presets: curated match rules for the providers and
 * gateways this deployment actually routes through.
 *
 * Every preset is plain data in the same shape a user rule takes (validated
 * by rules.js). The `when` grammars and `wait` extractors come from verified
 * vendor payloads — real error bodies gathered from vendor SDKs, production
 * gateways (yetone/magpie routing.go), and the OpenAI Codex backend source;
 * each preset's `sample` is a true positive used by the test suite.
 *
 * Importing a preset copies it into the user's rule list (editable, not a
 * live link), because vendor wording drifts and users must be able to tune.
 *
 * @module
 */

/**
 * The preset catalog. Order matters only for display; rule evaluation order
 * is the user's rule-list order after import.
 *
 * @type {Array<object>}
 */
export const RETRY_PRESETS = [
  {
    id: 'glm-zhipu-cn',
    title: '智谱 GLM · 5 小时 / 周限额（中文报文）',
    description: 'bigmodel.cn GLM Coding Plan 的 1308/1310/1316-1321 限额报错，重置时刻写在中文正文里（北京时间，无时区标注）。',
    sample: '{"error":{"code":"1308","message":"已达到 5 小时的使用上限。您的限额将在 2026-09-22 13:45:14 重置。"}}',
    rule: {
      name: 'glm-zhipu-cn',
      when: '已达到\\s*(\\d+|五|一)?\\s*(?:小时|天|周|日)?的?使用上限|使用上限.{0,40}重置',
      flags: 'i',
      codes: ['RATE_LIMIT', 'QUOTA', 'PI_AI_ERROR', 'SERVER'],
      wait: { kind: 'reset-at', tz: '+08:00' },
      maxRetries: 4,
    },
  },
  {
    id: 'glm-zai-en',
    title: 'Z.ai GLM · 5-hour / weekly limit (English)',
    description: 'Z.ai\'s English twin of the same limits: "Usage limit reached for 5 hour. Your limit will reset at 2026-09-22 01:18:11".',
    sample: 'Usage limit reached for 5 hour. Your limit will reset at 2026-09-22 01:18:11',
    rule: {
      name: 'glm-zai-en',
      when: 'usage\\s+limit\\s+reached|weekly.{0,20}limit\\s+exhausted|your\\s+limit\\s+will\\s+reset\\s+at|您的限额将在',
      flags: 'i',
      codes: ['RATE_LIMIT', 'QUOTA', 'PI_AI_ERROR', 'SERVER'],
      wait: { kind: 'reset-at', tz: '+08:00' },
      maxRetries: 4,
    },
  },
  {
    id: 'claude-anthropic',
    title: 'Claude / Anthropic · rate limit 与过载',
    description: 'Anthropic Messages API 的 rate_limit_error / overloaded_error；等待时长来自 Retry-After（内核适配器已解析为 providerRetryAfterMs）。',
    sample: '{"type":"error","error":{"type":"rate_limit_error","message":"Number of requests has exceeded your per-minute rate limit."}}',
    rule: {
      name: 'claude-anthropic',
      when: 'rate_limit_error|overloaded_error|too\\s+many\\s+requests',
      flags: 'i',
      codes: ['RATE_LIMIT', 'SERVER', 'PI_AI_ERROR'],
      wait: { kind: 'retry-after', defaultMs: 15000 },
      maxRetries: 6,
    },
  },
  {
    id: 'claude-code-usage',
    title: 'Claude Code · 用量限额（unix 时间戳）',
    description: 'Claude Code 的 5 小时/7 天用量限制，正文携带 `usage limit reached|<unix秒>`；按到点等待。',
    sample: 'Your Claude usage limit has been reached. usage limit reached|1767266400',
    rule: {
      name: 'claude-code-usage',
      when: 'usage\\s+limit\\s+reached\\s*\\|?\\s*\\d{10}|resetsAt\\s*[:=]',
      flags: 'i',
      codes: ['RATE_LIMIT', 'QUOTA', 'PI_AI_ERROR'],
      wait: { kind: 'unix-seconds' },
      maxRetries: 3,
    },
  },
  {
    id: 'codex-usage-limit',
    title: 'OpenAI / Codex · usage_limit_reached（JSON 字段）',
    description: 'Codex 后端 429 报文 {"error":{"type":"usage_limit_reached","resets_at":<unix秒>,"resets_in_seconds":<n>}}；直接读结构化字段。',
    sample: '{"error":{"type":"usage_limit_reached","resets_at":1767266400,"resets_in_seconds":30995,"limit_window_minutes":300}}',
    rule: {
      name: 'codex-usage-limit',
      when: 'usage_limit_reached|resets_in_seconds|resets_at',
      flags: 'i',
      codes: ['RATE_LIMIT', 'QUOTA', 'PI_AI_ERROR'],
      wait: { kind: 'epoch-json' },
      maxRetries: 3,
    },
  },
  {
    id: 'openai-rate',
    title: 'OpenAI · 限流与过载',
    description: 'openai 兼容网关的 429 slow_down / rate_limit_error 与 503 server_is_overloaded；优先 Retry-After，缺省短退避。',
    sample: 'Rate limit reached for gpt-6.1-sol on tokens per min (TPM). Please try again in 6ms.',
    rule: {
      name: 'openai-rate',
      when: 'rate\\s+limit\\s+(?:reached|exceeded)|slow_down|server_is_overloaded|please\\s+try\\s+again\\s+in',
      flags: 'i',
      codes: ['RATE_LIMIT', 'SERVER', 'PI_AI_ERROR'],
      wait: { kind: 'retry-after', defaultMs: 10000 },
      maxRetries: 6,
    },
  },
  {
    id: 'kimi-moonshot',
    title: 'Kimi / Moonshot · 并发与额度',
    description: 'Moonshot 平台的 429（并发 1211 / 频率 1212 / 额度 1224）与英文 rate limit 文案。',
    sample: 'Too Many Requests, please retry in 30 seconds. (1211)',
    rule: {
      name: 'kimi-moonshot',
      when: 'too\\s+many\\s+requests|请求过于频繁|请稍后再试|并发数过高|频率过高',
      flags: 'i',
      codes: ['RATE_LIMIT', 'QUOTA', 'PI_AI_ERROR'],
      wait: { kind: 'retry-after', defaultMs: 20000 },
      maxRetries: 6,
    },
  },
  {
    id: 'deepseek-429-503',
    title: 'DeepSeek · 限流与过载',
    description: 'DeepSeek 官方 429 Rate Limit Reached 与 503 Server Overloaded（"Please retry your request after a brief wait"）；无显式时间，短退避。',
    sample: 'Server Overloaded. Please retry your request after a brief wait. (503)',
    rule: {
      name: 'deepseek-429-503',
      when: 'rate\\s+limit\\s+reached|server\\s+overloaded|retry\\s+your\\s+request\\s+after\\s+a\\s+brief\\s+wait',
      flags: 'i',
      codes: ['RATE_LIMIT', 'SERVER'],
      wait: { kind: 'retry-after', defaultMs: 8000 },
      maxRetries: 6,
    },
  },
  {
    id: 'gemini-quota',
    title: 'Gemini / Vertex · RESOURCE_EXHAUSTED',
    description: 'Google 的 RESOURCE_EXHAUSTED 与 quotaResetDelay（"quotaResetDelay":"33s"、"Please retry in 33s"）。',
    sample: 'You exceeded your current quota. quotaResetDelay: 33s. Please retry in 33s.',
    rule: {
      name: 'gemini-quota',
      when: 'RESOURCE_EXHAUSTED|quotaResetDelay|exceeded\\s+your\\s+current\\s+quota',
      flags: 'i',
      codes: ['RATE_LIMIT', 'QUOTA', 'PI_AI_ERROR', 'SERVER'],
      wait: { kind: 'duration-text' },
      maxRetries: 6,
    },
  },
  {
    id: 'cline-free-daily',
    title: 'Cline 免费模型 · 每日限额',
    description: 'Cline 免费模型 429 "Daily free limit reached on model X. Try again in 23h 59m"。',
    sample: 'Daily free limit reached on model deepseek/deepseek-v4-flash. Try again in 23h 59m',
    rule: {
      name: 'cline-free-daily',
      when: 'daily\\s+free\\s+limit\\s+reached|free\\s+limit\\s+reached\\s+on\\s+model',
      flags: 'i',
      codes: ['RATE_LIMIT', 'QUOTA', 'PI_AI_ERROR'],
      wait: { kind: 'duration-text' },
      maxRetries: 3,
    },
  },
  {
    id: 'factory-weekly',
    title: 'Factory · 周限额（resets in）',
    description: 'Factory 402 "You\'ve reached your weekly standard usage limit (resets in 0h 19min)"。',
    sample: "You've reached your weekly standard usage limit (resets in 0h 19min)",
    rule: {
      name: 'factory-weekly',
      when: 'weekly\\s+standard\\s+usage\\s+limit|resets\\s+in\\s+\\d',
      flags: 'i',
      codes: ['RATE_LIMIT', 'QUOTA', 'PI_AI_ERROR'],
      wait: { kind: 'duration-text' },
      maxRetries: 3,
    },
  },
  {
    id: 'antigravity-quota',
    title: 'Antigravity · Go duration 限额',
    description: 'Google Code Assist 的 "Your quota will reset after 3h19m30s"。',
    sample: 'You have exhausted your capacity on this model. Your quota will reset after 3h19m30s.',
    rule: {
      name: 'antigravity-quota',
      when: 'quota\\s+will\\s+reset\\s+after|exhausted\\s+your\\s+capacity',
      flags: 'i',
      codes: ['RATE_LIMIT', 'QUOTA', 'PI_AI_ERROR'],
      wait: { kind: 'duration-text' },
      maxRetries: 3,
    },
  },
  {
    id: 'gateway-overload',
    title: '网关过载 · CPU/负载类瞬时错误',
    description: '中转站/网关的瞬时过载（"system cpu overloaded (current: 96.8%, threshold: 90%)"、"overloaded_error"、"service temporarily unavailable"、"服务器繁忙"）。宿主把这类无法归一的报错标为 PI_AI_ERROR（默认不重试），本规则按短退避重试。',
    sample: 'server_error: 海军中转站: system cpu overloaded (current: 96.8%, threshold: 90%)',
    rule: {
      name: 'gateway-overload',
      when: 'cpu\\s+overloaded|overloaded_error|service\\s+temporarily\\s+unavailable|当前负载|负载过高|服务器繁忙|try\\s+again\\s+later',
      flags: 'i',
      codes: ['PI_AI_ERROR', 'SERVER', 'RATE_LIMIT'],
      wait: { kind: 'retry-after', defaultMs: 5000 },
      maxRetries: 6,
    },
  },
  {
    id: 'relay-cn-misc',
    title: '中转站 · 中文杂项（将于/请于/秒分钟后）',
    description: '中文中转站的通用兜底：「将于 2026-10-25 23:59:59 +0800 重置」「请于 17:00 后重试」「请 1 分钟后重试」「30秒后再试」。',
    sample: '您的额度已用尽，将于 2026-10-25 23:59:59 +0800 重置，请于 17:00 后重试。',
    rule: {
      name: 'relay-cn-misc',
      when: '将于.{0,40}重置|请于\\s*\\d{1,2}:\\d{2}\\s*后|\\d+(?:\\.\\d+)?\\s*(?:秒钟?|分钟?|小时|时|天|日)\\s*(?:之?后|后)(?:再(?:试|重试))?|额度已用尽|用量超限',
      flags: 'i',
      codes: ['RATE_LIMIT', 'QUOTA', 'PI_AI_ERROR', 'SERVER'],
      wait: { kind: 'reset-at', tz: '+08:00' },
      maxRetries: 4,
    },
  },
  {
    id: 'catch-all',
    title: '兜底重试 · 所有异常（固定间隔，可无限）',
    description: '匹配一切非空失败报文（不限定 codes/providers），任何未被前面精确规则接住的异常都按固定间隔重试。默认无限重试（maxRetries 0）+ 60 秒间隔，导入后可在编辑里改次数与间隔（0 = 无限）。因 merge 导入追加在列表末尾，first-match-wins 下它天然只兜底。注意 AUTH 等鉴权失败重试无效，如需排除可在 codes 里补上要重试的错误码。',
    sample: '429: {"code":null,"message":"WorkBuddy AI: usage exceeds frequency limit, but don\'t worry, your usage will reset at 2026-11-05 17:16:57 UTC+8, alternatively, you can switch to the other models to continue using it.","param":null,"type":"rate_limit_error"}',
    rule: {
      name: 'catch-all',
      when: '[\\s\\S]+',
      flags: 'i',
      wait: { kind: 'fixed', ms: 60000 },
      maxRetries: 0,
    },
  },
];

/** Map of preset id → preset entry. */
export const PRESETS_BY_ID = new Map(RETRY_PRESETS.map((preset) => [preset.id, preset]));
