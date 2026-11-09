/**
 * dsh-agents-manager — browser half.
 *
 * Hand-written CJS factory bundle (no build step, no JSX). Everything the user
 * sees lives here: the Settings pages — "MCP 和技能" (MCP manager + Skills
 * editor) and the standalone "子代理" delegation-roles page — the composer
 * capability chip with its selection popover, and the startup-failure toasts.
 * All data flows through the Host half's same-origin HTTP API
 * (`agents-manager/api/v1`).
 *
 * Styling uses only DSH theme tokens (`--dsw-alias-*`) through one prefixed
 * class stylesheet; the plugin-owned <style data-plugin> tag is removed by the
 * module loader on unload.
 */
window.__ModuleLoader__.load({
	id: "dsh-agents-manager",
	factory: function (require) {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var React = require("react");
		var h = React.createElement;
		var useState = React.useState;
		var useEffect = React.useEffect;
		var useMemo = React.useMemo;
		var useCallback = React.useCallback;
		var useRef = React.useRef;

		/** Locale namespace; also the page seat locale field. */
		var NS = "dsh-agents-manager";
		/** HTTP base, resolved document-relative — never origin-absolute. */
		var API_BASE = "agents-manager/api/v1";
		/** Settings page seat key inside the settings family. */
		var SETTINGS_SECTION = "settings.section";
		/** Composer seat for the capability chip. */
		var COMPOSER_LEFT = "conversation.input.left";
		/** Frame-wide floating layer for toasts. */
		var SHELL_OVERLAY = "shell.overlay";
		/** Session-scoped conversation view tabs (对话 / 轨迹 / 进程). */
		var CONVERSATION_VIEW = "conversation.view";
		/** localStorage keys (prefix keeps the profile tidy). */
		var SEEN_FAILURES_KEY = "dsh-agents-manager.seen-failures";

		// ---------------------------------------------------------------------------
		// Dictionaries (mirror locale/zh.json and locale/en.json key for key).
		// ---------------------------------------------------------------------------

		var zh = {
			"page.title": "MCP 和技能",
			"page.tab.mcp": "MCP 服务器",
			"page.tab.skills": "技能",
			"page.reload": "刷新",
			"page.loading": "正在加载…",
			"page.loadFailed": "加载失败：{message}",
			"page.saveOk": "已保存",
			"page.cancel": "取消",
			"page.close": "关闭",
			"mcp.add": "添加服务器",
			"mcp.importPaste": "粘贴配置",
			"mcp.testAll": "全部测试",
			"mcp.testingAll": "测试中…",
			"mcp.empty": "尚未配置 MCP 服务器。粘贴配置或用表单添加。",
			"mcp.count": "{n} 个服务器 · {t} 个工具",
			"mcp.field.name": "服务器名称",
			"mcp.field.transport": "传输方式",
			"mcp.field.command": "命令",
			"mcp.field.args": "参数（每行一个）",
			"mcp.field.env": "环境变量",
			"mcp.field.cwd": "工作目录",
			"mcp.field.url": "URL",
			"mcp.field.headers": "请求头",
			"mcp.field.timeout": "工具调用超时（毫秒）",
			"mcp.field.enabled": "启用",
			"mcp.toggle": "启用 / 停用",
			"mcp.toggleOn": "已启用，点击停用",
			"mcp.toggleOff": "已停用，点击启用",
			"mcp.toggleBusy": "正在连接/断开，请稍候…",
			"mcp.toggleFailed": "切换失败：{message}",
			"mcp.save": "保存",
			"mcp.edit": "编辑",
			"mcp.del": "删除",
			"mcp.delConfirm": "确定删除该服务器？",
			"mcp.test": "测试",
			"mcp.testing": "测试中…",
			"mcp.tools": "工具",
			"mcp.toolCount": "{n} 个工具",
			"mcp.noTools": "未发现工具",
			"mcp.tools.title": "「{name}」工具",
			"mcp.tools.open": "打开工具",
			"mcp.tools.args": "调用参数（JSON）",
			"mcp.tools.run": "调用测试",
			"mcp.tools.running": "调用中…",
			"mcp.tools.result": "调用结果",
			"mcp.tools.badJson": "参数不是有效的 JSON 对象：{message}",
			"mcp.tools.failed": "调用失败：{message}",
			"mcp.more": "More",
			"mcp.more.title": "More actions",
			"mcp.more": "更多",
			"mcp.more.title": "更多操作",
			"mcp.status.ok": "已连接",
			"mcp.status.fail": "失败",
			"mcp.status.testing": "测试中",
			"mcp.status.connecting": "连接中",
			"mcp.status.off": "已停用",
			"mcp.status.unknown": "未测试",
			"mcp.import.title": "粘贴 MCP 配置",
			"mcp.import.hint": "粘贴 JSON 配置（标准 mcpServers 格式、单个服务器对象或裸数组均可）。",
			"mcp.import.parse": "解析",
			"mcp.import.parsed": "解析到 {n} 个服务器：",
			"mcp.import.conflict": "名称已存在",
			"mcp.import.invalid": "条目无效",
			"mcp.import.testAll": "导入前先测试",
			"mcp.import.save": "导入所选",
			"mcp.import.nothing": "未选择任何条目",
			"mcp.import.badJson": "不是有效的 JSON：{message}",
			"mcp.import.fromAgents": "读取 ~/.agents/mcp.json（{n}）",
			"mcp.import.agentsMissing": "~/.agents/mcp.json 不存在或不可读",
			"mcp.import.sync": "同步其他 Agent",
			"mcp.import.sync.title": "同步其他 Agent 的 MCP 配置",
			"mcp.import.sync.hint": "自动检测本机 Claude Code、Codex、zcode、Cursor 的 MCP 配置，勾选后导入（同名覆盖）。",
			"mcp.import.sync.none": "未检测到可导入的 MCP 配置",
			"mcp.import.sync.needRestart": "同步需要新版宿主模块：请完全退出并重启 DeepSeek Harness（不是刷新页面），然后重试。",
			"mcp.import.sync.count": "{n} 台",
			"mcp.import.sync.all": "全选",
			"mcp.import.sync.noneSel": "全不选",
			"mcp.store.error": "存储异常：{message}",
			"mcp.migrated": "已从 ~/.agents/mcp.json 自动导入 {n} 个服务器",
			"mcp.startupFail": "「{name}」MCP 服务器启动失败：{message}",
			"mcp.key": "名称",
			"mcp.value": "值",
			"mcp.addRow": "添加一行",
			"mcp.group.basic": "基础",
			"mcp.group.connection": "连接",
			"mcp.group.advanced": "高级",
			"skills.count": "{n} 个技能",
			"skills.empty": "在 ~/.agents/skills 下未发现技能。",
			"skills.edit": "编辑",
			"skills.editHint": "点击技能直接进入编辑；编辑时左侧为该技能的文件树（悬停自动展开），「← 返回列表」可切换其他技能。",
			"skills.back": "返回列表",
			"skills.files": "文件",
			"skills.untitled": "（未命名技能）",
			"skills.dirty": "有未保存的修改",
			"skills.save": "保存",
			"skills.saving": "保存中…",
			"skills.conflict": "文件已在磁盘上变化，请重新加载后再试。",
			"skills.readonly": "该文件无法编辑（二进制或过大）。",
			"skills.loadFailed": "打开失败：{message}",
			"skills.savedAt": "已保存",
			"skills.desc": "描述",
			"skills.install": "安装技能",
			"skills.install.title": "从 GitHub 安装技能",
			"skills.install.hint": "支持 owner/repo、owner/repo/子目录、#分支 或完整 GitHub 链接；自动识别含 SKILL.md 的技能目录，已存在的跳过。",
			"skills.install.placeholder": "owner/repo 或 GitHub 链接",
			"skills.install.run": "安装",
			"skills.install.installed": "已安装：{names}",
			"skills.install.skipped": "已跳过（已存在）：{names}",
			"skills.install.noneFound": "未找到含 SKILL.md 的技能目录，请指定子目录路径",
			"skills.install.notFound": "仓库不存在或为私有仓库（检查路径与分支）",
			"skills.install.subdirNotFound": "指定的子目录在仓库中不存在",
			"session.chip": "{m} MCP · {s} 技能",
			"session.title": "会话能力",
			"session.mcpGroup": "MCP 服务器",
			"session.skillGroup": "技能",
			"session.all": "全选",
			"session.none": "全不选",
			"session.hint": "作用于当前会话；新会话默认启用全部。",
			"session.mcpOff": "已停用",
			"session.tools": "{n} 个工具",
			"session.filter": "筛选 MCP / 技能…",
			"session.noMatches": "没有匹配项",
			"procs.title": "服务进程",
			"procs.tab": "进程",
			"procs.empty": "本会话暂无运行中的服务进程。AI 启动服务后会自动出现在这里。",
			"procs.pill": "{n} 个服务进程",
			"procs.collapse": "收起",
			"procs.expand": "查看本会话启动的服务进程（{n} 个运行中）",
			"procs.subagent": "子代理",
			"procs.auto": "自动登记",
			"procs.stop": "停止",
			"procs.stopConfirm": "确定停止进程「{name}」？",
			"procs.stopping": "停止中…",
			"procs.errStop": "停止失败：{message}",
			"procs.errNoPid": "该记录未上报 PID 或后台 Job ID，无法远程停止；请让 AI 停止，或补报 pid / jobId。",
			"procs.colName": "服务",
			"procs.colProcess": "进程",
			"procs.colPorts": "端口",
			"procs.colCommand": "启动命令",
			"procs.colAction": "操作",
			"procs.errNetwork": "网络异常，请稍后重试。",
			"toast.mcpStartupFailed": "「{name}」mcp 工具启动失败",
			"toast.detail": "查看详情",
			"toast.dismiss": "关闭",
			"retry.pageTitle": "自动重试",
			"retry.needRestart": "自动重试需要新版宿主模块：请完全退出并重启 DeepSeek Harness（不是刷新页面），然后重试。",
			"retry.tab.policy": "重试策略",
			"retry.tab.rules": "表达式规则",
			"retry.tab.monitor": "监控",
			"retry.hint": "策略是内核 dsh-llm-retry 执行器的 per-provider 配置（改完下一次请求即生效）；规则在本插件内先于内核匹配，命中则按厂商报错提取的等待时间自动重试。",
			"retry.aiHint": "会话中的 AI 也可以用 read_retry_state / test_retry_rule / write_retry_rules 三个工具自助读取真实报错并构建重试规则。",
			"retry.policy.edit": "编辑策略",
			"retry.policy.reset": "重置默认",
			"retry.policy.resetConfirm": "恢复该 provider 的默认重试策略？",
			"retry.policy.notEditable": "该路由不可编辑（无设置命名空间）",
			"retry.policy.normal": "normal · 有限次",
			"retry.policy.always": "always · 无限重试",
			"retry.policy.retries": "最多 {n} 次",
			"retry.policy.infinite": "无限重试直到成功/取消",
			"retry.policy.backoff": "退避 {a}ms–{b}ms（抖动 {j}%）",
			"retry.policy.codes": "可重试码：{codes}",
			"retry.policy.mode": "模式",
			"retry.policy.mode.help": "normal = 有限次重试（达到上限后失败终报）；always = 无限重试直到成功/取消。",
			"retry.policy.maxRetries": "最大重试次数",
			"retry.policy.maxRetries.help": "normal 模式下对可重试失败码的最大重试次数。",
			"retry.policy.retryableCodes": "可重试失败码",
			"retry.policy.retryableCodes.help": "哪些失败码值得重试（逗号分隔）。默认五码即可；额度类（QUOTA）要重试需加入此列表并配合表达式规则。",
			"retry.policy.backoffInit": "初始退避（毫秒）",
			"retry.policy.backoffInit.help": "第一次重试前等待的毫秒数；之后每次翻倍直至上限。",
			"retry.policy.backoffMax": "退避上限（毫秒）",
			"retry.policy.backoffMax.help": "指数退避的封顶毫秒数；厂商 Retry-After 超过此值时 normal 模式会放弃（always 模式改用本地退避）。",
			"retry.policy.backoffJitter": "抖动比例（0–1）",
			"retry.policy.backoffJitter.help": "0–1 之间的抖动比例，避免多会话同时重试。",
			"retry.policy.alwaysWarn": "always 模式对每次失败都无限重试（包括密钥错误、欠费），每次重试都重新计费输入 token；等待可随时被停止按钮取消。",
			"retry.policy.presetDefault": "默认",
			"retry.policy.group.presets": "预设",
			"retry.policy.group.backoff": "指数退避",
			"retry.policy.preset429": "429 友好",
			"retry.policy.presetLong": "长等待 6h",
			"retry.policy.presetAlways": "无限重试",
			"retry.policy.routeLine": "路由 {route}",
			"retry.policy.models": "{n} 个模型",
			"retry.rules.add": "新建规则",
			"retry.code.RATE_LIMIT": "限流",
			"retry.code.SERVER": "服务器错误",
			"retry.code.TIMEOUT": "超时",
			"retry.code.TRANSPORT": "网络中断",
			"retry.code.EMPTY_RESPONSE": "空响应",
			"retry.code.QUOTA": "额度用尽",
			"retry.code.ACCOUNT_QUOTA": "账户额度用尽",
			"retry.code.AUTH": "鉴权失败",
			"retry.code.INVALID_CREDENTIAL": "凭据无效",
			"retry.code.INVALID_REQUEST": "请求无效",
			"retry.code.CONTEXT_WINDOW_EXCEEDED": "上下文超限",
			"retry.code.PI_AI_ERROR": "网关未分类错误",
			"retry.rules.card.providers": "适用于：{p}",
			"retry.rules.card.allProviders": "适用于全部 provider",
			"retry.rules.card.codes": "失败类型：{c}",
			"retry.rules.card.allCodes": "全部失败类型",
			"retry.rules.card.budget": "每回合最多重试 {n} 次",
			"retry.rules.card.unlimited": "每回合无限重试",
			"retry.rules.card.clamp": "单次等待最长 {w}",
			"retry.rules.card.globalClamp": "单次等待最长 {w}（全局上限）",
			"retry.rules.card.waitVia": "等待时长来自{kind}",
			"retry.code.RATE_LIMIT": "Rate limited",
			"retry.code.SERVER": "Server error",
			"retry.code.TIMEOUT": "Timeout",
			"retry.code.TRANSPORT": "Network drop",
			"retry.code.EMPTY_RESPONSE": "Empty response",
			"retry.code.QUOTA": "Quota used up",
			"retry.code.ACCOUNT_QUOTA": "Account quota used up",
			"retry.code.AUTH": "Auth failed",
			"retry.code.INVALID_CREDENTIAL": "Invalid credential",
			"retry.code.INVALID_REQUEST": "Invalid request",
			"retry.code.CONTEXT_WINDOW_EXCEEDED": "Context window exceeded",
			"retry.code.PI_AI_ERROR": "Unclassified gateway error",
			"retry.rules.card.providers": "Applies to: {p}",
			"retry.rules.card.allProviders": "All providers",
			"retry.rules.card.codes": "Failure types: {c}",
			"retry.rules.card.allCodes": "All failure types",
			"retry.rules.card.budget": "Up to {n} retries per turn",
			"retry.rules.card.unlimited": "Unlimited retries per turn",
			"retry.rules.card.clamp": "Each wait at most {w}",
			"retry.rules.card.globalClamp": "Each wait at most {w} (global cap)",
			"retry.rules.card.waitVia": "Wait comes from {kind}",
			"retry.rules.empty": "尚未配置规则。从内置厂商预设一键导入，或新建自定义规则。",
			"retry.rules.group.basic": "基本信息",
			"retry.rules.group.match": "匹配范围",
			"retry.rules.group.wait": "等待提取",
			"retry.rules.group.limits": "重试与限制",
			"retry.rules.presets": "内置预设",
			"retry.rules.presetsTitle": "内置厂商预设",
			"retry.rules.presetsHint": "一键导入常见厂商的限额/限流报错规则；导入后可自由编辑。",
			"retry.rules.import": "导入",
			"retry.rules.importDone": "已导入「{name}」",
			"retry.rules.del": "删除",
			"retry.rules.delConfirm": "删除规则「{name}」？",
			"retry.rules.test": "测试",
			"retry.rules.matched": "命中 · 等待 {wait}（至 {at}）",
			"retry.rules.noWait": "命中但未提取到等待时长",
			"retry.rules.missed": "未命中（{reason}）",
			"retry.rules.editRule": "编辑规则",
			"retry.rules.newRule": "新建规则",
			"retry.rules.field.name": "规则名",
			"retry.rules.field.name.help": "仅用于展示与监控中标注，不参与匹配。",
			"retry.rules.field.when": "匹配正则（JS RegExp 源文本）",
			"retry.rules.field.when.help": "只写正则本体，不带两侧斜杠。例如 已达到\\s*5\\s*小时的?使用上限。常用语法：\\d+ 数字、\\s* 任意空白、. 任意字符、[abc] 字符集、( ) 捕获组（可被「捕获组序号」引用）、| 或、{0,40} 重复范围、\\S+ 非空白串。命中报错正文即触发该规则；多个规则按列表顺序取首个命中。",
			"retry.rules.field.flags": "正则 flags",
			"retry.rules.field.flags.help": "i = 忽略大小写（最常用，Rate/rate 都能命中）；m = 多行模式（^ $ 匹配每行首尾）；可组合如 im；留空 = 精确大小写。不要填 g（全局标志无意义且会被拒绝）。",
			"retry.rules.field.providers": "限定 provider（逗号分隔，空=全部）",
			"retry.rules.field.providers.help": "只在这些 provider 路由上报错时才尝试本规则，如 magpie-anthropic, magpie。留空 = 对所有 provider 生效。",
			"retry.rules.field.codes": "限定失败码（逗号分隔，空=全部）",
			"retry.rules.field.codes.help": "先按宿主归一后的失败码过滤再跑正则。常用：RATE_LIMIT（限流）、QUOTA（额度用尽）、PI_AI_ERROR（网关无法归一的杂项错误，中转站常见）、SERVER、TIMEOUT。留空 = 不过滤。",
			"retry.rules.field.waitKind": "等待提取方式",
			"retry.rules.field.waitKind.help": "决定从报错文本的哪个部分读出「等多久」：Retry-After 响应头 / 正文里的英文时长 / 中文时长 / 绝对重置时刻 / Unix 时间戳 / JSON 字段 / 时钟时刻。",
			"retry.rules.field.tz": "时区（reset-at 用，如 +08:00）",
			"retry.rules.field.tz.help": "厂商报文里的重置时刻常不带时区（智谱/bigmodel 按北京时间），此参数告诉提取器按哪个时区解析。+08:00 即东八区。",
			"retry.rules.field.defaultMs": "缺省等待（毫秒，retry-after 用）",
			"retry.rules.field.defaultMs.help": "厂商没给 Retry-After 时使用的兜底等待时长。10000 = 10 秒。",
			"retry.rules.field.fixedMs": "固定间隔（毫秒，fixed 用）",
			"retry.rules.field.fixedMs.help": "每次重试前固定等待的时长，不读报错文本、忽略厂商 Retry-After。60000 = 1 分钟。低于 1 秒会被抬到 1 秒。",
			"retry.rules.field.group": "捕获组序号（1 起，可选）",
			"retry.rules.field.group.help": "填 N 表示用正则里第 N 个 ( ) 捕获到的文本去做时长提取（从 1 数起）。留空 = 在整段报错文本里找。",
			"retry.rules.field.maxRetries": "每 turn 预算（次）",
			"retry.rules.field.maxRetries.help": "本规则在一次对话回合内最多触发几次等待重试；填 0 = 无限重试；超出后交给内核默认策略。回合结束自动重置。",
			"retry.rules.field.clampMs": "等待上限（毫秒）",
			"retry.rules.field.clampMs.help": "本规则单次等待的最长时间（护栏，防止提取出异常大的值）。留空 = 用全局上限。21600000 = 6 小时，86400000 = 24 小时（最大）。",
			"retry.rules.field.enabled": "启用",
			"retry.rules.field.enabled.help": "停用后规则保留但不再参与匹配。",
			"retry.rules.wait.retry-after": "厂商 Retry-After",
			"retry.rules.wait.fixed": "固定间隔（自定毫秒）",
			"retry.rules.wait.duration-text": "英文时长（4h 5min / 30s）",
			"retry.rules.wait.duration-cn": "中文时长（请 1 分钟后重试）",
			"retry.rules.wait.reset-at": "绝对时刻（限额将在 … 重置）",
			"retry.rules.wait.unix-seconds": "Unix 秒（usage limit reached|…）",
			"retry.rules.wait.epoch-json": "JSON 字段（resets_at / resets_in_seconds）",
			"retry.rules.wait.clock-time": "时钟时刻（请于 17:00 后重试）",
			"retry.rules.testTitle": "测试规则",
			"retry.rules.testHint": "粘贴厂商真实报错文本（或点预设样本），即时查看是否命中与提取的等待时长。",
			"retry.rules.testSample": "用预设样本",
			"retry.rules.testRun": "测试",
			"retry.rules.testText": "报错文本",
			"retry.rules.save": "保存规则",
			"retry.rules.fallback": "全局等待上限（毫秒，1 000–86 400 000）",
			"retry.rules.clampHint": "所有规则等待的默认上限；规则可单独覆盖（≤24h）。",
			"retry.monitor.active": "进行中的等待",
			"retry.monitor.none": "暂无进行中的等待",
			"retry.monitor.recent": "最近事件",
			"retry.monitor.noRecent": "暂无事件",
			"retry.monitor.retry": "第 {n} 次重试",
			"retry.monitor.pluginRule": "规则",
			"retry.monitor.builtin": "内核",
			"retry.monitor.aiTools": "AI 工具：read_retry_state · test_retry_rule · write_retry_rules",
			"retry.monitor.persistHint": "最近事件跨重启保留最近 100 条（含未触发重试的失败）；进行中的等待随宿主重启消失。",
			"retry.monitor.failureRow": "未重试",
			"retry.monitor.reason.no-rules": "无规则可匹配（尚未导入或新建规则）",
			"retry.monitor.reason.no-match": "规则未命中，交由内核默认策略",
			"retry.monitor.reason.budget-exhausted": "本回合重试预算用尽",
			"retry.monitor.reason.cancelled": "等待被取消：会话中止（手动停止 / 切换模型 / 配置重载）",
			"subagents.pageTitle": "子代理",
			"subagents.tab.roles": "角色",
			"subagents.group.basic": "基本信息",
			"subagents.tab.models": "模型池",
			"subagents.pool.add": "新增模型",
			"subagents.pool.empty": "模型池为空。在这里登记模型并写明用途（如：视觉 / 复杂推理 / 决策路由），子代理角色与主 Agent 都会读取这份说明。",
			"subagents.pool.field.name": "显示名称",
			"subagents.pool.field.usage": "用途描述（模型可见，如：用于视觉 / 复杂任务 / 决策模型）",
			"subagents.pool.field.effort": "默认推理强度",
			"subagents.pool.enabled": "启用",
			"subagents.pool.delConfirm": "确定删除该模型？",
			"subagents.pool.usageEmpty": "（未写用途）",
			"subagents.pool.importAll": "自动同步设置页模型",
			"subagents.pool.importAll.hint": "打开模型池时自动把「设置 → 模型」页的全部模型铺进来（缺的才加），你只需补用途描述。",
			"subagents.pool.importAll.done": "已自动同步 {n} 个新模型进池，请补充用途描述",
			"subagents.pool.importAll.empty": "设置页没有可同步的模型",
			"subagents.role.fromPool": "从模型池添加候选",
			"subagents.role.decision": "模型决策",
			"subagents.role.decision.local": "本机 Agent 决策（默认）",
			"subagents.role.decision.remote": "远程决策模型",
			"subagents.role.decision.baseURL": "接口地址（OpenAI 兼容，如 http://127.0.0.1:8000/v1）",
			"subagents.role.decision.modelId": "决策模型 ID",
			"subagents.role.decision.apiKey": "API Key（可选）",
			"subagents.role.decision.hint": "委派未显式指定模型时，先调用该决策模型从候选中选择；失败自动回退候选链首位。",
			"subagents.role.openPool": "向主 Agent 开放整个模型池",
			"subagents.role.openPoolHint": "开启后该角色工具的模型枚举为模型池全部启用模型，主 Agent 按用途描述自行决策。",
			"subagents.role.caps": "子代理能力（MCP / 技能）",
			"subagents.role.caps.hint": "限制该角色的子代理可用的 MCP 服务器与技能；两组默认跟随调用会话的选择，也可按角色固定一份白名单。",
			"subagents.role.caps.mcp": "MCP 服务器",
			"subagents.role.caps.skills": "技能",
			"subagents.role.caps.follow": "跟随会话选择",
			"subagents.role.caps.custom": "自定义白名单",
			"subagents.role.caps.all": "全选",
			"subagents.role.caps.none": "全不选",
			"subagents.role.caps.emptyMcp": "没有已启用的 MCP 服务器",
			"subagents.role.caps.emptySkills": "没有已安装的技能",
			"subagents.role.caps.count": "已选 {n}/{t}",
			"subagents.role.up": "上移",
			"subagents.role.down": "下移",
			"subagents.needRestart": "子代理功能需要新版宿主模块：请完全退出并重启 DeepSeek Harness（不是刷新页面），然后重试。",
			"subagents.add": "添加角色",
			"subagents.export": "导出",
			"subagents.empty": "尚未配置子代理角色。为角色定义候选模型链，主代理会按各候选的描述动态选择模型。",
			"subagents.count": "{r} 个角色 · {m} 个候选模型",
			"subagents.field.name": "角色名（工具名后缀，生成 delegate_<角色名>）",
			"subagents.field.description": "角色描述（模型可见）",
			"subagents.field.promptPrefix": "任务前缀（可选，拼接在任务前）",
			"subagents.field.preset": "Agent preset id（可选）",
			"subagents.field.maxTokens": "输出上限 maxTokens（可选）",
			"subagents.field.enabled": "启用",
			"subagents.models": "候选模型（按优先级排序，首个为缺省）",
			"subagents.models.hint": "模型调用失败时，失败结果会列出剩余候选，主代理换模重试。",
			"subagents.model.provider": "Provider",
			"subagents.model.id": "模型 ID",
			"subagents.model.effort": "推理力度（可选）",
			"subagents.model.description": "描述（模型可见）",
			"subagents.model.add": "添加候选",
			"subagents.model.remove": "移除",
			"subagents.modelCount": "{n} 个候选",
			"subagents.save": "保存",
			"subagents.edit": "编辑",
			"subagents.del": "删除",
			"subagents.delConfirm": "确定删除该角色？",
			"subagents.off": "已停用",
			"subagents.export.title": "导出角色配置",
			"subagents.export.hint": "复制以下 JSON 备份或迁移到其他机器。",
			"subagents.needModels": "至少配置一个候选模型（provider 与模型 ID 必填）",
			"subagents.needDescription": "角色描述不能为空",
			"subagents.needMaxTokens": "maxTokens 需为正整数",
			"subagents.modelPoolOpen": "模型随选",
			"subagents.builtin.badge": "内置",
			"subagents.builtin.customized": "内置·已自定义",
			"subagents.builtin.delConfirm": "该角色是插件内置角色：删除后仅隐藏，可在下方「已隐藏的内置角色」中恢复。",
			"subagents.builtin.hiddenTitle": "已隐藏的内置角色",
			"subagents.builtin.restore": "恢复默认",
			"subagents.builtin.modelsHint": "内置角色可以不设候选模型：不设时子代理继承当前会话模型，主代理也可从模型池按用途选路。",
		};

		var en = {
			"page.title": "MCP & Skills",
			"page.tab.mcp": "MCP Servers",
			"page.tab.skills": "Skills",
			"page.reload": "Reload",
			"page.loading": "Loading…",
			"page.loadFailed": "Failed to load: {message}",
			"page.saveOk": "Saved",
			"page.cancel": "Cancel",
			"page.close": "Close",
			"mcp.add": "Add server",
			"mcp.importPaste": "Paste config",
			"mcp.testAll": "Test all",
			"mcp.testingAll": "Testing…",
			"mcp.empty": "No MCP servers configured. Paste a config or add one by form.",
			"mcp.count": "{n} server(s) · {t} tool(s)",
			"mcp.field.name": "Server name",
			"mcp.field.transport": "Transport",
			"mcp.field.command": "Command",
			"mcp.field.args": "Arguments (one per line)",
			"mcp.field.env": "Environment variables",
			"mcp.field.cwd": "Working directory",
			"mcp.field.url": "URL",
			"mcp.field.headers": "Headers",
			"mcp.field.timeout": "Tool call timeout (ms)",
			"mcp.field.enabled": "Enabled",
			"mcp.toggle": "Enable / disable",
			"mcp.toggleOn": "Enabled, click to disable",
			"mcp.toggleOff": "Disabled, click to enable",
			"mcp.toggleBusy": "Connecting/disconnecting…",
			"mcp.toggleFailed": "Toggle failed: {message}",
			"mcp.save": "Save",
			"mcp.edit": "Edit",
			"mcp.del": "Delete",
			"mcp.delConfirm": "Delete this server?",
			"mcp.test": "Test",
			"mcp.testing": "Testing…",
			"mcp.tools": "Tools",
			"mcp.toolCount": "{n} tools",
			"mcp.noTools": "No tools discovered",
			"mcp.tools.title": "\"{name}\" tools",
			"mcp.tools.open": "Open tools",
			"mcp.tools.args": "Arguments (JSON)",
			"mcp.tools.run": "Test call",
			"mcp.tools.running": "Calling…",
			"mcp.tools.result": "Result",
			"mcp.tools.badJson": "Arguments are not a valid JSON object: {message}",
			"mcp.tools.failed": "Call failed: {message}",
			"mcp.status.ok": "Connected",
			"mcp.status.fail": "Failed",
			"mcp.status.testing": "Testing",
			"mcp.status.connecting": "Connecting",
			"mcp.status.off": "Disabled",
			"mcp.status.unknown": "Not tested",
			"mcp.import.title": "Paste MCP config",
			"mcp.import.hint": "Paste a JSON config (standard mcpServers format, a single server object, or a bare list).",
			"mcp.import.parse": "Parse",
			"mcp.import.parsed": "Parsed {n} server(s):",
			"mcp.import.conflict": "Name exists",
			"mcp.import.invalid": "Invalid entry",
			"mcp.import.testAll": "Test before import",
			"mcp.import.save": "Import selected",
			"mcp.import.nothing": "Nothing selected",
			"mcp.import.badJson": "Not valid JSON: {message}",
			"mcp.import.fromAgents": "Read ~/.agents/mcp.json ({n})",
			"mcp.import.agentsMissing": "~/.agents/mcp.json is missing or unreadable",
			"mcp.import.sync": "Sync other agents",
			"mcp.import.sync.title": "Sync MCP config from other agents",
			"mcp.import.sync.hint": "Auto-detects Claude Code, Codex, zcode, and Cursor MCP configs on this machine; checked items are imported (same-name overwritten).",
			"mcp.import.sync.none": "No importable MCP config detected",
			"mcp.import.sync.needRestart": "Sync needs the updated host module: fully quit and restart DeepSeek Harness (not just a page refresh), then retry.",
			"mcp.import.sync.count": "{n} server(s)",
			"mcp.import.sync.all": "All",
			"mcp.import.sync.noneSel": "None",
			"mcp.store.error": "Storage issue: {message}",
			"mcp.migrated": "Imported {n} server(s) from ~/.agents/mcp.json automatically",
			"mcp.startupFail": "\"{name}\" MCP server failed at startup: {message}",
			"mcp.key": "key",
			"mcp.value": "value",
			"mcp.addRow": "Add row",
			"mcp.group.basic": "Basic",
			"mcp.group.connection": "Connection",
			"mcp.group.advanced": "Advanced",
			"skills.count": "{n} skill(s)",
			"skills.empty": "No skills found under ~/.agents/skills.",
			"skills.edit": "Edit",
			"skills.editHint": "Click a skill to start editing; the left rail is that skill's file tree (expands on hover), \"← Back to list\" switches skills.",
			"skills.back": "Back to list",
			"skills.files": "Files",
			"skills.untitled": "(untitled skill)",
			"skills.dirty": "Unsaved changes",
			"skills.save": "Save",
			"skills.saving": "Saving…",
			"skills.conflict": "File changed on disk. Reload and retry.",
			"skills.readonly": "This file cannot be edited (binary or too large).",
			"skills.loadFailed": "Failed to open: {message}",
			"skills.savedAt": "Saved",
			"skills.desc": "Description",
			"skills.install": "Install skill",
			"skills.install.title": "Install skill from GitHub",
			"skills.install.hint": "Accepts owner/repo, owner/repo/subdir, #branch, or a full GitHub URL; skill dirs with SKILL.md are detected automatically, existing ones are skipped.",
			"skills.install.placeholder": "owner/repo or GitHub URL",
			"skills.install.run": "Install",
			"skills.install.installed": "Installed: {names}",
			"skills.install.skipped": "Skipped (already present): {names}",
			"skills.install.noneFound": "No skill directory with SKILL.md found; specify a subdirectory path",
			"skills.install.notFound": "Repository not found or private (check path and branch)",
			"skills.install.subdirNotFound": "The specified subdirectory does not exist in the repository",
			"session.chip": "{m} MCP · {s} Skills",
			"session.title": "Session capabilities",
			"session.mcpGroup": "MCP servers",
			"session.skillGroup": "Skills",
			"session.all": "All",
			"session.none": "None",
			"session.hint": "Applies to the current session. New sessions default to all enabled.",
			"session.mcpOff": "disabled",
			"session.tools": "{n} tools",
			"session.filter": "Filter MCP / skills…",
			"session.noMatches": "No matches",
			"procs.title": "Service processes",
			"procs.tab": "Processes",
			"procs.empty": "No running service processes in this session yet. AI-started services appear here automatically.",
			"procs.pill": "{n} service(s)",
			"procs.collapse": "Collapse",
			"procs.expand": "Show services this session started ({n} running)",
			"procs.subagent": "subagent",
			"procs.auto": "auto-registered",
			"procs.stop": "Stop",
			"procs.stopConfirm": "Stop process \"{name}\"?",
			"procs.stopping": "Stopping…",
			"procs.errStop": "Stop failed: {message}",
			"procs.errNoPid": "This record has neither a reported pid nor a background job id, so it cannot be stopped remotely; ask the AI to stop it, or re-report with a pid/jobId.",
			"procs.colName": "Service",
			"procs.colProcess": "Process",
			"procs.colPorts": "Ports",
			"procs.colCommand": "Command",
			"procs.colAction": "Actions",
			"procs.errNetwork": "Network error; try again shortly.",
			"toast.mcpStartupFailed": "\"{name}\" MCP tools failed at startup",
			"toast.detail": "Details",
			"toast.dismiss": "Dismiss",
			"retry.pageTitle": "Auto Retry",
			"retry.needRestart": "Auto retry needs the updated host module: fully quit and restart DeepSeek Harness (not just a page refresh), then retry.",
			"retry.tab.policy": "Retry policies",
			"retry.tab.rules": "Expression rules",
			"retry.tab.monitor": "Monitor",
			"retry.hint": "Policies are the built-in dsh-llm-retry executor's per-provider config (effective on the next request); rules are matched by this plugin ahead of the executor and auto-retry with the wait extracted from the vendor error.",
			"retry.aiHint": "The session AI can also build retry rules itself with the read_retry_state / test_retry_rule / write_retry_rules tools.",
			"retry.policy.edit": "Edit policy",
			"retry.policy.reset": "Reset default",
			"retry.policy.resetConfirm": "Restore the default retry policy for this provider?",
			"retry.policy.notEditable": "This route is not editable (no settings namespace)",
			"retry.policy.normal": "normal · bounded",
			"retry.policy.always": "always · infinite",
			"retry.policy.retries": "up to {n} retries",
			"retry.policy.infinite": "retries until success/cancel",
			"retry.policy.backoff": "backoff {a}ms–{b}ms (jitter {j}%)",
			"retry.policy.codes": "retryable codes: {codes}",
			"retry.policy.mode": "Mode",
			"retry.policy.mode.help": "normal = bounded retries (failure ends the turn once exhausted); always = retry every failure until success/cancel.",
			"retry.policy.maxRetries": "Max retries",
			"retry.policy.maxRetries.help": "Maximum retries (normal mode) for retryable failure codes.",
			"retry.policy.retryableCodes": "Retryable failure codes",
			"retry.policy.retryableCodes.help": "Which failure codes are worth retrying (comma-separated). The default five suffice; quota-class codes (QUOTA) need to be listed here and paired with an expression rule.",
			"retry.policy.backoffInit": "Initial backoff (ms)",
			"retry.policy.backoffInit.help": "Milliseconds to wait before the first retry; doubles each attempt up to the cap.",
			"retry.policy.backoffMax": "Backoff cap (ms)",
			"retry.policy.backoffMax.help": "Ceiling for exponential backoff in ms; a provider Retry-After beyond this makes normal mode give up (always mode falls back to local backoff).",
			"retry.policy.backoffJitter": "Jitter ratio (0–1)",
			"retry.policy.backoffJitter.help": "Jitter ratio between 0 and 1, so concurrent sessions don't retry in lockstep.",
			"retry.policy.alwaysWarn": "Always mode retries every failure without limit (including auth and quota errors); each retry re-bills input tokens. Waits can be cancelled with the stop button.",
			"retry.policy.presetDefault": "Default",
			"retry.policy.group.presets": "Presets",
			"retry.policy.group.backoff": "Exponential backoff",
			"retry.policy.preset429": "429 friendly",
			"retry.policy.presetLong": "Long wait 6h",
			"retry.policy.presetAlways": "Infinite",
			"retry.policy.routeLine": "route {route}",
			"retry.policy.models": "{n} models",
			"retry.rules.add": "New rule",
			"retry.rules.empty": "No rules yet. Import a built-in vendor preset in one click, or create a custom rule.",
			"retry.rules.group.basic": "Basics",
			"retry.rules.group.match": "Match scope",
			"retry.rules.group.wait": "Wait extraction",
			"retry.rules.group.limits": "Retry & limits",
			"retry.rules.presets": "Built-in presets",
			"retry.rules.presetsTitle": "Built-in vendor presets",
			"retry.rules.presetsHint": "One-click import of common vendor limit/rate-error rules; freely editable after import.",
			"retry.rules.import": "Import",
			"retry.rules.importDone": "Imported \"{name}\"",
			"retry.rules.del": "Delete",
			"retry.rules.delConfirm": "Delete rule \"{name}\"?",
			"retry.rules.test": "Test",
			"retry.rules.matched": "Matched · wait {wait} (until {at})",
			"retry.rules.noWait": "Matched but no wait extracted",
			"retry.rules.missed": "No match ({reason})",
			"retry.rules.editRule": "Edit rule",
			"retry.rules.newRule": "New rule",
			"retry.rules.field.name": "Rule name",
			"retry.rules.field.name.help": "Display only — used in listings and the monitor; never matched.",
			"retry.rules.field.when": "Match regex (JS RegExp source)",
			"retry.rules.field.when.help": "The regex body only, no surrounding slashes. Example: usage\\s+limit\\s+reached. Common syntax: \\d+ digits, \\s* any whitespace, . any char, [abc] char set, ( ) capture group (referenced by \"Capture group\"), | alternation, {0,40} repeat range, \\S+ non-space run. A hit on the error text triggers this rule; rules are evaluated in list order, first hit wins.",
			"retry.rules.field.flags": "Regex flags",
			"retry.rules.field.flags.help": "i = case-insensitive (most common; matches Rate and rate alike); m = multiline (^ and $ match each line); combine like im; empty = case-sensitive. Do not use g (global flag is meaningless here and rejected).",
			"retry.rules.field.providers": "Limit to providers (comma-separated, empty = all)",
			"retry.rules.field.providers.help": "Only try this rule for failures on these provider routes, e.g. magpie-anthropic, magpie. Empty = all providers.",
			"retry.rules.field.codes": "Limit to failure codes (comma-separated, empty = all)",
			"retry.rules.field.codes.help": "Pre-filter on the harness-normalized failure code before the regex runs. Common: RATE_LIMIT, QUOTA (allowance used up), PI_AI_ERROR (unclassifiable gateway errors, common with relays), SERVER, TIMEOUT. Empty = no filter.",
			"retry.rules.field.waitKind": "Wait extraction",
			"retry.rules.field.waitKind.help": "Where to read \"how long to wait\" from the error: the Retry-After header / an English duration in the text / a Chinese duration / an absolute reset time / a Unix timestamp / JSON fields / a clock time.",
			"retry.rules.field.tz": "Timezone (for reset-at, e.g. +08:00)",
			"retry.rules.field.tz.help": "Vendor reset times often carry no zone (Zhipu/bigmodel write Beijing time); this tells the extractor which zone to parse them in. +08:00 is UTC+8.",
			"retry.rules.field.defaultMs": "Default wait (ms, for retry-after)",
			"retry.rules.field.defaultMs.help": "Fallback wait when the provider sent no Retry-After. 10000 = 10 seconds.",
			"retry.rules.field.fixedMs": "Fixed interval (ms, for fixed)",
			"retry.rules.field.fixedMs.help": "The constant wait before every retry — it reads nothing from the error text and ignores the provider Retry-After. 60000 = 1 minute. Values below 1 second are raised to 1 second.",
			"retry.rules.field.group": "Capture group (1-based, optional)",
			"retry.rules.field.group.help": "N means extract the wait from the text captured by the Nth ( ) group (counting from 1). Empty = scan the whole error text.",
			"retry.rules.field.maxRetries": "Per-turn budget",
			"retry.rules.field.maxRetries.help": "How many timed retries this rule may trigger within one conversation turn; 0 = retry forever; beyond that the built-in policy takes over. Resets when the turn ends.",
			"retry.rules.field.clampMs": "Wait cap (ms)",
			"retry.rules.field.clampMs.help": "Ceiling for a single wait of this rule (a guardrail against absurdly large extractions). Empty = the global cap. 21600000 = 6 hours, 86400000 = 24 hours (maximum).",
			"retry.rules.field.enabled": "Enabled",
			"retry.rules.field.enabled.help": "Disabled rules are kept but never matched.",
			"retry.rules.wait.retry-after": "Provider Retry-After",
			"retry.rules.wait.fixed": "Fixed interval (custom ms)",
			"retry.rules.wait.duration-text": "English duration (4h 5min / 30s)",
			"retry.rules.wait.duration-cn": "Chinese duration (请 1 分钟后重试)",
			"retry.rules.wait.reset-at": "Absolute time (limit resets at …)",
			"retry.rules.wait.unix-seconds": "Unix seconds (usage limit reached|…)",
			"retry.rules.wait.epoch-json": "JSON fields (resets_at / resets_in_seconds)",
			"retry.rules.wait.clock-time": "Clock time (available at 17:00)",
			"retry.rules.testTitle": "Test rule",
			"retry.rules.testHint": "Paste a real vendor error (or use a preset sample) and see whether it matches and the wait it extracts.",
			"retry.rules.testSample": "Use preset sample",
			"retry.rules.testRun": "Test",
			"retry.rules.testText": "Error text",
			"retry.rules.save": "Save rule",
			"retry.rules.fallback": "Global wait cap (ms, 1,000–86,400,000)",
			"retry.rules.clampHint": "Default ceiling for every rule's wait; rules may override it (≤24h).",
			"retry.monitor.active": "Waiting",
			"retry.monitor.none": "No active waits",
			"retry.monitor.recent": "Recent events",
			"retry.monitor.noRecent": "No events yet",
			"retry.monitor.retry": "retry #{n}",
			"retry.monitor.pluginRule": "rule",
			"retry.monitor.builtin": "built-in",
			"retry.monitor.aiTools": "AI tools: read_retry_state · test_retry_rule · write_retry_rules",
			"retry.monitor.persistHint": "Recent events survive restarts (last 100, including failures that scheduled no retry); in-flight waits die with the host.",
			"retry.monitor.failureRow": "No retry",
			"retry.monitor.reason.no-rules": "no rules configured (import or create one)",
			"retry.monitor.reason.no-match": "no rule matched — kernel default policy takes over",
			"retry.monitor.reason.budget-exhausted": "per-turn retry budget exhausted",
			"retry.monitor.reason.cancelled": "wait cancelled: turn aborted (stop / model switch / config reload)",
			"subagents.pageTitle": "Subagents",
			"subagents.tab.roles": "Roles",
			"subagents.group.basic": "Basics",
			"subagents.tab.models": "Model pool",
			"subagents.pool.add": "Add model",
			"subagents.pool.empty": "The model pool is empty. Register models here with a usage description (vision / heavy reasoning / decision routing); subagent roles and the main agent both read it.",
			"subagents.pool.field.name": "Display name",
			"subagents.pool.field.usage": "Usage description (model-visible, e.g. vision / heavy tasks / decision model)",
			"subagents.pool.field.effort": "Default reasoning effort",
			"subagents.pool.enabled": "Enabled",
			"subagents.pool.delConfirm": "Delete this model?",
			"subagents.pool.usageEmpty": "(no usage yet)",
			"subagents.pool.importAll": "Auto-sync settings-page models",
			"subagents.pool.importAll.hint": "Opening the model pool automatically lays in every Settings → Models model you are missing; you only fill in usage descriptions.",
			"subagents.pool.importAll.done": "Auto-synced {n} new model(s) into the pool — fill in their usages",
			"subagents.pool.importAll.empty": "No syncable models on the settings page",
			"subagents.role.fromPool": "Add candidate from the pool",
			"subagents.role.decision": "Model decision",
			"subagents.role.decision.local": "Local agent decides (default)",
			"subagents.role.decision.remote": "Remote decision model",
			"subagents.role.decision.baseURL": "Endpoint (OpenAI-compatible, e.g. http://127.0.0.1:8000/v1)",
			"subagents.role.decision.modelId": "Decision model id",
			"subagents.role.decision.apiKey": "API key (optional)",
			"subagents.role.decision.hint": "When the call omits the model, the decision model picks from the candidates first; failures fall back to the first candidate.",
			"subagents.role.openPool": "Expose the whole model pool to the main agent",
			"subagents.role.openPoolHint": "The tool model enum becomes every enabled pool model; the main agent decides from the usage descriptions.",
			"subagents.role.caps": "Subagent capabilities (MCP / skills)",
			"subagents.role.caps.hint": "Restrict which MCP servers and skills this role's subagents may use; both groups follow the calling session's selection by default, or pin a per-role whitelist.",
			"subagents.role.caps.mcp": "MCP servers",
			"subagents.role.caps.skills": "Skills",
			"subagents.role.caps.follow": "Follow session selection",
			"subagents.role.caps.custom": "Custom whitelist",
			"subagents.role.caps.all": "All",
			"subagents.role.caps.none": "None",
			"subagents.role.caps.emptyMcp": "No enabled MCP servers",
			"subagents.role.caps.emptySkills": "No installed skills",
			"subagents.role.caps.count": "{n}/{t} selected",
			"subagents.role.up": "Move up",
			"subagents.role.down": "Move down",
			"subagents.needRestart": "Subagent delegation needs the updated host module: fully quit and restart DeepSeek Harness (not just a page refresh), then retry.",
			"subagents.add": "Add role",
			"subagents.export": "Export",
			"subagents.empty": "No delegation roles yet. Define a role with its model candidates and the main agent will pick a model per call from their descriptions.",
			"subagents.count": "{r} role(s) · {m} candidate model(s)",
			"subagents.field.name": "Role name (tool suffix; becomes delegate_<role>)",
			"subagents.field.description": "Role description (model-visible)",
			"subagents.field.promptPrefix": "Task prefix (optional, prepended to the task)",
			"subagents.field.preset": "Agent preset id (optional)",
			"subagents.field.maxTokens": "Output cap maxTokens (optional)",
			"subagents.field.enabled": "Enabled",
			"subagents.models": "Model candidates (priority order; the first is the default)",
			"subagents.models.hint": "On a model failure the error result lists the remaining candidates so the main agent retries on another model.",
			"subagents.model.provider": "Provider",
			"subagents.model.id": "Model id",
			"subagents.model.effort": "Reasoning effort (optional)",
			"subagents.model.description": "Description (model-visible)",
			"subagents.model.add": "Add candidate",
			"subagents.model.remove": "Remove",
			"subagents.modelCount": "{n} candidate(s)",
			"subagents.save": "Save",
			"subagents.edit": "Edit",
			"subagents.del": "Delete",
			"subagents.delConfirm": "Delete this role?",
			"subagents.off": "disabled",
			"subagents.export.title": "Export role config",
			"subagents.export.hint": "Copy this JSON for backup or migration to another machine.",
			"subagents.needModels": "Configure at least one model candidate (provider and model id are required)",
			"subagents.needDescription": "The role description cannot be empty",
			"subagents.needMaxTokens": "maxTokens must be a positive integer",
			"subagents.modelPoolOpen": "pool-routed",
			"subagents.builtin.badge": "Built-in",
			"subagents.builtin.customized": "Built-in · customized",
			"subagents.builtin.delConfirm": "This is a plugin built-in role: deleting only hides it; restore it under \"Hidden built-in roles\" below.",
			"subagents.builtin.hiddenTitle": "Hidden built-in roles",
			"subagents.builtin.restore": "Restore default",
			"subagents.builtin.modelsHint": "Built-in roles may omit model candidates: the child then inherits the calling session's model, and the main agent may pick one from the model pool by usage.",
		};

		// ---------------------------------------------------------------------------
		// Stylesheet — theme tokens only, every class prefixed `am-`.
		// ---------------------------------------------------------------------------

		var CSS = [
			/* ---- page shell ---- */
			".am-page { display: flex; flex-direction: column; gap: 16px; height: 100%; min-height: 0; color: var(--dsw-alias-label-primary); font-size: 13px; }",
			".am-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }",
			".am-head h2 { margin: 0; font-size: 16px; font-weight: 600; letter-spacing: .2px; }",
			".am-sub { color: var(--dsw-alias-label-secondary); font-size: 12px; }",
			".am-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }",
			".am-spacer { flex: 1; }",
			".am-stack { display: flex; flex-direction: column; gap: 10px; min-height: 0; }",
			".am-stack[data-gap='sm'] { gap: 8px; }",
			".am-inline-form { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }",
			/* ---- segmented tabs ---- */
			".am-tabs { display: inline-flex; gap: 2px; padding: 3px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 9px; background: var(--dsw-alias-bg-base); }",
			".am-tab { border: 0; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12.5px; line-height: 1; padding: 6px 13px; border-radius: 6px; cursor: pointer; transition: color .12s ease, background-color .12s ease; }",
			".am-tab:hover { color: var(--dsw-alias-label-primary); }",
			".am-tab[data-active='true'] { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent); color: var(--dsw-alias-brand-primary); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--dsw-alias-brand-primary) 30%, transparent); }",
			".am-tab:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); }",
			/* ---- buttons ---- */
			".am-btn { display: inline-flex; align-items: center; justify-content: center; gap: 5px; height: 28px; padding: 0 12px; font: inherit; font-size: 12.5px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); cursor: pointer; white-space: nowrap; transition: border-color .12s ease, background-color .12s ease, color .12s ease, opacity .12s ease; }",
			".am-btn:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary); }",
			".am-btn:disabled { opacity: .45; cursor: default; }",
			".am-btn[data-variant='primary'] { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); font-weight: 500; }",
			".am-btn[data-variant='primary']:hover:not(:disabled) { filter: brightness(1.08); }",
			".am-btn[data-variant='primary']:active:not(:disabled) { filter: brightness(.96); }",
			".am-btn[data-variant='danger'] { color: var(--dsw-alias-state-error-primary); }",
			".am-btn[data-variant='danger']:hover:not(:disabled) { border-color: var(--dsw-alias-state-error-primary); }",
			".am-btn[data-variant='ghost'] { border-color: transparent; background: transparent; color: var(--dsw-alias-label-secondary); }",
			".am-btn[data-variant='ghost']:hover:not(:disabled) { color: var(--dsw-alias-label-primary); border-color: transparent; background: var(--dsw-alias-interactive-bg-hover); }",
			".am-btn[data-size='sm'] { height: 24px; padding: 0 9px; font-size: 12px; flex: none; }",
			".am-btn:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); }",
			/* ---- badges & status dots ---- */
			".am-badge { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; line-height: 1; color: var(--dsw-alias-label-secondary); border: 1px solid var(--dsw-alias-border-l1); background: color-mix(in srgb, var(--dsw-alias-label-secondary) 6%, transparent); border-radius: 999px; padding: 3px 8px; white-space: nowrap; }",
			".am-badge[data-tone='ok'] { color: var(--dsw-alias-state-success-primary); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent); border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 35%, transparent); }",
			".am-badge[data-tone='fail'] { color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 35%, transparent); }",
			".am-badge[data-tone='idle'] { color: var(--dsw-alias-state-idle-primary); background: color-mix(in srgb, var(--dsw-alias-state-idle-primary) 10%, transparent); border-color: color-mix(in srgb, var(--dsw-alias-state-idle-primary) 32%, transparent); }",
			".am-badge[data-tone='warn'] { color: var(--dsw-alias-state-warn-primary); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent); border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 35%, transparent); }",
			".am-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }",
			".am-dot[data-tone='ok'] { background: var(--dsw-alias-state-success-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-success-primary) 20%, transparent); }",
			".am-dot[data-tone='fail'] { background: var(--dsw-alias-state-error-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-error-primary) 20%, transparent); }",
			".am-dot[data-tone='idle'] { background: var(--dsw-alias-state-idle-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-idle-primary) 16%, transparent); }",
			".am-dot[data-tone='testing'] { background: var(--dsw-alias-state-warn-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-warn-primary) 22%, transparent); }",
			".am-dot[data-tone='testing'][data-pulse='true'] { animation: am-dot-pulse 1.1s ease-in-out infinite; }",
			"@keyframes am-dot-pulse { 0%, 100% { box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-warn-primary) 22%, transparent); } 50% { box-shadow: 0 0 0 5px color-mix(in srgb, var(--dsw-alias-state-warn-primary) 6%, transparent); } }",
			/* ---- lists & cards ---- */
			".am-list { display: flex; flex-direction: column; gap: 10px; overflow-y: auto; min-height: 0; padding-right: 2px; }",
			".am-card { display: flex; flex-direction: column; gap: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); border-radius: 12px; padding: 12px 14px; transition: border-color .14s ease; }",
			".am-card:hover { border-color: var(--dsw-alias-border-l2); }",
			".am-card-head { display: flex; align-items: center; gap: 8px; flex-wrap: nowrap; min-width: 0; }",
			".am-card-name { font-weight: 600; font-size: 13px; }",
			".am-card-body { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.55; display: flex; flex-direction: column; gap: 4px; min-width: 0; }",
			".am-card-head .am-card-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
			".am-card-actions { display: flex; align-items: center; gap: 8px; flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; }",
			".am-card-actions::-webkit-scrollbar { display: none; }",
			".am-card-actions .am-btn { flex: none; }",
			".am-more { position: relative; flex: none; }",
			".am-more-menu { position: absolute; top: calc(100% + 6px); right: 0; z-index: 80; min-width: 148px; background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; box-shadow: 0 16px 44px rgba(0,0,0,.28); padding: 5px; display: flex; flex-direction: column; gap: 2px; animation: am-fade-in .1s ease; }",
			".am-more-item { display: flex; align-items: center; gap: 8px; width: 100%; border: 0; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 12.5px; text-align: left; padding: 7px 9px; border-radius: 6px; cursor: pointer; white-space: nowrap; }",
			".am-more-item:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }",
			".am-more-item:disabled { opacity: .45; cursor: default; }",
			".am-more-item[data-variant='danger'] { color: var(--dsw-alias-state-error-primary); }",
			".am-more-item .am-more-desc { color: var(--dsw-alias-label-secondary); font-size: 11px; margin-left: auto; padding-left: 12px; }",
			/* ---- host plugin detail page: hide our rows' technical id tags ----
			 * The manager page renders the row title (our locale meta.title) plus
			 * <code> tags for the entry id and module specifier. Ours duplicate
			 * the Chinese title, so hide them for our rows only; other plugins'
			 * rows keep theirs. Attribute specificity (0,2,0) beats the page's
			 * single-class rule regardless of <style> order. */
			"li[data-plugin-row$=agents-manager-capabilities] code, li[data-plugin-row$=agents-manager-subagents] code, li[data-plugin-row$=agents-manager-retry] code, li[data-plugin-row$=agents-manager-processes] code { display: none; }",
			".am-error { color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 1.5; word-break: break-word; }",
			".am-hint { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.55; }",
			".am-tools { border-top: 1px solid var(--dsw-alias-border-l1); padding-top: 8px; display: flex; flex-direction: column; gap: 4px; }",
			".am-tool-row { display: flex; gap: 8px; align-items: baseline; font-size: 12px; }",
			".am-tool-name { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; color: var(--dsw-alias-label-primary); word-break: break-all; }",
			".am-tool-desc { color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
			".am-regex { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; color: var(--dsw-alias-label-secondary); background: color-mix(in srgb, var(--dsw-alias-bg-base) 60%, transparent); border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; padding: 3px 8px; width: fit-content; max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }",
			/* ---- modal ---- */
			".am-modal-backdrop { position: fixed; inset: 0; background: color-mix(in srgb, var(--dsw-alias-bg-base) 50%, transparent); -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px); display: flex; align-items: center; justify-content: center; z-index: 60; padding: 24px; animation: am-fade-in .15s ease; }",
			".am-modal { background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-overlay)); border: 1px solid var(--dsw-alias-border-l2); border-radius: 14px; box-shadow: 0 24px 64px rgba(0,0,0,.32), 0 4px 16px rgba(0,0,0,.14); max-width: 560px; width: 100%; max-height: min(82vh, 680px); display: flex; flex-direction: column; animation: am-modal-in .18s cubic-bezier(.2,.8,.3,1); }",
			".am-modal[data-size='wide'] { max-width: 680px; }",
			".am-modal-head { display: flex; align-items: center; gap: 10px; padding: 14px 18px; border-bottom: 1px solid var(--dsw-alias-border-l1); }",
			".am-modal-title { flex: 1; min-width: 0; font-weight: 600; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
			".am-modal-x { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 1; cursor: pointer; }",
			".am-modal-x:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }",
			".am-modal-x:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); }",
			".am-modal-body { padding: 16px 18px; display: flex; flex-direction: column; gap: 14px; overflow-y: auto; }",
			".am-modal-foot { display: flex; justify-content: flex-end; align-items: center; gap: 8px; padding: 12px 18px; border-top: 1px solid var(--dsw-alias-border-l1); }",
			/* ---- forms ---- */
			".am-form { display: flex; flex-direction: column; gap: 12px; }",
			".am-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }",
			".am-label { font-size: 12px; font-weight: 500; color: var(--dsw-alias-label-secondary); }",
			".am-label-wrap { position: relative; display: inline-flex; align-items: baseline; gap: 4px; cursor: help; }",
			".am-label-mark { color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font-size: 10px; line-height: 1; }",
			".am-label-wrap:hover .am-label-mark, .am-label-wrap:focus-within .am-label-mark { color: var(--dsw-alias-brand-primary); }",
			".am-label-help { display: none; position: absolute; left: 0; top: calc(100% + 6px); z-index: 40; width: max-content; max-width: min(420px, 52vw); padding: 8px 10px; font-size: 11.5px; line-height: 1.6; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-overlay)); border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; box-shadow: 0 12px 32px rgba(0,0,0,.22); white-space: normal; pointer-events: none; }",
			".am-label-wrap:hover .am-label-help, .am-label-wrap:focus-within .am-label-help { display: block; animation: am-fade-in .12s ease; }",
			".am-label-help code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10.5px; background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); border-radius: 4px; padding: 0 4px; }",
			".am-group { display: flex; flex-direction: column; gap: 12px; }",
			".am-group-title { display: flex; align-items: center; gap: 10px; margin-top: 2px; font-size: 11.5px; font-weight: 600; letter-spacing: .3px; color: var(--dsw-alias-label-secondary); }",
			".am-group-title::after { content: \"\"; flex: 1; height: 1px; background: var(--dsw-alias-border-l1); }",
			".am-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px 12px; align-items: start; }",
			".am-row > .am-field { min-width: 0; }",
			".am-row > .am-input, .am-row > .am-select2, .am-row > .am-check { min-width: 0; }",
			".am-input, .am-select, .am-textarea { box-sizing: border-box; width: 100%; height: 32px; padding: 5px 10px; font-size: 13px; line-height: 20px; font-family: inherit; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm, 7px); transition: border-color .12s ease, box-shadow .12s ease; }",
			".am-input::placeholder, .am-textarea::placeholder { color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }",
			".am-input:hover:not(:disabled), .am-select:hover:not(:disabled), .am-textarea:hover:not(:disabled) { border-color: var(--dsw-alias-border-l3, var(--dsw-alias-border-l2)); }",
			".am-input:disabled, .am-select:disabled, .am-textarea:disabled { opacity: .55; cursor: default; }",
			".am-textarea { height: auto; min-height: 96px; padding: 8px 10px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.6; border-radius: 8px; }",
			".am-input:focus, .am-select:focus, .am-textarea:focus { outline: none; border-color: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)) 25%, transparent); }",
			".am-input[data-size='s'] { width: 150px; flex: none; }",
			".am-select { appearance: none; -webkit-appearance: none; padding-right: 28px; cursor: pointer; background-image: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%238a8f99' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\"); background-repeat: no-repeat; background-position: right 10px center; }",
			"body[data-ds-dark-theme] .am-select { background-image: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23a6abb5' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\"); }",
			/* ---- custom dropdown (AmSelect) ---- */
			".am-select2 { position: relative; min-width: 0; }",
			".am-select2-btn { display: flex; align-items: center; gap: 6px; width: 100%; height: 32px; padding: 5px 10px; font: inherit; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm, 7px); cursor: pointer; text-align: left; box-sizing: border-box; transition: border-color .12s ease, box-shadow .12s ease; }",
			".am-select2-btn:hover:not(:disabled) { border-color: var(--dsw-alias-border-l3, var(--dsw-alias-border-l2)); }",
			".am-select2-btn:disabled { opacity: .55; cursor: default; }",
			".am-select2-btn:focus-visible, .am-select2-btn[data-open='true'] { outline: none; border-color: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)) 25%, transparent); }",
			".am-select2-value { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
			".am-select2-value[data-empty='true'] { color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }",
			".am-select2-chevron { flex: none; width: 10px; height: 6px; background: center / contain no-repeat url(data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%238a8f99' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E); }",
			"body[data-ds-dark-theme] .am-select2-chevron { background-image: url(data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23a6abb5' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E); }",
			".am-select2-menu { position: absolute; top: calc(100% + 6px); left: 0; right: 0; z-index: 80; max-height: 240px; overflow-y: auto; background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; box-shadow: 0 16px 44px rgba(0,0,0,.28); padding: 5px; display: flex; flex-direction: column; gap: 2px; animation: am-fade-in .1s ease; }",
			".am-select2-option { display: flex; align-items: center; gap: 8px; width: 100%; border: 0; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 12.5px; text-align: left; padding: 7px 9px; border-radius: 6px; cursor: pointer; }",
			".am-select2-option:hover { background: var(--dsw-alias-interactive-bg-hover); }",
			".am-select2-option[data-selected='true'] { color: var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 9%, transparent); }",
			".am-select2-option-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
			".am-select2-option-desc { color: var(--dsw-alias-label-secondary); font-size: 11px; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
			".am-select2-check { flex: none; color: var(--dsw-alias-brand-primary); font-size: 11px; }",
			/* ---- kv editors ---- */
			".am-kv { display: flex; flex-direction: column; gap: 8px; }",
			".am-kv-row { display: flex; gap: 8px; }",
			".am-kv-row .am-input { flex: 1; }",
			".am-kv-row .am-select { flex: 1; }",
			".am-kv-row .am-select2 { flex: 1; min-width: 0; }",
			".am-kv-row > .am-btn { flex: none; }",
			".am-kv-del { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; padding: 0; border: 1px solid var(--dsw-alias-border-l1); background: transparent; color: var(--dsw-alias-label-secondary); border-radius: 7px; cursor: pointer; font: inherit; font-size: 12px; flex: none; transition: color .12s ease, border-color .12s ease; }",
			".am-kv-del:hover:not(:disabled) { color: var(--dsw-alias-state-error-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent); }",
			".am-kv-del:disabled { opacity: .4; cursor: default; }",
			".am-kv-del:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); }",
			".am-check { display: flex; align-items: center; gap: 8px; font-size: 12.5px; cursor: pointer; }",
			".am-check input[type='checkbox'] { accent-color: var(--dsw-alias-brand-primary); width: 15px; height: 15px; flex: none; margin: 0; }",
			".am-check input[type='checkbox']:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); }",
			/* ---- card switch (enable/disable without opening the editor) ---- */
			".am-switch { position: relative; display: inline-flex; align-items: center; width: 34px; height: 19px; flex: none; margin: 0; padding: 0; border: 1px solid var(--dsw-alias-border-l2); border-radius: 999px; background: color-mix(in srgb, var(--dsw-alias-label-secondary) 18%, transparent); cursor: pointer; transition: background-color .14s ease, border-color .14s ease; }",
			".am-switch:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary); }",
			".am-switch:disabled { opacity: .5; cursor: default; }",
			".am-switch[data-on='true'] { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }",
			".am-switch::after { content: \"\"; position: absolute; top: 1px; left: 1px; width: 15px; height: 15px; border-radius: 50%; background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-base))); box-shadow: 0 1px 3px rgba(0,0,0,.3); transition: transform .16s cubic-bezier(.2,.8,.3,1); }",
			".am-switch[data-on='true']::after { transform: translateX(15px); }",
			".am-switch:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); }",
			/* ---- small inline spinner (loading dots, switch busy state) ---- */
			".am-spin { display: inline-block; width: 12px; height: 12px; flex: none; border: 2px solid color-mix(in srgb, currentColor 30%, transparent); border-top-color: currentColor; border-radius: 50%; animation: am-spin .7s linear infinite; }",
			".am-switch[data-loading='true'] { opacity: 1; pointer-events: none; }",
			".am-switch[data-loading='true']::after { display: none; }",
			".am-switch .am-spin { position: absolute; top: 50%; left: 50%; width: 11px; height: 11px; margin: -5.5px 0 0 -5.5px; color: var(--dsw-alias-brand-primary); border-width: 2px; }",
			/* ---- nested editor cards ---- */
			".am-model-card { display: flex; flex-direction: column; gap: 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 10px 12px; background: color-mix(in srgb, var(--dsw-alias-bg-base) 55%, var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-overlay))); }",
			".am-model-head { display: flex; align-items: center; gap: 6px; }",
			".am-model-head .am-select2 { flex: 1; min-width: 0; }",
			".am-model-index { flex: none; display: inline-flex; align-items: center; justify-content: center; min-width: 20px; height: 20px; padding: 0 4px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10.5px; }",
			".am-tester { display: flex; flex-direction: column; gap: 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 12px; background: color-mix(in srgb, var(--dsw-alias-bg-base) 50%, transparent); }",
			".am-import-entry { display: flex; align-items: flex-start; gap: 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 8px 10px; }",
			/* ---- empty states ---- */
			".am-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 36px 20px; border: 1px dashed var(--dsw-alias-border-l2); border-radius: 12px; text-align: center; }",
			".am-empty-glyph { display: flex; align-items: center; justify-content: center; width: 40px; height: 40px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 50%; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); font-size: 17px; }",
			".am-empty-text { max-width: 440px; color: var(--dsw-alias-label-secondary); font-size: 12.5px; line-height: 1.65; }",
			".am-empty-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }",
			/* ---- skills split / tree / editor ---- */
			".am-split { display: flex; gap: 12px; flex: 1; min-height: 0; position: relative; }",
			".am-skills-wrap { position: relative; flex: none; height: 100%; min-width: 0; }",
			".am-split[data-mode='browse'] .am-skills-wrap { flex: 1 1 auto; }",
			".am-skills-list { display: flex; flex-direction: column; gap: 8px; overflow-y: auto; }",
			".am-split[data-mode='browse'] .am-skills-list { height: 100%; padding-right: 4px; }",
			".am-split[data-mode='edit'] .am-skills-wrap { width: 30px; }",
			".am-split[data-mode='edit'] .am-skills-list { position: absolute; left: 0; top: 0; bottom: 0; width: 22px; padding: 0; overflow: hidden; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; z-index: 6; transition: width .16s ease, border-color .16s ease, box-shadow .16s ease; }",
			".am-split[data-mode='edit'] .am-skills-list:hover { width: 300px; border-color: var(--dsw-alias-border-l2); box-shadow: 0 10px 30px rgba(0,0,0,.22); }",
			".am-tree-handle { position: absolute; left: 0; top: 0; bottom: 0; width: 22px; border: 0; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 12px; padding: 0; }",
			".am-tree-handle:hover { color: var(--dsw-alias-label-primary); }",
			".am-tree-panel { height: 100%; overflow-y: auto; overflow-x: hidden; padding: 8px 8px 8px 28px; display: flex; flex-direction: column; gap: 6px; }",
			".am-split[data-mode='edit'] .am-skill-desc, .am-split[data-mode='edit'] .am-skill-badge { display: none; }",
			".am-split[data-mode='edit'] .am-skills-list:hover .am-skill-desc { display: block; }",
			".am-split[data-mode='edit'] .am-skills-list:hover .am-skill-badge { display: inline-flex; }",
			".am-skill-row { display: flex; flex-direction: column; gap: 2px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); border-radius: 10px; padding: 10px 12px; cursor: pointer; text-align: left; transition: border-color .14s ease; }",
			".am-skill-row:hover { border-color: var(--dsw-alias-border-l2); }",
			".am-skill-row[data-active='true'] { border-color: var(--dsw-alias-brand-primary); }",
			".am-skill-top { display: flex; align-items: center; gap: 6px; }",
			".am-skill-name { font-weight: 600; font-size: 12.5px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
			".am-skill-desc { color: var(--dsw-alias-label-secondary); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
			".am-skill-badge { display: inline-flex; align-self: flex-start; margin-top: 2px; }",
			".am-tree-children { display: flex; flex-direction: column; gap: 1px; padding: 1px 0 4px 0; }",
			".am-tree-twist { color: var(--dsw-alias-label-secondary); flex: none; font-size: 9px; display: inline-block; width: 9px; }",
			".am-tree-dir { display: flex; align-items: center; gap: 3px; width: 100%; text-align: left; background: transparent; border: 0; color: var(--dsw-alias-label-primary); font: inherit; font-size: 11px; font-weight: 600; padding: 4px 6px; border-radius: 5px; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
			".am-tree-dir:hover { background: var(--dsw-alias-interactive-bg-hover); }",
			".am-tree-file { display: block; width: 100%; text-align: left; background: transparent; border: 0; color: var(--dsw-alias-label-secondary); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; padding: 3px 6px; border-radius: 5px; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
			".am-tree-file:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }",
			".am-tree-file[data-active='true'] { color: var(--dsw-alias-brand-primary); }",
			".am-float-bar { position: absolute; right: 14px; bottom: 14px; z-index: 8; display: flex; align-items: center; gap: 8px; background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-overlay)); border: 1px solid var(--dsw-alias-border-l2); border-radius: 999px; padding: 5px 8px 5px 12px; box-shadow: 0 8px 24px rgba(0,0,0,.2); }",
			".am-md { flex: 1; min-height: 0; overflow-y: auto; padding: 14px 18px; font-size: var(--dsh-content-font-size-secondary, 13px); line-height: 1.7; color: var(--dsw-alias-label-primary); }",
			".am-md-p { margin: 0 0 10px; }",
			".am-md-h { margin: 14px 0 8px; font-weight: 600; line-height: 1.4; }",
			".am-md-h:first-child { margin-top: 2px; }",
			".am-md-pre { margin: 0 0 10px; padding: 10px 12px; background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.55; overflow-x: auto; white-space: pre; }",
			".am-md-code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); border-radius: 4px; padding: 0 5px; }",
			".am-md-list { margin: 0 0 10px; padding-left: 22px; }",
			".am-md-quote { margin: 0 0 10px; padding: 2px 0 2px 12px; border-left: 3px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); }",
			".am-md-hr { border: 0; border-top: 1px solid var(--dsw-alias-border-l1); margin: 12px 0; }",
			".am-md a { color: var(--dsw-alias-brand-primary); }",
			".am-editor-pane { flex: 1; min-width: 0; display: flex; flex-direction: column; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); overflow: hidden; }",
			".am-editor-head { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); flex: none; }",
			".am-editor-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }",
			".am-editor { flex: 1; min-height: 0; border: 0; border-radius: 0; resize: none; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; line-height: 1.55; padding: 12px 14px; box-sizing: border-box; width: 100%; }",
			".am-editor:focus { outline: none; }",
			".am-editor[data-readonly='true'] { opacity: .6; }",
			".am-dirty-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-state-warn-primary); flex: none; }",
			/* ---- composer chip & popover ---- */
			".am-chip-wrap { position: relative; display: inline-flex; min-width: 0; }",
			".am-chip { display: inline-flex; align-items: center; gap: 4px; height: 28px; border: .5px solid var(--dsw-alias-border-l3, var(--dsw-alias-border-l2)); background: var(--dsw-alias-button-floating-fill, var(--dsw-alias-bg-layer-1)); color: var(--dsw-alias-label-secondary); border-radius: var(--dsw-radius-sm, 6px); padding: 0 8px; font-size: 12px; line-height: 18px; cursor: pointer; white-space: nowrap; font-variant-numeric: tabular-nums; min-width: 0; max-width: min(280px, 45cqw); overflow: hidden; }",
			".am-chip:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }",
			".am-chip[data-open='true'] { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }",
			".am-chip:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); }",
			".am-chip:disabled { opacity: .6; cursor: default; }",
			".am-pop { position: absolute; bottom: calc(100% + 8px); left: 0; z-index: 70; width: min(340px, calc(100vw - 24px)); max-height: min(420px, 60vh); overflow-y: auto; overflow-x: hidden; background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-overlay)); border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; box-shadow: 0 12px 36px rgba(0,0,0,.25); padding: 10px 10px; display: flex; flex-direction: column; gap: 6px; color: var(--dsw-alias-label-primary); font-size: var(--dsh-content-font-size-secondary, 13px); }",
			"@media (max-width: 480px) { .am-pop { padding: 8px; } .am-pop-row-name { max-width: 40%; } .am-pop-hoverdesc { max-height: 48px; } }",
			".am-pop-filter { margin: 0 2px 2px; }",
			".am-pop-title { font-weight: 600; font-size: var(--dsh-content-font-size-secondary, 13px); }",
			".am-pop-group { display: flex; flex-direction: column; gap: 1px; }",
			".am-pop-group-title { color: var(--dsw-alias-label-secondary); font-size: 11.5px; margin: 4px 8px 3px; }",
			".am-pop-row { display: flex; align-items: center; gap: 8px; padding: 4px 8px; border-radius: var(--dsw-radius-md, 6px); cursor: pointer; min-width: 0; }",
			".am-pop-row:hover { background: var(--dsw-alias-interactive-bg-hover); }",
			".am-pop-row input[type='checkbox'] { accent-color: var(--dsw-alias-brand-primary); flex: none; }",
			".am-pop-row-name { color: var(--dsw-alias-label-primary); flex: none; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
			".am-pop-desc { color: var(--dsw-alias-label-secondary); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
			".am-pop-actions { display: flex; gap: 6px; align-items: center; padding: 0 2px; }",
			".am-pop-hint { color: var(--dsw-alias-label-secondary); font-size: 11px; border-top: 1px dashed var(--dsw-alias-border-l1); padding: 6px 8px 2px; }",
			".am-pop-top-hint { color: var(--dsw-alias-label-secondary); font-size: 11px; padding: 0 4px 0 4px; }",
			".am-pop-hoverdesc { display: flex; gap: 8px; align-items: baseline; border-top: 1px dashed var(--dsw-alias-border-l1); padding: 6px 8px 2px; color: var(--dsw-alias-label-secondary); font-size: 11.5px; line-height: 1.5; max-height: 64px; overflow: hidden; }",
			/* ---- toasts ---- */
			".am-toasts { position: fixed; right: 18px; bottom: 18px; z-index: 90; display: flex; flex-direction: column; gap: 8px; width: 340px; max-width: calc(100vw - 36px); }",
			".am-toast { display: flex; flex-direction: column; gap: 6px; background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-state-error-primary); border-radius: 12px; padding: 10px 12px; box-shadow: 0 10px 30px rgba(0,0,0,.3); font-size: 12.5px; color: var(--dsw-alias-label-primary); animation: am-toast-in .18s ease; }",
			".am-toast-title { display: flex; align-items: center; gap: 8px; font-weight: 600; }",
			".am-toast-detail { color: var(--dsw-alias-label-secondary); font-size: 11.5px; word-break: break-word; white-space: pre-wrap; }",
			".am-toast-actions { display: flex; gap: 8px; justify-content: flex-end; }",
			/* ---- session process panel ---- */
			".am-proc-pill { position: fixed; top: 110px; right: 18px; z-index: 90; box-shadow: 0 8px 24px rgba(0,0,0,.2); }",
			".am-procview { box-sizing: border-box; width: 100%; height: 100%; min-height: 0; display: flex; flex-direction: column; overflow: hidden; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1); font-size: 12.5px; }",
			".am-procview-head { flex: none; display: flex; align-items: center; gap: 8px; padding: 8px 18px; border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }",
			".am-procview-scroll { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: var(--dsw-alias-border-l3) transparent; padding: 18px 18px 32px; }",
			".am-procview-scroll::-webkit-scrollbar { width: 6px; }",
			".am-procview-scroll::-webkit-scrollbar-track { background: transparent; }",
			".am-procview-scroll::-webkit-scrollbar-thumb { background: var(--dsw-alias-border-l3); border-radius: 3px; }",
			".am-procview-inner { display: flex; flex-direction: column; gap: 10px; max-width: 1080px; margin: 0 auto; }",
			".am-procview .am-proc-head { padding: 0; background: transparent; border-bottom: 0; }",
			".am-proc-table { display: flex; flex-direction: column; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-base))); padding: 6px 14px 10px; overflow: hidden; }",
			".am-proc-head { display: flex; align-items: center; gap: 8px; flex: none; }",
			".am-procview .am-proc-title { font-size: 13px; }",
			".am-proc-title { font-weight: 600; }",
			".am-proc-list { display: flex; flex-direction: column; gap: 2px; }",
			".am-proc-item { min-width: 0; }",
			".am-proc-item { padding: 7px 8px; border-radius: 8px; min-width: 0; }",
			".am-proc-item + .am-proc-item { border-top: 1px solid var(--dsw-alias-border-l1); }",
			".am-proc-row, .am-proc-headrow { display: grid; grid-template-columns: minmax(0, 1.7fr) 72px 64px minmax(0, 1fr) 28px; gap: 10px; align-items: center; min-width: 0; }",
			".am-proc-row > *, .am-proc-headrow > * { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
			".am-proc-row > .am-proc-stop { overflow: visible; justify-self: end; flex: none; }",
			".am-proc-cellname { display: flex; align-items: center; gap: 5px; min-width: 0; }",
			".am-proc-cellname .am-proc-name { flex: 0 1 auto; }",
			".am-proc-headrow { color: var(--dsw-alias-label-tertiary); font-size: 10.5px; text-transform: uppercase; letter-spacing: .04em; padding: 6px 8px 7px; margin: 0 -6px; border-bottom: 1px solid var(--dsw-alias-border-l1); flex: none; }",
			".am-proc-headrow > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
			".am-proc-name { color: var(--dsw-alias-label-primary); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: default; }",
			".am-proc-msg { color: var(--dsw-alias-label-secondary); font-size: 11.5px; word-break: break-word; }",
			".am-proc-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 64px 20px; border: 1px dashed var(--dsw-alias-border-l2); border-radius: 12px; color: var(--dsw-alias-label-secondary); }",
			".am-proc-empty-glyph { font-size: 26px; line-height: 1; opacity: .5; }",
			".am-proc-ports { font-variant-numeric: tabular-nums; }",
			".am-proc-row .am-badge { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }",
			".am-proc-list { max-height: 200px; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: var(--dsw-alias-border-l3) transparent; }",
			".am-proc-list::-webkit-scrollbar { width: 5px; }",
			".am-proc-list::-webkit-scrollbar-track { background: transparent; }",
			".am-proc-list::-webkit-scrollbar-thumb { background: var(--dsw-alias-border-l3); border-radius: 3px; }",
			".am-proc-list::-webkit-scrollbar-thumb:hover { background: var(--dsw-alias-label-tertiary); }",
			".am-proc-cmd { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary); font-size: 11px; cursor: default; }",
			// The hover card lives OUTSIDE the scrolling list (position:fixed, driven
			// by JS on row mouseenter): an absolutely-positioned card inside the
			// scroll container was clipped by it, nudged the scroll extent (jitter
			// loop: hover -> card grows scroll area -> row shifts -> hover lost),
			// and overlapped the data columns.
			".am-proc-info { position: fixed; z-index: 99; max-width: 380px; padding: 8px 10px; background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.28); font-size: 11.5px; line-height: 1.55; color: var(--dsw-alias-label-primary); white-space: pre-wrap; word-break: break-all; pointer-events: none; }",
			".am-proc-stop { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0; border: 1px solid var(--dsw-alias-state-error-primary); border-radius: 6px; background: transparent; color: var(--dsw-alias-state-error-primary); font-size: 11px; line-height: 1; cursor: pointer; }",
			".am-proc-stop:hover:not([aria-disabled='true']) { background: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-bg-overlay); }",
			".am-proc-stop[aria-disabled='true'] { opacity: .35; cursor: not-allowed; }",
			/* ---- motion ---- */
			"@keyframes am-fade-in { from { opacity: 0; } to { opacity: 1; } }",
			"@keyframes am-spin { to { transform: rotate(360deg); } }",
			"@keyframes am-modal-in { from { opacity: 0; transform: translateY(8px) scale(.985); } to { opacity: 1; transform: none; } }",
			"@keyframes am-toast-in { from { transform: translateY(6px); opacity: 0; } to { transform: none; opacity: 1; } }",
			"@media (prefers-reduced-motion: reduce) { .am-split[data-mode='edit'] .am-skills-list { transition: none; } .am-toast, .am-modal, .am-modal-backdrop, .am-label-help, .am-select2-menu { animation: none; } .am-spin, .am-dot[data-pulse='true'] { animation: none; } }"
		].join("\n");

		/** Cheap stable hash so the style-tag id changes with the CSS content. */
		function cssTagId() {
			var hash = 5381;
			for (var i = 0; i < CSS.length; i++) hash = ((hash << 5) + hash + CSS.charCodeAt(i)) >>> 0;
			return NS + "/styles.css?v=" + hash.toString(36);
		}

		/**
		 * Insert this plugin's stylesheet. The tag id carries a content hash, and
		 * any older tag of ours is removed first, so a stale stylesheet from an
		 * earlier plugin generation can never suppress the current rules.
		 */
		function injectStyle() {
			if (typeof document === "undefined") return;
			var tagId = cssTagId();
			document.querySelectorAll('style[data-plugin="' + NS + '"]').forEach(function (tag) {
				if (tag.getAttribute("data-plugin-css") !== tagId) tag.remove();
			});
			if (document.querySelector('style[data-plugin-css="' + tagId + '"]') === null) {
				var tag = document.createElement("style");
				tag.dataset.plugin = NS;
				tag.setAttribute("data-plugin-css", tagId);
				tag.textContent = CSS;
				document.head.appendChild(tag);
			}
		}

		// ---------------------------------------------------------------------------
		// HTTP client
		// ---------------------------------------------------------------------------

		/**
		 * One JSON round-trip. Always resolves to {status, ok, body}; transport
		 * failures reject with an Error carrying network:true.
		 */
		function requestJson(path, init) {
			var options = init === undefined ? {} : init;
			var pending;
			try {
				pending = typeof fetch === "function" ? fetch(API_BASE + path, options) : Promise.reject(new Error("fetch-unavailable"));
			} catch (error) {
				pending = Promise.reject(error);
			}
			return pending.then(function (response) {
				return response.text().then(function (text) {
					var body = null;
					try {
						body = text === "" ? null : JSON.parse(text);
					} catch (error) {
						body = null;
					}
					return { status: response.status, ok: response.ok === true && body !== null, body: body };
				});
			}, function (error) {
				var wrapped = new Error(error !== null && error !== undefined && error.message !== undefined ? String(error.message) : "network-error");
				wrapped.network = true;
				throw wrapped;
			});
		}

		/** POST helper with a JSON body. */
		function postJson(path, body) {
			return requestJson(path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body === undefined ? {} : body)
			});
		}

		var api = {
			state: function () { return requestJson("/state"); },
			agentsFile: function () { return requestJson("/mcp/agents-file"); },
			agentSources: function () { return requestJson("/mcp/agent-sources"); },
			importPreview: function (text, test) { return postJson("/mcp/import", { text: text, test: test === true }); },
			importCommit: function (entries) { return postJson("/mcp/import/commit", { entries: entries }); },
			saveServer: function (name, server) { return postJson("/mcp/save", { name: name, server: server }); },
			deleteServer: function (name) { return postJson("/mcp/delete", { name: name }); },
			toggleServer: function (name, enabled) { return postJson("/mcp/toggle", { name: name, enabled: enabled === true }); },
			testServer: function (name) { return postJson("/mcp/test", name === undefined ? {} : { name: name }); },
			callServerTool: function (name, tool, args) { return postJson("/mcp/call", { name: name, tool: tool, args: args === undefined ? {} : args }); },
			skillFiles: function (skill) { return postJson("/skills/files", { skill: skill }); },
			installGithub: function (source) { return postJson("/skills/install-github", { source: source }); },
			readSkillFile: function (skill, path) { return postJson("/skills/file/read", { skill: skill, path: path }); },
			writeSkillFile: function (skill, path, content, sha) { return postJson("/skills/file/write", { skill: skill, path: path, content: content, sha: sha }); },
			getSelection: function (sessionId) { return requestJson("/session/selection?id=" + encodeURIComponent(sessionId)); },
			setSelection: function (sessionId, selection) { return postJson("/session/selection", Object.assign({ sessionId: sessionId }, selection)); },
			sessionFresh: function (sessionId) { return requestJson("/session/fresh?id=" + encodeURIComponent(sessionId)); },
			sessionProcesses: function (sessionId) { return requestJson("/session/processes?id=" + encodeURIComponent(sessionId)); },
			stopProcess: function (sessionId, name) { return postJson("/session/processes/stop", { sessionId: sessionId, name: name }); },
			subagents: function () { return requestJson("/subagents"); },
			saveRole: function (name, role) { return postJson("/subagents/save", { name: name, role: role }); },
			deleteRole: function (name) { return postJson("/subagents/delete", { name: name }); },
			restoreRole: function (name) { return postJson("/subagents/restore", { name: name }); },
			savePoolModel: function (entry) { return postJson("/subagents/models/save", { entry: entry }); },
			bulkPoolModels: function (entries) { return postJson("/subagents/models/bulk", { entries: entries }); },
			deletePoolModel: function (key) { return postJson("/subagents/models/delete", { key: key }); },
			llmCatalog: function () { return requestJson("/subagents/catalog"); },
			retryState: function () { return requestJson("/retry/state"); },
			saveRetryRules: function (rules, replace, fallback) {
				var body = { rules: rules === undefined ? [] : rules, replace: replace === true };
				if (fallback !== undefined && fallback !== null) body.fallback = fallback;
				return postJson("/retry/rules", body);
			},
			testRetryRule: function (rule, text) { return postJson("/retry/rules/test", { rule: rule, text: text }); },
			saveRetryPolicy: function (provider, policy) { return postJson("/retry/policy", { provider: provider, policy: policy }); },
			resetRetryPolicy: function (provider) { return postJson("/retry/reset", { provider: provider }); }
		};

		// ---------------------------------------------------------------------------
		// Active session tracking
		// ---------------------------------------------------------------------------

		/**
		 * The session id currently owning the composer, published by the
		 * ActiveSessionProbe the composer seat mounts. The shell-overlay
		 * process panel reads it so each conversation shows only its own
		 * service processes. Last-mounted probe wins: the shell renders one
		 * conversation at a time, so the surviving probe is the visible one.
		 */
		var activeSession = (function () {
			var currentId = "";
			var listeners = [];
			function notify() {
				for (var i = 0; i < listeners.length; i++) {
					try { listeners[i](); } catch (error) { /* a broken listener never blocks the rest */ }
				}
			}
			return {
				get: function () { return currentId; },
				set: function (id) {
					var next = String(id === undefined || id === null ? "" : id);
					if (next === currentId) return;
					currentId = next;
					notify();
				},
				subscribe: function (fn) {
					listeners.push(fn);
					return function () {
						var at = listeners.indexOf(fn);
						if (at >= 0) listeners.splice(at, 1);
					};
				}
			};
		})();

		/**
		 * Null-rendering probe mounted with the composer seat: publishes the
		 * visible session's id and clears it again when that session's
		 * composer unmounts.
		 */
		function ActiveSessionProbe(props) {
			var sessionId = String(props.sessionId === undefined || props.sessionId === null ? "" : props.sessionId);
			useEffect(function () {
				activeSession.set(sessionId);
				return function () {
					if (activeSession.get() === sessionId) activeSession.set("");
				};
			}, [sessionId]);
			return null;
		}

		// ---------------------------------------------------------------------------
		// Small shared pieces
		// ---------------------------------------------------------------------------

		/** Simple {placeholder} interpolation over a dictionary string. */
		function format(template, values) {
			return String(template).replace(/\{(\w+)\}/g, function (all, key) {
				return values !== undefined && values[key] !== undefined ? String(values[key]) : all;
			});
		}

		/** Mask a secret-looking value for list display. */
		function maskValue(value) {
			return typeof value === "string" && value !== "" ? "••••••" : value;
		}

		/** Server card status tone from config + pool state. */
		function serverStatus(server, poolEntry) {
			if (server === undefined) return { tone: "idle", key: "unknown" };
			if (server.enabled === false) return { tone: "idle", key: "off" };
			if (poolEntry === undefined) return { tone: "idle", key: "unknown" };
			if (poolEntry.state === "connected") return { tone: "ok", key: "ok" };
			if (poolEntry.state === "failed") return { tone: "fail", key: "fail" };
			if (poolEntry.state === "connecting" || poolEntry.state === "closing") return { tone: "testing", key: "connecting" };
			if (poolEntry.state === "testing") return { tone: "testing", key: "testing" };
			return { tone: "idle", key: "unknown" };
		}

		/**
		 * Server card status: pool state first (a live connection is the most
		 * authoritative), then the last manual test outcome (the test connection
		 * is throwaway by design, so its result never enters the pool — surface
		 * it here instead), then the unknown fallback.
		 *
		 * @param {object | undefined} server - stored config record.
		 * @param {object | undefined} poolEntry - live pool entry from /state.
		 * @param {object | undefined} testResult - last manual test result.
		 * @param {boolean} testing - a manual test is running right now.
		 * @returns {{ tone: string, key: string }} badge tone + i18n key.
		 */
		function cardStatus(server, poolEntry, testResult, testing) {
			if (server === undefined) return { tone: "idle", key: "unknown" };
			if (server.enabled === false) return { tone: "idle", key: "off" };
			if (testing === true) return { tone: "testing", key: "testing" };
			var poolState = poolEntry !== undefined ? poolEntry.state : undefined;
			if (poolState === "connecting" || poolState === "closing") return { tone: "testing", key: "connecting" };
			if (poolState === "connected") return { tone: "ok", key: "ok" };
			if (poolState === "failed" && testResult === undefined) return { tone: "fail", key: "fail" };
			if (testResult !== undefined) return testResult.ok === true ? { tone: "ok", key: "ok" } : { tone: "fail", key: "fail" };
			if (poolState === "failed") return { tone: "fail", key: "fail" };
			return { tone: "idle", key: "unknown" };
		}

		/** kv-map (env/headers) ⇄ editable rows. */
		function mapToRows(map) {
			return Object.entries(map === undefined ? {} : map).map(function (entry) {
				return { key: entry[0], value: entry[1] };
			});
		}

		function rowsToMap(rows) {
			var out = {};
			rows.forEach(function (row) {
				if (row.key !== "") out[row.key] = row.value;
			});
			return out;
		}

		/**
		 * Custom dropdown matching the harness control language: bordered trigger
		 * (same geometry as .am-input), floating token-styled menu, hover + check
		 * states, Escape/click-outside close. Falls back to a plain text input
		 * when there are no options and custom entry is allowed.
		 */
		function AmSelect(props) {
			var value = typeof props.value === "string" ? props.value : "";
			var options = props.options || [];
			var open = useState(false);
			var setOpen = open[1]; open = open[0];
			var wrapRef = useRef(null);

			useEffect(function () {
				if (!open) return undefined;
				function onDown(event) {
					if (wrapRef.current !== null && wrapRef.current !== undefined && !wrapRef.current.contains(event.target)) setOpen(false);
				}
				function onKey(event) {
					if (event.key === "Escape") setOpen(false);
				}
				document.addEventListener("mousedown", onDown);
				document.addEventListener("keydown", onKey);
				return function () {
					document.removeEventListener("mousedown", onDown);
					document.removeEventListener("keydown", onKey);
				};
			}, [open]);

			if (options.length === 0 && props.allowCustom) {
				return h("input", {
					className: "am-input", placeholder: props.placeholder || "", value: value,
					onChange: function (event) { props.onChange(event.target.value); }
				});
			}

			var label = value;
			for (var i = 0; i < options.length; i++) {
				if (options[i].value === value) { label = options[i].label || value; break; }
			}

			return h("div", { className: "am-select2", ref: wrapRef },
				h("button", {
					type: "button", className: "am-select2-btn", "data-open": open,
					disabled: props.disabled === true, onClick: function () { setOpen(!open); }
				},
					h("span", { className: "am-select2-value", "data-empty": value === "" }, value === "" ? (props.placeholder || "") : label),
					h("span", { className: "am-select2-chevron", "aria-hidden": "true" })
				),
				open ? h("div", { className: "am-select2-menu" },
					options.length === 0 ? h("span", { className: "am-hint", style: { padding: "6px 8px" } }, "—") :
						options.map(function (option) {
							return h("button", {
								key: option.value, type: "button", className: "am-select2-option", "data-selected": option.value === value,
								onClick: function () { setOpen(false); props.onChange(option.value); }
							},
								h("span", { className: "am-select2-option-label", title: option.label || option.value }, option.label || option.value),
								option.desc ? h("span", { className: "am-select2-option-desc", title: option.desc }, option.desc) : null,
								option.value === value ? h("span", { className: "am-select2-check" }, "✓") : null
							);
						})
				) : null
			);
		}

	/**
	 * Modal shell: backdrop (click + Escape) closing, titled header with a
	 * dedicated close button, scrollable body, pinned footer. `size='wide'`
	 * widens the sheet for dense forms.
	 */
	function Modal(props) {
		useEffect(function () {
			var onKey = function (event) {
				if (event.key === "Escape") props.onClose();
			};
			document.addEventListener("keydown", onKey);
			return function () { document.removeEventListener("keydown", onKey); };
		}, []);
		return h("div", {
			className: "am-modal-backdrop",
			onMouseDown: function (event) { if (event.target === event.currentTarget) props.onClose(); }
		},
			h("div", { className: "am-modal", role: "dialog", "aria-label": props.title, "data-size": props.size },
				h("div", { className: "am-modal-head" },
					h("span", { className: "am-modal-title" }, props.title),
					h("button", { type: "button", className: "am-modal-x", "aria-label": "close", onClick: props.onClose }, "✕")
				),
				h("div", { className: "am-modal-body" }, props.children),
				props.footer === undefined || props.footer === null ? null : h("div", { className: "am-modal-foot" }, props.footer)
			)
		);
	}

	/**
	 * One labelled form field: the label row (optional ⓘ hover help reusing the
	 * theme-styled popup), the control(s) as children, optional inline hint.
	 */
	function Field(props) {
		return h("div", { className: "am-field" },
			h("label", { className: "am-label" },
				props.label,
				props.help === undefined ? null : h("span", { className: "am-label-wrap" },
					h("span", { className: "am-label-mark" }, "ⓘ"),
					h("span", { className: "am-label-help" }, props.help)
				)
			),
			props.children,
			props.hint === undefined ? null : h("p", { className: "am-hint", style: { margin: 0 } }, props.hint)
		);
	}

	/** Titled divider group inside a modal body (`.am-group`). */
	function Group(props) {
		return h("div", { className: "am-group" },
			props.title === undefined ? null : h("div", { className: "am-group-title" }, props.title),
			props.children
		);
	}

	/**
	 * Empty state block: glyph medallion, explanatory copy, optional CTA row —
	 * a guide forward instead of a dead-end sentence.
	 */
	function Empty(props) {
		return h("div", { className: "am-empty" },
			props.glyph === undefined ? null : h("span", { className: "am-empty-glyph", "aria-hidden": "true" }, props.glyph),
			h("p", { className: "am-empty-text", style: { margin: 0 } }, props.text),
			props.actions === undefined ? null : h("div", { className: "am-empty-actions" }, props.actions)
		);
	}

		// ---------------------------------------------------------------------------
		// MCP tab
		// ---------------------------------------------------------------------------

		/**
		 * One-click sync modal: lists every detected agent config (Claude Code,
		 * Codex, zcode, Cursor) with its importable servers; checked items are
		 * committed through the shared import path (same-name overwritten).
		 */
		function SyncModal(props) {
			var t = props.t;
			var sources = useState(null);
			var setSources = sources[1];
			sources = sources[0];
			var picked = useState({});
			var setPicked = picked[1];
			picked = picked[0];
			var busy = useState(true);
			var setBusy = busy[1];
			busy = busy[0];
			var error = useState("");
			var setError = error[1];
			error = error[0];
			/** Hover card payload: { top, left, text } or null. Fixed-positioned, so
			 *  it never touches the scroll container's layout. */
			var hoverInfo = useState(null);
			var setHoverInfo = hoverInfo[1];
			hoverInfo = hoverInfo[0];
			/** Which source tab is shown (by source id). */
			var activeTab = useState(null);
			var setActiveTab = activeTab[1];
			activeTab = activeTab[0];

			useEffect(function () {
				api.agentSources().then(function (response) {
					setBusy(false);
					if (response.status === 404) {
						setError(t("mcp.import.sync.needRestart"));
						return;
					}
					if (!response.ok) {
						setError((response.body && response.body.error) || String(response.status));
						return;
					}
					var initial = {};
					var seen = {};
					response.body.sources.forEach(function (source) {
						source.entries.forEach(function (entry) {
							// Cross-source dedupe: first source wins.
							if (entry.issue !== null || seen[entry.name] !== undefined) return;
							seen[entry.name] = true;
							initial[source.id + "/" + entry.name] = true;
						});
					});
					setPicked(initial);
					setSources(response.body.sources);
					// Open the first non-empty source's tab.
					var first = null;
					for (var i = 0; i < response.body.sources.length; i++) {
						if (response.body.sources[i].entries.length > 0) { first = response.body.sources[i].id; break; }
					}
					if (first !== null) setActiveTab(first);
				}, function (networkError) {
					setBusy(false);
					setError(networkError.message);
				});
			}, []);

			/** Every valid, unique entry across sources. */
			function flatEntries() {
				var out = [];
				var seen = {};
				(sources || []).forEach(function (source) {
					source.entries.forEach(function (entry) {
						if (entry.issue !== null || seen[entry.name] !== undefined) return;
						seen[entry.name] = true;
						out.push({ key: source.id + "/" + entry.name, source: source, entry: entry });
					});
				});
				return out;
			}

			/** The visible source (active tab), or null. */
			function activeSource() {
				for (var i = 0; i < (sources || []).length; i++) {
					if (sources[i].id === activeTab) return sources[i];
				}
				return null;
			}

			/** Valid, unique entries of one tab (names owned by earlier sources dedupe out). */
			function tabEntries(source) {
				var before = {};
				for (var i = 0; i < (sources || []).length; i++) {
					if (sources[i].id === source.id) break;
					sources[i].entries.forEach(function (entry) { before[entry.name] = true; });
				}
				var out = [];
				source.entries.forEach(function (entry) {
					if (entry.issue === null && before[entry.name] === undefined) out.push(entry);
				});
				return out;
			}

			/** Toggle every valid entry of the active tab. */
			function toggleTab(source, checked) {
				var next = Object.assign({}, picked);
				tabEntries(source).forEach(function (entry) {
					next[source.id + "/" + entry.name] = checked;
				});
				setPicked(next);
			}

			function commit() {
				var selected = flatEntries().filter(function (row) { return picked[row.key] === true; });
				if (selected.length === 0) {
					setError(t("mcp.import.nothing"));
					return;
				}
				setBusy(true);
				api.importCommit(selected.map(function (row) { return { name: row.entry.name, server: row.entry.server }; })).then(function (response) {
					setBusy(false);
					if (response.ok) props.onDone();
					else setError((response.body && response.body.error) || String(response.status));
				}, function (networkError) {
					setError(networkError.message);
					setBusy(false);
				});
			}

			var anySource = (sources || []).some(function (source) { return source.entries.length > 0; });
			var visible = activeSource();
			var visibleEntries = visible === null ? [] : tabEntries(visible);
			var visiblePicked = visibleEntries.filter(function (entry) { return picked[visible.id + "/" + entry.name] === true; }).length;

			return h(Modal, {
				title: t("mcp.import.sync.title"),
				onClose: props.onClose,
				footer: [
					h("button", { key: "commit", type: "button", className: "am-btn", "data-variant": "primary", disabled: busy || !anySource, onClick: commit }, t("mcp.import.save"))
				]
			},
				h("p", { className: "am-hint" }, t("mcp.import.sync.hint")),
				busy && sources === null ? h("p", { className: "am-hint" }, t("page.loading")) : null,
				error === "" ? null : h("p", { className: "am-error", role: "alert" }, error),
				sources === null || !anySource ? (sources === null ? null : h("p", { className: "am-hint" }, t("mcp.import.sync.none"))) :
					h("div", { style: { display: "flex", flexDirection: "column", gap: "10px", minHeight: 0 } },
						// Source tabs: one per detected agent, count badges included.
						h("div", { className: "am-tabs", style: { flexWrap: "wrap" } },
							sources.filter(function (source) { return source.entries.length > 0; }).map(function (source) {
								return h("button", {
									key: source.id, type: "button", className: "am-tab",
									"data-active": activeTab === source.id,
									onClick: function () { setActiveTab(source.id); }
								},
									source.label,
									h("span", { style: { opacity: .65, marginLeft: "5px", fontSize: "11px" } }, String(source.entries.length))
								);
							})
						),
						visible === null ? null : h("div", { style: { display: "flex", flexDirection: "column", gap: "6px", minHeight: 0 } },
							h("div", { className: "am-editor-actions", style: { padding: "2px 0", flexWrap: "wrap" } },
								h("span", { className: "am-pop-title" }, visible.label),
								h("span", { className: "am-badge" }, visiblePicked + "/" + visibleEntries.length),
								h("span", { className: "am-hint", style: { fontSize: "11px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 } }, visible.path),
								h("button", { type: "button", className: "am-btn", "data-size": "sm", onClick: function () { toggleTab(visible, true); } }, t("mcp.import.sync.all")),
								h("button", { type: "button", className: "am-btn", "data-size": "sm", onClick: function () { toggleTab(visible, false); } }, t("mcp.import.sync.noneSel"))
						),
							visible.entries.map(function (entry) {
								var key = visible.id + "/" + entry.name;
								var deduped = visibleEntries.indexOf(entry) < 0;
								return h("label", { key: key, className: "am-pop-row", style: deduped ? { opacity: .45 } : undefined },
									h("input", {
										type: "checkbox",
										disabled: entry.issue !== null || deduped,
										checked: picked[key] === true,
										onChange: function (event) {
											var next = Object.assign({}, picked);
											next[key] = event.target.checked;
											setPicked(next);
										}
									}),
									h("span", { className: "am-pop-row-name" }, entry.name),
									entry.issue === null
										? h("span", { className: "am-pop-desc" }, deduped ? t("mcp.import.conflict") : entry.server.transport)
										: h("span", { className: "am-error", style: { fontSize: "11px" } }, entry.issue === 'name-exists' ? t("mcp.import.conflict") : t("mcp.import.invalid"))
								);
							})
						)
					)
			);
		}

		/** Import-by-paste modal: parse → preview (+optional tests) → commit. */
		function ImportModal(props) {
			var t = props.t;
			var text = useState("");
			var setText = text[1];
			text = text[0];
			var entries = useState(null);
			var setEntries = entries[1];
			entries = entries[0];
			var busy = useState(false);
			var setBusy = busy[1];
			busy = busy[0];
			var testFirst = useState(false);
			var setTestFirst = testFirst[1];
			testFirst = testFirst[0];
			var error = useState("");
			var setError = error[1];
			error = error[0];
			/** Hover card payload: { top, left, text } or null. Fixed-positioned, so
			 *  it never touches the scroll container's layout. */
			var hoverInfo = useState(null);
			var setHoverInfo = hoverInfo[1];
			hoverInfo = hoverInfo[0];
			var picked = useState({});
			var setPicked = picked[1];
			picked = picked[0];

			var runParse = useCallback(function () {
				setError("");
				setBusy(true);
				setEntries(null);
				api.importPreview(text, testFirst).then(function (response) {
					if (!response.ok) {
						setError(format(t("mcp.import.badJson"), { message: (response.body && response.body.message) || response.body && response.body.error || response.status }));
					} else {
						applyEntries(response.body.entries);
					}
					setBusy(false);
				}, function (networkError) {
					setError(networkError.message);
					setBusy(false);
				});
			}, [text, testFirst]);

			/** Fill the preview from a parsed entry list. */
			function applyEntries(list) {
				var initial = {};
				list.forEach(function (entry) {
					if (entry.issue === null) initial[entry.name] = true;
				});
				setPicked(initial);
				setEntries(list);
			}

			/** Load the read-only ~/.agents/mcp.json import source. */
			var runAgents = useCallback(function () {
				setError("");
				setBusy(true);
				setEntries(null);
				api.agentsFile().then(function (response) {
					setBusy(false);
					if (response.status === 404) {
						setError(t("mcp.import.agentsMissing"));
						return;
					}
					if (!response.ok) {
						setError((response.body && response.body.error) || String(response.status));
						return;
					}
					applyEntries(response.body.entries);
				}, function (networkError) {
					setError(networkError.message);
					setBusy(false);
				});
			}, []);

			var commit = useCallback(function () {
				var selected = (entries || []).filter(function (entry) { return entry.issue === null && picked[entry.name] === true; });
				if (selected.length === 0) {
					setError(t("mcp.import.nothing"));
					return;
				}
				setBusy(true);
				api.importCommit(selected.map(function (entry) { return { name: entry.name, server: entry.server }; })).then(function (response) {
					setBusy(false);
					if (response.ok) props.onDone();
					else setError((response.body && response.body.error) || String(response.status));
				}, function (networkError) {
					setError(networkError.message);
					setBusy(false);
				});
			}, [entries, picked]);

			return h(Modal, {
				title: t("mcp.import.title"),
				onClose: props.onClose,
				footer: [
					h("button", { key: "commit", type: "button", className: "am-btn", "data-variant": "primary", disabled: busy || entries === null, onClick: commit }, t("mcp.import.save"))
				]
			},
				h("p", { className: "am-hint" }, t("mcp.import.hint")),
				h("textarea", {
					className: "am-textarea",
					value: text,
					onChange: function (event) { setText(event.target.value); },
					placeholder: '{ "mcpServers": { "server": { "command": "npx", "args": ["-y", "…"] } } }',
					spellCheck: false
				}),
				h("div", { className: "am-pop-actions" },
					h("label", { className: "am-check" },
						h("input", { type: "checkbox", checked: testFirst, onChange: function (event) { setTestFirst(event.target.checked); } }),
						h("span", null, t("mcp.import.testAll"))
					),
					h("div", { className: "am-spacer" }),
					props.agentsCount === undefined ? null : h("button", {
						type: "button", className: "am-btn", disabled: busy, onClick: runAgents
					}, format(t("mcp.import.fromAgents"), { n: props.agentsCount })),
					h("button", { type: "button", className: "am-btn", disabled: busy || text.trim() === "", onClick: runParse }, busy ? t("mcp.testing") : t("mcp.import.parse"))
				),
				error === "" ? null : h("p", { className: "am-error", role: "alert" }, error),
				entries === null ? null : h("div", { className: "am-kv" },
					h("span", { className: "am-label" }, format(t("mcp.import.parsed"), { n: entries.length })),
					entries.map(function (entry) {
						var selectable = entry.issue === null;
						var issueKey = entry.issue === "name-exists" ? "mcp.import.conflict" : "mcp.import.invalid";
						var testBadge = null;
						if (entry.test !== null) {
							testBadge = entry.test.ok === true
								? h("span", { className: "am-badge", "data-tone": "ok" }, format(t("mcp.toolCount"), { n: entry.test.toolCount }))
								: h("span", { className: "am-badge", "data-tone": "fail" }, entry.test.error);
						}
						return h("div", { key: entry.name, className: "am-import-entry" },
							h("input", {
								type: "checkbox",
								disabled: !selectable,
								checked: selectable === true && picked[entry.name] === true,
								onChange: function (event) {
									var next = Object.assign({}, picked);
									next[entry.name] = event.target.checked;
									setPicked(next);
								}
							}),
							h("div", { style: { flex: "1", minWidth: "0", display: "flex", flexDirection: "column", gap: "3px" } },
								h("span", { className: "am-tool-name" }, entry.name, " · ", entry.server.transport || "?"),
								selectable ? null : h("span", { className: "am-error" }, t(issueKey))
							),
							testBadge
						);
					})
				)
			);
		}

		/** Add/Edit server form modal. */
		function ServerFormModal(props) {
			var t = props.t;
			var original = props.server || {};
			var name = useState(props.name || "");
			var setName = name[1];
			name = name[0];
			var transport = useState(original.transport || "stdio");
			var setTransport = transport[1];
			transport = transport[0];
			var command = useState(original.command || "");
			var setCommand = command[1];
			command = command[0];
			var args = useState((original.args || []).join("\n"));
			var setArgs = args[1];
			args = args[0];
			var envRows = useState(mapToRows(original.env));
			var setEnvRows = envRows[1];
			envRows = envRows[0];
			var cwd = useState(original.cwd || "");
			var setCwd = cwd[1];
			cwd = cwd[0];
			var url = useState(original.url || "");
			var setUrl = url[1];
			url = url[0];
			var headerRows = useState(mapToRows(original.headers));
			var setHeaderRows = headerRows[1];
			headerRows = headerRows[0];
			var timeout = useState(original.toolCallTimeoutMs === undefined ? "" : String(original.toolCallTimeoutMs));
			var setTimeout_ = timeout[1];
			timeout = timeout[0];
			var enabled = useState(original.enabled === undefined ? true : original.enabled === true);
			var setEnabled = enabled[1];
			enabled = enabled[0];
			var error = useState("");
			var setError = error[1];
			error = error[0];
			/** Hover card payload: { top, left, text } or null. Fixed-positioned, so
			 *  it never touches the scroll container's layout. */
			var hoverInfo = useState(null);
			var setHoverInfo = hoverInfo[1];
			hoverInfo = hoverInfo[0];
			var busy = useState(false);
			var setBusy = busy[1];
			busy = busy[0];

			/** Rows editor for env/headers. */
			function kvEditor(rows, setRows, keyPlaceholder, valuePlaceholder) {
				return h("div", { className: "am-kv" },
					rows.map(function (row, index) {
						return h("div", { key: String(index), className: "am-kv-row" },
							h("input", {
								className: "am-input", value: row.key, placeholder: keyPlaceholder,
								onChange: function (event) {
									var next = rows.slice();
									next[index] = Object.assign({}, row, { key: event.target.value });
									setRows(next);
								}
							}),
							h("input", {
								className: "am-input", value: row.value, placeholder: valuePlaceholder, type: "text",
								onChange: function (event) {
									var next = rows.slice();
									next[index] = Object.assign({}, row, { value: event.target.value });
									setRows(next);
								}
							}),
							h("button", {
								type: "button", className: "am-kv-del",
								onClick: function () { setRows(rows.filter(function (_, at) { return at !== index; })); }
							}, "✕")
						);
					}),
					h("button", { type: "button", className: "am-btn", "data-variant": "ghost", onClick: function () { setRows(rows.concat([{ key: "", value: "" }])); } }, "+ " + t("mcp.addRow"))
				);
			}

			function save() {
				setError("");
				var server = { transport: transport, enabled: enabled };
				if (transport === "stdio") {
					server.command = command.trim();
					var argList = args.split("\n").map(function (line) { return line.trim(); }).filter(function (line) { return line !== ""; });
					if (argList.length > 0) server.args = argList;
					var env = rowsToMap(envRows);
					if (Object.keys(env).length > 0) server.env = env;
					if (cwd.trim() !== "") server.cwd = cwd.trim();
				} else {
					server.url = url.trim();
					var headers = rowsToMap(headerRows);
					if (Object.keys(headers).length > 0) server.headers = headers;
				}
				if (timeout.trim() !== "") {
					var parsed = Number(timeout.trim());
					if (Number.isInteger(parsed) && parsed >= 1000 && parsed <= 600000) server.toolCallTimeoutMs = parsed;
				}
				setBusy(true);
				api.saveServer(name.trim(), server).then(function (response) {
					setBusy(false);
					if (response.ok) props.onDone();
					else setError((response.body && (response.body.error === "bad-json" ? response.body.message : response.body.error)) || String(response.status));
				}, function (networkError) {
					setError(networkError.message);
					setBusy(false);
				});
			}

			var nameOk = /^[A-Za-z0-9_-]{1,32}$/.test(name.trim());
			var canSave = nameOk && busy !== true && (transport === "stdio" ? command.trim() !== "" : /^https?:\/\//.test(url.trim()));

		return h(Modal, {
			title: props.name === undefined ? t("mcp.add") : t("mcp.edit") + " · " + props.name,
			onClose: props.onClose,
			footer: [
				h("button", { key: "cancel", type: "button", className: "am-btn", onClick: props.onClose }, t("page.cancel")),
				h("button", { key: "save", type: "button", className: "am-btn", "data-variant": "primary", disabled: !canSave, onClick: save }, t("mcp.save"))
			]
		},
			h("div", { className: "am-form" },
				h(Group, { title: t("mcp.group.basic") },
					h(Field, { label: t("mcp.field.name") },
						h("input", { className: "am-input", value: name, disabled: props.name !== undefined, onChange: function (event) { setName(event.target.value); }, placeholder: "my-server" }),
						nameOk || name.trim() === "" ? null : h("span", { className: "am-error" }, "[A-Za-z0-9_-]{1,32}")
					),
					h(Field, { label: t("mcp.field.transport") },
						h("div", { className: "am-tabs" },
							h("button", { type: "button", className: "am-tab", "data-active": transport === "stdio", onClick: function () { setTransport("stdio"); } }, "stdio"),
							h("button", { type: "button", className: "am-tab", "data-active": transport === "streamable-http", onClick: function () { setTransport("streamable-http"); } }, "streamable-http")
						)
					)
				),
				transport === "stdio" ? h(Group, { title: t("mcp.group.connection") },
					h("div", { className: "am-row" },
						h(Field, { label: t("mcp.field.command") },
							h("input", { className: "am-input", value: command, onChange: function (event) { setCommand(event.target.value); }, placeholder: "npx" })
						),
						h(Field, { label: t("mcp.field.cwd") },
							h("input", { className: "am-input", value: cwd, onChange: function (event) { setCwd(event.target.value); } })
						)
					),
					h(Field, { label: t("mcp.field.args") },
						h("textarea", { className: "am-textarea", style: { minHeight: "64px" }, value: args, onChange: function (event) { setArgs(event.target.value); }, placeholder: "-y\n@modelcontextprotocol/server-everything", spellCheck: false })
					),
					h(Field, { label: t("mcp.field.env") },
						kvEditor(envRows, setEnvRows, t("mcp.key"), t("mcp.value"))
					)
				) : h(Group, { title: t("mcp.group.connection") },
					h(Field, { label: t("mcp.field.url") },
						h("input", { className: "am-input", value: url, onChange: function (event) { setUrl(event.target.value); }, placeholder: "http://localhost:3000/mcp" })
					),
					h(Field, { label: t("mcp.field.headers") },
						kvEditor(headerRows, setHeaderRows, t("mcp.key"), t("mcp.value"))
					)
				),
				h(Group, { title: t("mcp.group.advanced") },
					h("div", { className: "am-row" },
						h(Field, { label: t("mcp.field.timeout") },
							h("input", { className: "am-input", value: timeout, onChange: function (event) { setTimeout_(event.target.value); }, placeholder: "60000" })
						)
					),
					h("label", { className: "am-check" },
						h("input", { type: "checkbox", checked: enabled, onChange: function (event) { setEnabled(event.target.checked); } }),
						h("span", null, t("mcp.field.enabled"))
					)
				),
				error === "" ? null : h("p", { className: "am-error", role: "alert" }, error)
			)
		);
		}

	/** One server card: status, meta, actions, expandable tool list. */
	function ServerCard(props) {
		var t = props.t;
		var server = props.server;
		var poolEntry = props.poolEntry;
		var confirming = useState(false);
		var setConfirming = confirming[1];
		confirming = confirming[0];
		var moreOpen = useState(false);
		var setMoreOpen = moreOpen[1];
		moreOpen = moreOpen[0];
		var moreRef = useRef(null);
		var toggling = useState(false);
		var setToggling = toggling[1];
		toggling = toggling[0];
		var enabledNow = server.enabled !== false;
		/** The switch shows its spinner while the toggle request is in flight OR
		 *  the pool entry is still connecting/closing after the flip. */
		var switchBusy = toggling === true
			|| (poolEntry !== undefined && (poolEntry.state === "connecting" || poolEntry.state === "closing"));

		/** Flip this server's enabled flag; the host re-syncs the live pool. */
		function toggle() {
			if (toggling) return;
			setToggling(true);
			api.toggleServer(props.name, !enabledNow).then(function (response) {
				setToggling(false);
				if (response.ok) {
					if (props.onDone !== undefined) props.onDone();
				} else {
					if (props.onToggleError !== undefined) props.onToggleError((response.body && (response.body.message || response.body.error)) || String(response.status));
				}
			}, function (networkError) {
				setToggling(false);
				if (props.onToggleError !== undefined) props.onToggleError(networkError.message);
			});
		}

			/** Config summary line: command or url with secrets masked. */
			var summary = server.transport === "stdio"
				? [server.command].concat(server.args || []).join(" ")
				: server.url;
			var envKeys = server.env !== undefined ? Object.keys(server.env) : [];
			var headerKeys = server.headers !== undefined ? Object.keys(server.headers) : [];
			var tools = (poolEntry && poolEntry.tools) || [];
			var testing = props.testingNames[props.name] === true;
			var testResult = props.testResults[props.name];
			/** Card status: pool state first, last manual test outcome second. */
			var status = cardStatus(server, poolEntry, testResult, testing);

			/** The live failure text: the pool's connect error or the last manual test's error. */
			var failureText = "";
			if (!testing) {
				if (poolEntry !== undefined && poolEntry.state === "failed") {
					failureText = poolEntry.error || t("mcp.status.fail");
				} else if (testResult !== undefined && testResult.ok !== true) {
					failureText = testResult.error || t("mcp.status.fail");
				}
			}

			// Click-outside / Escape closes the kebab menu.
			useEffect(function () {
				if (!moreOpen) return undefined;
				function onDown(event) {
					if (moreRef.current !== null && moreRef.current !== undefined && !moreRef.current.contains(event.target)) setMoreOpen(false);
				}
				function onKey(event) {
					if (event.key === "Escape") setMoreOpen(false);
				}
				document.addEventListener("mousedown", onDown);
				document.addEventListener("keydown", onKey);
				return function () {
					document.removeEventListener("mousedown", onDown);
					document.removeEventListener("keydown", onKey);
				};
			}, [moreOpen]);
			// Leaving the card or opening the menu resets an armed delete.
			function armDelete() {
				setConfirming(true);
				setMoreOpen(false);
			}

			/** One kebab-menu action row; dangerously deletable while armed. */
			function moreItem(key, label, options) {
				options = options || {};
				return h("button", {
					type: "button",
					className: "am-more-item",
					"data-variant": options.danger === true ? "danger" : "",
					disabled: options.disabled === true,
					onClick: function () { setMoreOpen(false); options.run(); }
				}, label, options.desc !== undefined ? h("span", { className: "am-more-desc" }, options.desc) : null);
			}

			return h("div", { className: "am-card", onMouseLeave: function () { setConfirming(false); } },
				h("div", { className: "am-card-head" },
					h("span", { className: "am-dot", "data-tone": status.tone, "data-pulse": status.key === "connecting" ? "true" : "false" }),
					h("span", { className: "am-card-name", title: props.name }, props.name),
					h("span", { className: "am-badge" }, server.transport),
					h("span", { className: "am-badge", "data-tone": status.tone }, t("mcp.status." + status.key)),
					tools.length > 0 ? h("span", { className: "am-badge" }, format(t("mcp.toolCount"), { n: tools.length })) : null,
					h("div", { className: "am-spacer" }),
					h("button", {
						type: "button",
						className: "am-switch",
						"data-on": enabledNow ? "true" : "false",
						"data-loading": switchBusy ? "true" : "false",
						role: "switch",
						"aria-checked": enabledNow ? "true" : "false",
						"aria-busy": switchBusy ? "true" : "false",
						"aria-label": t("mcp.toggle"),
						title: switchBusy ? t("mcp.toggleBusy") : (enabledNow ? t("mcp.toggleOn") : t("mcp.toggleOff")),
						disabled: switchBusy,
						onClick: toggle
					}, switchBusy ? h("span", { className: "am-spin", "aria-hidden": "true" }) : null),
					h("div", { className: "am-more", ref: moreRef },
						h("button", {
							type: "button", className: "am-btn", "data-variant": "ghost",
							"aria-expanded": moreOpen ? "true" : "false",
							"aria-haspopup": "menu",
							"aria-label": t("mcp.more.title"),
							title: t("mcp.more.title"),
							onClick: function () { setMoreOpen(function (current) { return !current; }); }
						}, "⋯"),
						moreOpen ? h("div", { className: "am-more-menu", role: "menu" },
							moreItem("test", testing ? t("mcp.testing") : t("mcp.test"), {
								disabled: testing || server.enabled === false,
								run: function () { props.onTest(props.name); }
							}),
							tools.length > 0 ? moreItem("tools", "⚙ " + t("mcp.tools"), {
								desc: format(t("mcp.toolCount"), { n: tools.length }),
								run: function () { if (props.onTools !== undefined) props.onTools(props.name); }
							}) : null,
							moreItem("edit", t("mcp.edit"), { run: function () { props.onEdit(props.name); } }),
							moreItem("delete", confirming ? t("mcp.delConfirm") : t("mcp.del"), {
								danger: true,
								run: function () { if (confirming) props.onDelete(props.name); else armDelete(); }
							})
						) : null
					)
				),
				h("div", { className: "am-card-actions" },
					h("button", { type: "button", className: "am-btn", disabled: testing || server.enabled === false, onClick: function () { props.onTest(props.name); } }, testing ? t("mcp.testing") : t("mcp.test")),
					tools.length > 0 ? h("button", { type: "button", className: "am-btn", title: t("mcp.tools.open"), onClick: function () { if (props.onTools !== undefined) props.onTools(props.name); } }, "⚙ " + t("mcp.tools")) : null,
					h("button", { type: "button", className: "am-btn", onClick: function () { props.onEdit(props.name); } }, t("mcp.edit")),
					h("button", {
						type: "button", className: "am-btn", "data-variant": confirming ? "danger" : "",
						onClick: function () {
							if (confirming) props.onDelete(props.name);
							else setConfirming(true);
						},
						onBlur: function () { setConfirming(false); }
					}, confirming ? t("mcp.delConfirm") : t("mcp.del"))
				),
				h("div", { className: "am-card-body" },
					h("span", { className: "am-tool-name", title: summary }, summary),
					envKeys.length > 0 || headerKeys.length > 0 ? h("span", null,
						envKeys.map(function (key) { return h("span", { key: "e-" + key, className: "am-badge", style: { marginRight: "4px" } }, key + "=" + maskValue(server.env[key])); }),
						headerKeys.map(function (key) { return h("span", { key: "h-" + key, className: "am-badge", style: { marginRight: "4px" } }, key + ": " + maskValue(server.headers[key])); })
					) : null,
					failureText !== "" ? h("span", { className: "am-error", title: failureText }, "✗ " + failureText) : null,
					testResult !== undefined && testResult.ok === true ? h("span", { className: "am-hint" }, "✓ " + format(t("mcp.toolCount"), { n: testResult.tools.length })) : null
				),
			);
		}

		/**
		 * Tool detail modal for one MCP server: every tool (method) with its
		 * name and description; each tool expands into a JSON arguments editor
		 * with a test-call button and a bounded, scrollable result pane.
		 */
		function ToolsModal(props) {
			var t = props.t;
			var server = props.server;
			var tools = props.tools || [];
			var openTool = useState(null);
			var setOpenTool = openTool[1]; openTool = openTool[0];
			var argsText = useState("{}");
			var setArgsText = argsText[1]; argsText = argsText[0];
			var running = useState(false);
			var setRunning = running[1]; running = running[0];
			var result = useState(null);
			var setResult = result[1]; result = result[0];
			var error = useState("");
			var setError = error[1]; error = error[0];

			function toggle(toolName) {
				setResult(null);
				setError("");
				setArgsText("{}");
				setOpenTool(function (current) { return current === toolName ? null : toolName; });
			}

			function runCall(toolName) {
				var parsed;
				try {
					parsed = JSON.parse(argsText);
				} catch (parseError) {
					setError(format(t("mcp.tools.badJson"), { message: parseError.message }));
					return;
				}
				if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
					setError(format(t("mcp.tools.badJson"), { message: "object" }));
					return;
				}
				setError("");
				setResult(null);
				setRunning(true);
				api.callServerTool(server, toolName, parsed).then(function (response) {
					setRunning(false);
					if (response.ok) setResult(response.body.result);
					else setError(format(t("mcp.tools.failed"), { message: (response.body && (response.body.message || response.body.error)) || String(response.status) }));
				}, function (networkError) {
					setRunning(false);
					setError(format(t("mcp.tools.failed"), { message: networkError.message }));
				});
			}

			return h(Modal, {
				title: format(t("mcp.tools.title"), { name: server }) + " · " + format(t("mcp.toolCount"), { n: tools.length }),
				onClose: props.onClose
			},
				tools.length === 0 ? h("p", { className: "am-hint" }, t("mcp.noTools")) :
					h("div", { className: "am-kv" },
						tools.map(function (tool) {
						var active = openTool === tool.name;
						return h("div", { key: tool.publicName || tool.name, style: { border: "1px solid var(--dsw-alias-border-l1)", borderRadius: "8px", padding: "8px 10px", display: "flex", flexDirection: "column", gap: "6px" } },
							h("button", {
								type: "button",
								style: { border: 0, background: "transparent", color: "inherit", cursor: "pointer", padding: 0, textAlign: "left", display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 },
								onClick: function () { toggle(tool.name); }
							},
								h("span", { className: "am-tool-name", style: { maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, (active ? "▾ " : "▸ ") + tool.name),
								h("span", { className: "am-tool-desc", style: { display: "block", whiteSpace: "normal" } }, tool.description || "")
							),
						active ? h("div", { style: { display: "flex", flexDirection: "column", gap: "6px", borderTop: "1px dashed var(--dsw-alias-border-l1)", paddingTop: "8px" } },
							tool.publicName && tool.publicName !== tool.name ? h("span", { className: "am-hint", style: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "11px", wordBreak: "break-all" } }, tool.publicName) : null,
							h("label", { className: "am-label" }, t("mcp.tools.args")),
							h("textarea", {
								className: "am-textarea", style: { minHeight: "56px", maxHeight: "160px" }, value: argsText, spellCheck: false,
								onChange: function (event) { setArgsText(event.target.value); }
							}),
							h("div", null,
								h("button", { type: "button", className: "am-btn", "data-variant": "primary", "data-size": "sm", disabled: running, onClick: function () { runCall(tool.name); } }, running ? t("mcp.tools.running") : t("mcp.tools.run"))
							),
							error === "" ? null : h("p", { className: "am-error", role: "alert", style: { margin: 0 } }, error),
							result === null ? null : h("div", { style: { display: "flex", flexDirection: "column", gap: "4px" } },
								h("span", { className: "am-label" }, t("mcp.tools.result")),
								h("pre", { style: { margin: 0, maxHeight: "220px", overflow: "auto", padding: "8px 10px", background: "var(--dsw-alias-bg-base)", border: "1px solid var(--dsw-alias-border-l1)", borderRadius: "8px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "11.5px", lineHeight: "1.5", whiteSpace: "pre-wrap", wordBreak: "break-word" } }, JSON.stringify(result, null, 2))
							)
						) : null
					);
				})
				)
			);
		}

		/** The MCP tab: toolbar + server list + modals. */
		function McpTab(props) {
			var t = props.t;
			var state = props.state;
			var refresh = props.refresh;
			var modal = useState(null);
			var setModal = modal[1];
			modal = modal[0];
			var testingNames = useState({});
			var setTestingNames = testingNames[1];
			testingNames = testingNames[0];
			var testResults = useState({});
			var setTestResults = testResults[1];
			testResults = testResults[0];
			var rowError = useState("");
			var setRowError = rowError[1];
			rowError = rowError[0];
			var toolsFor = useState(null);
			var setToolsFor = toolsFor[1]; toolsFor = toolsFor[0];

			var servers = (state && state.servers) || {};
			var pool = (state && state.pool) || {};
			var storeInfo = (state && state.store) || null;
			var names = Object.keys(servers).sort();
			var totalTools = Object.values(pool).reduce(function (sum, entry) { return sum + (entry.toolCount || 0); }, 0);

			function runTest(name) {
				var next = Object.assign({}, testingNames);
				next[name] = true;
				setTestingNames(next);
				setRowError("");
				api.testServer(name).then(function (response) {
					var results = Object.assign({}, testResults);
					var idle = Object.assign({}, testingNames);
					delete idle[name];
					setTestingNames(idle);
					if (response.ok && response.body.results && response.body.results[name]) results[name] = response.body.results[name];
					else results[name] = { ok: false, error: (response.body && response.body.error) || String(response.status) };
					setTestResults(results);
					refresh();
				}, function (networkError) {
					var idle = Object.assign({}, testingNames);
					delete idle[name];
					setTestingNames(idle);
					setRowError(networkError.message);
				});
			}

			function runTestAll() {
				var next = {};
				names.forEach(function (name) { if (servers[name].enabled !== false) next[name] = true; });
				setTestingNames(next);
				api.testServer().then(function (response) {
					setTestingNames({});
					if (response.ok && response.body.results) setTestResults(response.body.results);
					else setRowError((response.body && response.body.error) || String(response.status));
					refresh();
				}, function (networkError) {
					setTestingNames({});
					setRowError(networkError.message);
				});
			}

			function remove(name) {
				api.deleteServer(name).then(function (response) {
					if (!response.ok) setRowError((response.body && response.body.error) || String(response.status));
					refresh();
				}, function (networkError) { setRowError(networkError.message); });
			}

			return h("div", { className: "am-stack", style: { flex: "1" } },
				h("div", { className: "am-toolbar" },
					h("button", { type: "button", className: "am-btn", "data-variant": "primary", onClick: function () { setModal({ kind: "add" }); } }, "+ " + t("mcp.add")),
					h("button", { type: "button", className: "am-btn", onClick: function () { setModal({ kind: "import" }); } }, t("mcp.importPaste")),
					h("button", { type: "button", className: "am-btn", onClick: function () { setModal({ kind: "sync" }); } }, "⇄ " + t("mcp.import.sync")),
					h("button", { type: "button", className: "am-btn", disabled: names.length === 0, onClick: runTestAll }, t("mcp.testAll")),
					h("div", { className: "am-spacer" }),
					h("span", { className: "am-hint" }, names.length === 0 ? null : format(t("mcp.count"), { n: names.length, t: totalTools }))
				),
				storeInfo !== null && storeInfo.migrated > 0 ? h("p", { className: "am-hint" }, "⇢ " + format(t("mcp.migrated"), { n: storeInfo.migrated })) : null,
				storeInfo !== null && storeInfo.error ? h("p", { className: "am-error", role: "alert" }, format(t("mcp.store.error"), { message: storeInfo.error })) : null,
				rowError === "" ? null : h("p", { className: "am-error", role: "alert" }, rowError),
				names.length === 0 ? h(Empty, {
					glyph: "\u2317", text: t("mcp.empty"),
					actions: [
						h("button", { key: "add", type: "button", className: "am-btn", "data-variant": "primary", onClick: function () { setModal({ kind: "add" }); } }, "+ " + t("mcp.add")),
						h("button", { key: "import", type: "button", className: "am-btn", onClick: function () { setModal({ kind: "import" }); } }, t("mcp.importPaste"))
					]
				}) :
					h("div", { className: "am-list" },
						names.map(function (name) {
							return h(ServerCard, {
								key: name, t: t, name: name, server: servers[name], poolEntry: pool[name],
								testingNames: testingNames, testResults: testResults,
								onTest: runTest,
								onDone: refresh,
								onToggleError: function (message) { setRowError(format(t("mcp.toggleFailed"), { message: message })); },
								onTools: function (toolServer) { setToolsFor(toolServer); },
								onEdit: function (editName) { setModal({ kind: "edit", name: editName }); },
								onDelete: remove
							});
						})
					),
				modal === null ? null : modal.kind === "import"
					? h(ImportModal, {
						key: "import", t: t,
						agentsCount: storeInfo === null || storeInfo.agentsFile === undefined ? undefined : storeInfo.agentsFile.count,
						onClose: function () { setModal(null); }, onDone: function () { setModal(null); refresh(); }
					})
					: modal.kind === "sync"
						? h(SyncModal, { key: "sync", t: t, onClose: function () { setModal(null); }, onDone: function () { setModal(null); refresh(); } })
						: h(ServerFormModal, {
						key: modal.kind === "edit" ? "edit-" + modal.name : "add",
						t: t, name: modal.kind === "edit" ? modal.name : undefined,
						server: modal.kind === "edit" ? servers[modal.name] : undefined,
						onClose: function () { setModal(null); },
						onDone: function () { setModal(null); refresh(); }
					}),
				toolsFor === null ? null : h(ToolsModal, {
					t: t,
					key: "tools:" + toolsFor,
					server: toolsFor,
					tools: (pool[toolsFor] && pool[toolsFor].tools) || [],
					onClose: function () { setToolsFor(null); }
				})
			);
		}

		// ---------------------------------------------------------------------------
		// Skills tab
		// ---------------------------------------------------------------------------

		/**
		 * Minimal Markdown renderer for the skill preview: builds React elements
		 * directly (never innerHTML), covering the constructs SKILL.md files use —
		 * headings, paragraphs, bold/italic, inline code, fenced code, lists,
		 * blockquotes, rules, and links.
		 */

		/** Inline spans of one text run: `code`, **bold**, *italic*, [t](url). */
		function inlineMarkdown(text, keyPrefix) {
			var nodes = [];
			var plain = "";
			function flush() {
				if (plain !== "") {
					nodes.push(plain);
					plain = "";
				}
			}
			var i = 0;
			while (i < text.length) {
				if (text[i] === "`") {
					var codeEnd = text.indexOf("`", i + 1);
					if (codeEnd > i) {
						flush();
						nodes.push(h("code", { key: keyPrefix + "-c" + nodes.length, className: "am-md-code" }, text.slice(i + 1, codeEnd)));
						i = codeEnd + 1;
						continue;
					}
				}
				if (text.startsWith("**", i)) {
					var boldEnd = text.indexOf("**", i + 2);
					if (boldEnd > i) {
						flush();
						nodes.push(h("strong", { key: keyPrefix + "-b" + nodes.length }, inlineMarkdown(text.slice(i + 2, boldEnd), keyPrefix + "b" + nodes.length)));
						i = boldEnd + 2;
						continue;
					}
				}
				if (text[i] === "*" && text[i + 1] !== "*" && text[i + 1] !== " ") {
					var emEnd = text.indexOf("*", i + 1);
					if (emEnd > i) {
						flush();
						nodes.push(h("em", { key: keyPrefix + "-i" + nodes.length }, inlineMarkdown(text.slice(i + 1, emEnd), keyPrefix + "i" + nodes.length)));
						i = emEnd + 1;
						continue;
					}
				}
				if (text[i] === "[") {
					var link = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(text.slice(i));
					if (link !== null) {
						flush();
						nodes.push(h("a", { key: keyPrefix + "-a" + nodes.length, href: link[2], target: "_blank", rel: "noreferrer", onClick: function (event) { event.stopPropagation(); } }, link[1]));
						i += link[0].length;
						continue;
					}
				}
				plain += text[i];
				i += 1;
			}
			flush();
			return nodes;
		}

		/** Block-level markdown: one scrollable rendered document. */
		function MarkdownView(props) {
			var lines = String(props.text || "").split(/\r?\n/);
			var blocks = [];
			var key = 0;
			var i = 0;
			while (i < lines.length) {
				var line = lines[i];
				if (line.startsWith("```")) {
					var code = [];
					i += 1;
					while (i < lines.length && !lines[i].startsWith("```")) {
						code.push(lines[i]);
						i += 1;
					}
					i += 1;
					blocks.push(h("pre", { key: "k" + key++, className: "am-md-pre" }, code.join("\n")));
					continue;
				}
				if (/^#{1,6}\s/.test(line)) {
					var level = Math.min(line.match(/^#+/)[0].length + 2, 6);
					blocks.push(h("h" + level, { key: "k" + key++, className: "am-md-h" }, inlineMarkdown(line.replace(/^#+\s*/, ""), "h" + key)));
					i += 1;
					continue;
				}
				if (/^\s*[-*]\s+/.test(line)) {
					var bullets = [];
					while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
						bullets.push(h("li", { key: "li" + bullets.length }, inlineMarkdown(lines[i].replace(/^\s*[-*]\s+/, ""), "li" + bullets.length)));
						i += 1;
					}
					blocks.push(h("ul", { key: "k" + key++, className: "am-md-list" }, bullets));
					continue;
				}
				if (/^\s*\d+\.\s+/.test(line)) {
					var numbers = [];
					while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
						numbers.push(h("li", { key: "li" + numbers.length }, inlineMarkdown(lines[i].replace(/^\s*\d+\.\s+/, ""), "li" + numbers.length)));
						i += 1;
					}
					blocks.push(h("ol", { key: "k" + key++, className: "am-md-list" }, numbers));
					continue;
				}
				if (line.startsWith(">")) {
					var quote = [];
					while (i < lines.length && lines[i].startsWith(">")) {
						quote.push(lines[i].replace(/^>\s?/, ""));
						i += 1;
					}
					blocks.push(h("blockquote", { key: "k" + key++, className: "am-md-quote" }, inlineMarkdown(quote.join(" "), "q" + key)));
					continue;
				}
				if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
					blocks.push(h("hr", { key: "k" + key++, className: "am-md-hr" }));
					i += 1;
					continue;
				}
				if (line.trim() === "") {
					i += 1;
					continue;
				}
				var para = [line];
				i += 1;
				while (i < lines.length && lines[i].trim() !== "" && !/^(#{1,6}\s|```|\s*[-*]\s|\s*\d+\.\s|>)/.test(lines[i])) {
					para.push(lines[i]);
					i += 1;
				}
				blocks.push(h("p", { key: "k" + key++, className: "am-md-p" }, inlineMarkdown(para.join(" "), "p" + key)));
			}
			return h("div", { className: "am-md" }, blocks);
		}

		/** Map installer API failures to localized guidance. */
		function installErrorText(t, response) {
			var code = response.body && response.body.error;
			if (code === "not-supported" || response.status === 404) return t("mcp.import.sync.needRestart");
			if (code === "bad-shape" || code === "empty" || code === "bad-body") return t("skills.install.hint");
			if (code === "not-found") return t("skills.install.notFound");
			if (code === "no-skill-md") return t("skills.install.noneFound");
			if (code === "subdir-not-found") return t("skills.install.subdirNotFound");
			var suffix = response.body && response.body.message ? ": " + response.body.message : "";
			return (code !== undefined && code !== null ? String(code) : String(response.status)) + suffix;
		}

		/**
		 * Install skills from a GitHub path: owner/repo, owner/repo/subdir, #branch,
		 * or a full github.com URL. Results list installed and skipped skills.
		 */
		function InstallModal(props) {
			var t = props.t;
			var source = useState("");
			var setSource = source[1];
			source = source[0];
			var busy = useState(false);
			var setBusy = busy[1];
			busy = busy[0];
			var error = useState("");
			var setError = error[1];
			error = error[0];
			/** Hover card payload: { top, left, text } or null. Fixed-positioned, so
			 *  it never touches the scroll container's layout. */
			var hoverInfo = useState(null);
			var setHoverInfo = hoverInfo[1];
			hoverInfo = hoverInfo[0];
			var result = useState(null);
			var setResult = result[1];
			result = result[0];

			function run() {
				if (source.trim() === "") {
					setError(t("skills.install.hint"));
					return;
				}
				setBusy(true);
				setError("");
				setResult(null);
				api.installGithub(source.trim()).then(function (response) {
					setBusy(false);
					if (response.ok) {
						setResult(response.body);
						if (typeof props.onInstalled === "function") props.onInstalled();
					} else {
						setError(installErrorText(t, response));
					}
				}, function (networkError) {
					setBusy(false);
					setError(networkError.message);
				});
			}

			return h(Modal, {
				title: t("skills.install.title"),
				onClose: props.onClose,
				footer: [
					h("button", { key: "run", type: "button", className: "am-btn", "data-variant": "primary", disabled: busy, onClick: run }, busy ? t("page.loading") : t("skills.install.run"))
				]
			},
				h("p", { className: "am-hint" }, t("skills.install.hint")),
				h("input", {
					className: "am-input", type: "text", value: source,
					placeholder: t("skills.install.placeholder"), spellCheck: false,
					onChange: function (event) { setSource(event.target.value); },
					onKeyDown: function (event) { if (event.key === "Enter") run(); }
				}),
				error === "" ? null : h("p", { className: "am-error", role: "alert" }, error),
				result === null ? null : h("div", { style: { display: "flex", flexDirection: "column", gap: "4px" } },
					result.installed !== undefined && result.installed.length > 0
						? h("span", { className: "am-hint" }, "✓ " + format(t("skills.install.installed"), { names: result.installed.map(function (row) { return row.name + " (" + row.files + ")"; }).join(", ") })) : null,
					result.skipped !== undefined && result.skipped.length > 0
						? h("span", { className: "am-hint" }, "⇢ " + format(t("skills.install.skipped"), { names: result.skipped.map(function (row) { return row.name; }).join(", ") })) : null,
					result.installed !== undefined && result.installed.length === 0 && result.skipped !== undefined && result.skipped.length === 0
						? h("span", { className: "am-hint" }, t("skills.install.noneFound")) : null
				)
			);
		}

		/** Build a nested directory tree from flat relative file paths. */
		function buildFileTree(files) {
			var root = { name: "", dirs: new Map(), files: [] };
			(files || []).forEach(function (file) {
				var parts = String(file.path).split("/");
				var node = root;
				for (var i = 0; i < parts.length - 1; i += 1) {
					var segment = parts[i];
					if (segment === "") continue;
					if (!node.dirs.has(segment)) node.dirs.set(segment, { name: segment, dirs: new Map(), files: [] });
					node = node.dirs.get(segment);
				}
				node.files.push(file);
			});
			return root;
		}

		/**
		 * The Skills tab: a full-width list by default — one click on a skill
		 * enters the viewer/editor. The left rail is that skill's DIRECTORY tree
		 * (auto-narrowed, expanding on hover) with a back control to the outer
		 * skill list. The right side renders the file content (Markdown rendered)
		 * with no header chrome; double-click the content to edit, and a floating
		 * bar carries the save action while editing.
		 */
		function SkillsTab(props) {
			var t = props.t;
			var state = props.state;
			var refresh = props.refresh;
			var skills = (state && state.skills) || [];
			var selected = useState(null);
			var setSelected = selected[1];
			selected = selected[0];
			var editing = useState(false);
			var setEditing = editing[1];
			editing = editing[0];
			var files = useState([]);
			var setFiles = files[1];
			files = files[0];
			var openFile = useState(null);
			var setOpenFile = openFile[1];
			openFile = openFile[0];
			var content = useState("");
			var setContent = content[1];
			content = content[0];
			var baseSha = useState("");
			var setBaseSha = baseSha[1];
			baseSha = baseSha[0];
			var loadedContent = useState("");
			var setLoadedContent = loadedContent[1];
			loadedContent = loadedContent[0];
			var editable = useState(true);
			var setEditable = editable[1];
			editable = editable[0];
			var busy = useState(false);
			var setBusy = busy[1];
			busy = busy[0];
			var saving = useState(false);
			var setSaving = saving[1];
			saving = saving[0];
			var message = useState(null);
			var setMessage = message[1];
			message = message[0];
			/** Whether the right pane is in text-edit mode (vs rendered view). */
			var editText = useState(false);
			var setEditText = editText[1];
			editText = editText[0];
		/** GitHub install modal open flag. */
			var installOpen = useState(false);
			var setInstallOpen = installOpen[1];
			installOpen = installOpen[0];
			/** Collapsed directory paths in the rail tree, keyed by folder path. */
			var collapsedDirs = useState({});
			var setCollapsedDirs = collapsedDirs[1];
			collapsedDirs = collapsedDirs[0];

			var dirty = content !== loadedContent;
			var isMarkdown = openFile !== null && /\.md$/i.test(openFile);

			function showFileError(error, fallbackKey) {
				setMessage({ tone: "error", text: format(t(fallbackKey), { message: error }) });
			}

			/** Fetch one skill's file list. */
			function ensureFiles(skill) {
				return api.skillFiles(skill).then(function (response) {
					if (response.ok && Array.isArray(response.body.files)) {
						setFiles(response.body.files);
						return response.body.files;
					}
					setFiles([]);
					showFileError((response.body && response.body.error) || String(response.status), "skills.loadFailed");
					return [];
				}, function (networkError) {
					setFiles([]);
					showFileError(networkError.message, "skills.loadFailed");
					return [];
				});
			}

			/** The file a flow opens first: SKILL.md when present, else the first file. */
			function preferredFile(list) {
				if (!Array.isArray(list) || list.length === 0) return undefined;
				return list.find(function (file) { return file.path === "SKILL.md"; }) !== undefined
					? list.find(function (file) { return file.path === "SKILL.md"; })
					: list[0];
			}

			/** Browse mode: one click enters the editor for that skill. */
			function selectSkill(dir) {
				editSkill(dir);
			}

			/**
			 * Enter (or switch) edit mode for one skill's main file. Re-entering
			 * the SAME skill keeps unsaved edits instead of reloading.
			 */
			function editSkill(dir) {
				var sameSkill = editing === true && selected === dir && openFile !== null;
				setSelected(dir);
				setEditing(true);
				setMessage(null);
					if (sameSkill) return;
				ensureFiles(dir).then(function (list) {
					var first = preferredFile(list);
					if (first !== undefined) loadFile(dir, first.path);
				});
			}

			/** Leave edit mode: back to the outer skill list. */
			function closeEditor() {
				setEditing(false);
				setMessage(null);
				}

			/** Open one file of the selected skill in the in-page editor. */
			function loadFile(skill, path) {
				setBusy(true);
				setMessage(null);
				setEditText(false);
				api.readSkillFile(skill, path).then(function (response) {
					setBusy(false);
					if (response.ok && response.body.file) {
						setOpenFile(path);
						setContent(response.body.file.content);
						setLoadedContent(response.body.file.content);
						setBaseSha(response.body.file.sha);
						setEditable(response.body.file.editable === true);
						if (response.body.file.editable !== true) setMessage({ tone: "error", text: t("skills.readonly") });
					} else {
						showFileError((response.body && response.body.error) || String(response.status), "skills.loadFailed");
					}
				}, function (networkError) {
					setBusy(false);
					showFileError(networkError.message, "skills.loadFailed");
				});
			}

			function save() {
				if (openFile === null || !editable || !dirty) return;
				setSaving(true);
				setMessage(null);
				api.writeSkillFile(selected, openFile, content, baseSha).then(function (response) {
					setSaving(false);
					if (response.ok) {
						setBaseSha(response.body.sha);
						setLoadedContent(content);
						setMessage({ tone: "ok", text: t("skills.savedAt") });
						refresh();
					} else if (response.body && response.body.error === "conflict") {
						setMessage({ tone: "error", text: t("skills.conflict") });
					} else {
						setMessage({ tone: "error", text: (response.body && response.body.error) || String(response.status) });
					}
				}, function (networkError) {
					setSaving(false);
					setMessage({ tone: "error", text: networkError.message });
				});
			}

			function onKeyDown(event) {
				if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
					event.preventDefault();
					save();
				}
			}

			/** Double-click the rendered content to start editing it. */
			function enterEdit() {
				if (!editable || openFile === null) return;
				setEditText(true);
			}

			/**
			 * Render one tree node: folders toggle, files open in the viewer.
			 *
			 * @param {object} node - built by buildFileTree.
			 * @param {string} prefix - accumulated folder path for collapse keys.
			 * @param {number} depth - indentation depth.
			 * @returns {Array<object>} React elements.
			 */
			function treeRows(node, prefix, depth) {
				var rows = [];
				var dirs = [...node.dirs.keys()].sort();
				dirs.forEach(function (name) {
					var child = node.dirs.get(name);
					var dirPath = prefix === "" ? name : prefix + "/" + name;
					var isCollapsed = collapsedDirs[dirPath] === true;
					rows.push(h("button", {
						key: "d-" + dirPath, type: "button", className: "am-tree-dir",
						"data-collapsed": isCollapsed, title: dirPath,
						style: { paddingLeft: (6 + depth * 9) + "px" },
						onClick: function () {
							var next = Object.assign({}, collapsedDirs);
							next[dirPath] = !isCollapsed;
							setCollapsedDirs(next);
						}
					}, h("span", { className: "am-tree-twist", "aria-hidden": "true" }, isCollapsed ? "▸" : "▾"), " ", name));
					if (!isCollapsed) rows = rows.concat(treeRows(child, dirPath, depth + 1));
				});
				node.files.slice().sort(function (a, b) { return a.path < b.path ? -1 : 1; }).forEach(function (file) {
					var name = file.path.split("/").pop();
					rows.push(h("button", {
						key: "f-" + file.path, type: "button", className: "am-tree-file",
						"data-active": openFile === file.path, title: file.path,
						style: { paddingLeft: (6 + depth * 9) + "px" },
						onClick: function () { loadFile(selected, file.path); }
					}, name));
				});
				return rows;
			}

			var fileTree = editing ? buildFileTree(files) : null;

			return h("div", { className: "am-split", "data-mode": editing ? "edit" : "browse" },
				h("div", { className: "am-skills-wrap" },
					h("div", { className: "am-skills-list" },
						editing ? [
							h("button", {
								key: "handle", type: "button", className: "am-tree-handle",
								title: selected, "aria-label": t("skills.files")
							}, "☰"),
							h("div", { key: "panel", className: "am-tree-panel" },
								h("button", {
									key: "back", type: "button", className: "am-btn", "data-variant": "ghost", "data-size": "sm",
									onClick: closeEditor, title: t("skills.back") + " · " + selected
								}, "← " + t("skills.back")),
								h("div", { key: "tree", className: "am-tree-children" },
									files.length === 0 ? h("span", { className: "am-hint", style: { padding: "2px 6px" } }, busy ? t("page.loading") : t("skills.files"))
										: treeRows(fileTree, "", 0)
								)
							)
						] : [
							h("div", { key: "head", className: "am-pop-actions" },
								h("span", { className: "am-hint" }, format(t("skills.count"), { n: skills.length })),
								h("div", { className: "am-spacer" }),
								h("button", { type: "button", className: "am-btn", onClick: function () { setInstallOpen(true); } }, "⬇ " + t("skills.install"))
							),
							h("span", { key: "hint", className: "am-hint", style: { fontSize: "11px" } }, t("skills.editHint")),
							skills.length === 0 ? h(Empty, { key: "empty", glyph: "\u270e", text: t("skills.empty") }) :
								skills.map(function (skill) {
									return h("div", {
										key: skill.dir, className: "am-skill-row", "data-active": selected === skill.dir,
										onClick: function () { editSkill(skill.dir); }
									},
										h("div", { className: "am-skill-top" },
											h("span", { className: "am-skill-name", title: skill.name }, skill.name)
										),
										h("span", { className: "am-skill-desc", title: skill.description || "" }, skill.description || t("skills.untitled")),
										h("span", { className: "am-badge am-skill-badge" }, skill.dir + " · " + skill.fileCount)
									);
								})
						]
					)
				),
				editing ? h("div", {
					className: "am-editor-pane", style: { position: "relative" },
					onClick: function () { if (!editText) enterEdit(); }
				},
					openFile === null
						? h("div", { style: { display: "flex", alignItems: "center", justifyContent: "center", flex: "1", color: "var(--dsw-alias-label-secondary)" } }, busy ? t("page.loading") : t("skills.files"))
						: editText
							? h("textarea", {
								className: "am-editor",
								"data-readonly": !editable,
								value: content,
								spellCheck: false,
								disabled: busy || !editable,
								onChange: function (event) { setContent(event.target.value); },
								onKeyDown: onKeyDown
							})
							: (isMarkdown
								? h(MarkdownView, { text: content })
								: h("pre", { className: "am-md-pre", style: { flex: "1", minHeight: "0", overflow: "auto", margin: "0", border: "0", borderRadius: "0" } }, content)),
					editText ? h("div", { className: "am-float-bar", onClick: function (event) { event.stopPropagation(); } },
						dirty ? h("span", { className: "am-dirty-dot", title: t("skills.dirty") }) : null,
						message !== null ? h("span", { className: message.tone === "ok" ? "am-hint" : "am-error", style: { maxWidth: "220px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, message.text) : null,
						h("button", {
							type: "button", className: "am-btn", "data-variant": "primary", "data-size": "sm",
							disabled: !editable || !dirty || saving,
							onClick: save
						}, saving ? t("skills.saving") : t("skills.save")),
						h("button", {
							type: "button", className: "am-btn", "data-variant": "ghost", "data-size": "sm",
							onClick: function () { setEditText(false); }, title: t("skills.back")
						}, "✕")
					) : null
				) : null,
				installOpen ? h(InstallModal, {
					key: "install", t: t,
					onClose: function () { setInstallOpen(false); },
					onInstalled: function () { refresh(); }
				}) : null
			);
		}

		// ---------------------------------------------------------------------------
		// Settings page
		// ---------------------------------------------------------------------------

		/**
		 * The settings-section page: tabs over the MCP manager and the Skills
		 * editor, one shared /state poll.
		 */
		function AgentsManagerPage(props) {
			var t = props.t || function (key) { return zh[key] || en[key] || key; };
			var state = useState(null);
			var setState = state[1];
			state = state[0];
			var error = useState("");
			var setError = error[1];
			error = error[0];
			/** Hover card payload: { top, left, text } or null. Fixed-positioned, so
			 *  it never touches the scroll container's layout. */
			var hoverInfo = useState(null);
			var setHoverInfo = hoverInfo[1];
			hoverInfo = hoverInfo[0];
			var tab = useState("mcp");
			var setTab = tab[1];
			tab = tab[0];

			var refresh = useCallback(function () {
				api.state().then(function (response) {
					if (response.ok) {
						setState(response.body);
						setError("");
					} else {
					setError((response.body && response.body.error) || String(response.status));
					}
				}, function (networkError) {
					setError(networkError.message);
				});
			}, []);

			useEffect(function () {
				refresh();
				var timer = typeof setInterval === "function" ? setInterval(refresh, 5000) : null;
				return function () { if (timer !== null) clearInterval(timer); };
			}, [refresh]);

			return h("div", { className: "am-page" },
				h("div", { className: "am-head" },
					h("h2", null, t("page.title")),
					h("div", { className: "am-spacer" }),
					h("div", { className: "am-tabs" },
						h("button", { type: "button", className: "am-tab", "data-active": tab === "mcp", onClick: function () { setTab("mcp"); } }, t("page.tab.mcp")),
						h("button", { type: "button", className: "am-tab", "data-active": tab === "skills", onClick: function () { setTab("skills"); } }, t("page.tab.skills"))
					),
					h("button", { type: "button", className: "am-btn", "data-variant": "ghost", onClick: refresh }, "⟳ " + t("page.reload"))
				),
				error === "" && state === null ? h("p", { className: "am-hint" }, t("page.loading")) : null,
				error === "" ? null : h("p", { className: "am-error", role: "alert" }, format(t("page.loadFailed"), { message: error })),
				state === null ? null : (tab === "mcp"
					? h(McpTab, { t: t, state: state, refresh: refresh })
					: h(SkillsTab, { t: t, state: state, refresh: refresh }))
			);
		}

		// ---------------------------------------------------------------------------
		// Subagents tab
		// ---------------------------------------------------------------------------

		/**
		 * Editable draft for one model candidate row inside the role modal.
		 *
		 * @param {object | undefined} model - stored candidate, when editing.
		 * @returns {{ provider: string, model: string, reasoningEffort: string, description: string }}
		 */
		function modelDraft(model) {
			return {
				provider: (model && model.provider) || "",
				model: (model && model.model) || "",
				reasoningEffort: (model && model.reasoningEffort) || "",
				description: (model && model.description) || ""
			};
		}

		/**
		 * Role edit modal: identity fields plus the ordered model-candidate
		 * list, and the per-role MCP/skill capability selection. Saving
		 * validates client-side, then lets the Host re-validate and persist
		 * through /subagents/save.
		 */
		function RoleModal(props) {
			var t = props.t;
			var editing = props.name !== undefined && props.name !== "";
			/** Capabilities page data: enabled MCP servers + installed skills. */
			var capState = props.capabilities || {};
			var mcpChoices = (capState.servers ? Object.keys(capState.servers).filter(function (name) { return capState.servers[name].enabled !== false; }).sort() : []);
			var skillChoices = capState.skills || [];
			var name = useState(editing ? props.name : "");
			var setName = name[1];
			name = name[0];
			/** null = follow the calling session's selection; true = custom whitelist. */
			var capsCustom = useState(props.role && (props.role.mcp !== undefined || props.role.skills !== undefined) ? true : false);
			var setCapsCustom = capsCustom[1];
			capsCustom = capsCustom[0];
			var capsMcp = useState(props.role && Array.isArray(props.role.mcp) ? props.role.mcp.slice() : []);
			var setCapsMcp = capsMcp[1];
			capsMcp = capsMcp[0];
			var capsSkills = useState(props.role && Array.isArray(props.role.skills) ? props.role.skills.slice() : []);
			var setCapsSkills = capsSkills[1];
			capsSkills = capsSkills[0];
			var description = useState(props.role ? props.role.description : "");
			var setDescription = description[1];
			description = description[0];
			var promptPrefix = useState(props.role && props.role.promptPrefix ? props.role.promptPrefix : "");
			var setPromptPrefix = promptPrefix[1];
			promptPrefix = promptPrefix[0];
			var preset = useState(props.role && props.role.preset ? props.role.preset : "");
			var setPreset = preset[1];
			preset = preset[0];
			var maxTokens = useState(props.role && props.role.maxTokens !== undefined ? String(props.role.maxTokens) : "");
			var setMaxTokens = maxTokens[1];
			maxTokens = maxTokens[0];
			var enabled = useState(props.role ? props.role.enabled !== false : true);
			var setEnabled = enabled[1];
			enabled = enabled[0];
			var openPool = useState(props.role ? props.role.openPool === true : false);
			var setOpenPool = openPool[1];
			openPool = openPool[0];
			var decisionType = useState(props.role && props.role.decision ? props.role.decision.type : "local");
			var setDecisionType = decisionType[1]; decisionType = decisionType[0];
			var decisionURL = useState(props.role && props.role.decision ? props.role.decision.baseURL : "");
			var setDecisionURL = decisionURL[1]; decisionURL = decisionURL[0];
			var decisionModelId = useState(props.role && props.role.decision ? props.role.decision.model : "");
			var setDecisionModelId = decisionModelId[1]; decisionModelId = decisionModelId[0];
			var decisionKey = useState(props.role && props.role.decision && props.role.decision.apiKey ? props.role.decision.apiKey : "");
			var setDecisionKey = decisionKey[1]; decisionKey = decisionKey[0];
			var models = useState(props.role && props.role.models ? props.role.models.map(modelDraft) : [modelDraft()]);
			var setModels = models[1];
			models = models[0];
			var error = useState("");
			var setError = error[1];
			error = error[0];
			/** Hover card payload: { top, left, text } or null. Fixed-positioned, so
			 *  it never touches the scroll container's layout. */
			var hoverInfo = useState(null);
			var setHoverInfo = hoverInfo[1];
			hoverInfo = hoverInfo[0];
			var busy = useState(false);
			var setBusy = busy[1];
			busy = busy[0];

			/** Patch one candidate row; empty index appends. */
			function patchModel(index, patch) {
				setModels(models.map(function (row, position) {
					return position === index ? Object.assign({}, row, patch) : row;
				}));
			}

			function removeModel(index) {
				setModels(models.filter(function (_row, position) { return position !== index; }));
			}

			/** Move one candidate row up/down by delta, clamped to the list bounds. */
			function moveModel(index, delta) {
				var target = index + delta;
				if (target < 0 || target >= models.length) return;
				var next = models.slice();
				var moved = next.splice(index, 1)[0];
				next.splice(target, 0, moved);
				setModels(next);
			}

			function save() {
				var trimmedName = name.trim();
				if (description.trim() === "") {
					setError(t("subagents.needDescription"));
					return;
				}
				var cleaned = models.filter(function (row) { return row.provider.trim() !== "" && row.model.trim() !== ""; });
				// Built-in roles ship without candidates on purpose (the child
				// inherits the calling session's model), so an empty list stays
				// saveable when customizing one; every other role needs ≥ 1.
				if (cleaned.length === 0 && props.builtin !== true) {
					setError(t("subagents.needModels"));
					return;
				}
				/** @type {object} */
				var role = {
					description: description.trim(),
					enabled: enabled === true,
					models: cleaned.map(function (row) {
						/** @type {object} */
						var candidate = { provider: row.provider.trim(), model: row.model.trim() };
						if (row.reasoningEffort.trim() !== "") candidate.reasoningEffort = row.reasoningEffort.trim();
						if (row.description.trim() !== "") candidate.description = row.description.trim();
						return candidate;
					})
				};
				if (promptPrefix.trim() !== "") role.promptPrefix = promptPrefix;
				if (preset.trim() !== "") role.preset = preset.trim();
				if (openPool) role.openPool = true;
				if (decisionType === "remote" && decisionURL.trim() !== "" && decisionModelId.trim() !== "") {
					/** @type {object} */
					const decision = { type: "remote", baseURL: decisionURL.trim(), model: decisionModelId.trim() };
					if (decisionKey.trim() !== "") decision.apiKey = decisionKey.trim();
					role.decision = decision;
				}
				if (maxTokens.trim() !== "") {
					var parsedTokens = Number(maxTokens.trim());
					if (!Number.isInteger(parsedTokens) || parsedTokens < 1) {
						setError(t("subagents.needMaxTokens"));
						return;
					}
					role.maxTokens = parsedTokens;
				}
				// Per-role capability whitelist: only written when the user
				// chose a custom selection; "follow the session" stays absent
				// (null semantics on the Host side).
				if (capsCustom === true) {
					role.mcp = capsMcp.slice();
					role.skills = capsSkills.slice();
				}
				setBusy(true);
				api.saveRole(editing ? props.name : trimmedName, role).then(function (response) {
					setBusy(false);
					if (response.ok) props.onDone();
					else setError((response.body && response.body.error) || String(response.status));
				}, function (networkError) {
					setBusy(false);
					setError(networkError.message);
				});
			}

			/** Provider options: the catalog plus whatever any row already names. */
			function providerOptions() {
				var seen = {};
				var out = [];
				(props.catalog || []).forEach(function (provider) {
					if (seen[provider.id] === undefined) {
						seen[provider.id] = true;
						out.push({ value: provider.id, label: provider.id, desc: provider.name !== provider.id ? provider.name : null });
					}
				});
				models.forEach(function (row) {
					if (row.provider !== "" && seen[row.provider] === undefined) {
						seen[row.provider] = true;
						out.push({ value: row.provider, label: row.provider });
					}
				});
				return out;
			}

			var providerOptionsList = providerOptions();

			/** Model options the Models settings page advertises for one provider. */
			function modelOptionsOf(providerId) {
				if (providerId === "") return [];
				for (var i2 = 0; i2 < (props.catalog || []).length; i2++) {
					if (props.catalog[i2].id === providerId) {
						return (props.catalog[i2].models || []).map(function (model) {
							return { value: model.id, label: model.id, desc: model.name !== model.id ? model.name : null, efforts: model.efforts || [] };
						});
					}
				}
				return [];
			}

			/** Reasoning-effort options advertised for one provider/model pair. */
			function effortOptionsOf(providerId, modelId) {
				var options = modelOptionsOf(providerId);
				for (var i2 = 0; i2 < options.length; i2++) {
					if (options[i2].value === modelId) {
						return options[i2].efforts.map(function (effort) { return { value: effort, label: effort }; });
					}
				}
				return [];
			}

			/** Models the Models settings page advertises for one provider (empty when unknown). */
			function modelsOfProvider(providerId) {
				if (providerId === "") return [];
				for (var i = 0; i < (props.catalog || []).length; i++) {
					if (props.catalog[i].id === providerId) return props.catalog[i].models || [];
				}
				return [];
			}

		return h(Modal, {
			title: editing ? t("subagents.edit") : t("subagents.add"),
			onClose: props.onClose,
			footer: [
				h("button", { key: "cancel", type: "button", className: "am-btn", onClick: props.onClose }, t("page.cancel")),
				h("button", { key: "save", type: "button", className: "am-btn", "data-variant": "primary", disabled: busy, onClick: save }, t("subagents.save"))
			]
		},
			h("div", { className: "am-form" },
				h(Group, { title: t("subagents.group.basic") },
					h(Field, { label: t("subagents.field.name") },
						h("input", {
							className: "am-input",
							value: editing ? props.name : name,
							disabled: editing,
							placeholder: "researcher",
							onChange: function (event) { setName(event.target.value); }
						})
					),
					h(Field, { label: t("subagents.field.description") },
						h("input", { className: "am-input", value: description, onChange: function (event) { setDescription(event.target.value); } })
					),
					h("div", { className: "am-row" },
						h(Field, { label: t("subagents.field.preset") },
							h("input", { className: "am-input", value: preset, onChange: function (event) { setPreset(event.target.value); } })
						),
						h(Field, { label: t("subagents.field.maxTokens") },
							h("input", { className: "am-input", inputMode: "numeric", value: maxTokens, onChange: function (event) { setMaxTokens(event.target.value); } })
						)
					),
					h(Field, { label: t("subagents.field.promptPrefix") },
						h("textarea", { className: "am-textarea", style: { minHeight: "72px" }, value: promptPrefix, onChange: function (event) { setPromptPrefix(event.target.value); } })
					),
					h("label", { className: "am-check" },
						h("input", { type: "checkbox", checked: enabled, onChange: function (event) { setEnabled(event.target.checked); } }),
						h("span", null, t("subagents.field.enabled"))
					)
				),
				h(Group, { title: t("subagents.role.decision") },
					h(AmSelect, {
						value: decisionType,
						options: [
							{ value: "local", label: t("subagents.role.decision.local") },
							{ value: "remote", label: t("subagents.role.decision.remote") }
						],
						onChange: setDecisionType
					}),
					decisionType === "remote" ? h("div", { className: "am-form" },
						h(Field, { label: t("subagents.role.decision.baseURL") },
							h("input", { className: "am-input", placeholder: "http://127.0.0.1:8000/v1", value: decisionURL, onChange: function (event) { setDecisionURL(event.target.value); } })
						),
						h("div", { className: "am-row" },
							h("input", { className: "am-input", placeholder: t("subagents.role.decision.modelId"), value: decisionModelId, onChange: function (event) { setDecisionModelId(event.target.value); } }),
							h("input", { className: "am-input", type: "password", placeholder: t("subagents.role.decision.apiKey"), value: decisionKey, onChange: function (event) { setDecisionKey(event.target.value); } })
						),
						h("p", { className: "am-hint", style: { margin: 0 } }, t("subagents.role.decision.hint"))
					) : null
				),
				h(Group, { title: t("subagents.models") },
					h("p", { className: "am-hint", style: { margin: 0 } }, t("subagents.models.hint")),
					props.builtin === true ? h("p", { className: "am-hint", style: { margin: 0 } }, t("subagents.builtin.modelsHint")) : null,
					models.map(function (row, index) {
						var modelOptions = modelOptionsOf(row.provider);
						return h("div", { key: String(index), className: "am-model-card" },
							h("div", { className: "am-model-head" },
								h("span", { className: "am-model-index" }, String(index + 1)),
								h(AmSelect, {
									value: row.provider,
									options: providerOptionsList,
									placeholder: t("subagents.model.provider"),
									onChange: function (next) { patchModel(index, next === row.provider ? {} : { provider: next, model: "", reasoningEffort: "" }); }
								}),
								h("button", { type: "button", className: "am-kv-del", title: t("subagents.role.up"), disabled: index === 0, onClick: function () { moveModel(index, -1); } }, "\u2191"),
								h("button", { type: "button", className: "am-kv-del", title: t("subagents.role.down"), disabled: index === models.length - 1, onClick: function () { moveModel(index, 1); } }, "\u2193"),
								h("button", { type: "button", className: "am-kv-del", title: t("subagents.model.remove"), onClick: function () { removeModel(index); } }, "✕")
							),
							h("div", { className: "am-kv-row" },
								h(AmSelect, {
									value: row.model,
									options: modelOptions,
									placeholder: t("subagents.model.id"),
									allowCustom: true,
									onChange: function (next) { patchModel(index, next === row.model ? {} : { model: next, reasoningEffort: "" }); }
								}),
								h(AmSelect, {
									value: row.reasoningEffort,
									options: effortOptionsOf(row.provider, row.model),
									placeholder: t("subagents.model.effort"),
									onChange: function (next) { patchModel(index, { reasoningEffort: next }); }
								})
							),
							h("input", { className: "am-input", placeholder: t("subagents.model.description"), value: row.description, onChange: function (event) { patchModel(index, { description: event.target.value }); } })
						);
					}),
					models.length === 0 ? h("button", { type: "button", className: "am-btn", "data-size": "sm", onClick: function () { setModels(models.concat([modelDraft()])); } }, "+ " + t("subagents.model.add")) : h("button", { type: "button", className: "am-btn", "data-variant": "ghost", "data-size": "sm", title: t("subagents.model.add"), onClick: function () { setModels(models.concat([modelDraft()])); } }, "+"),
					h("label", { className: "am-check" },
						h("input", { type: "checkbox", checked: openPool, onChange: function (event) { setOpenPool(event.target.checked); } }),
						h("span", null, t("subagents.role.openPool"))
					),
					openPool ? h("p", { className: "am-hint", style: { margin: 0 } }, t("subagents.role.openPoolHint")) : null
				),
				// Per-role capability whitelist: the MCP servers and skills
				// this role's children may use. Default follows the delegating
				// session's composer selection; a custom whitelist pins it.
				h(Group, { title: t("subagents.role.caps") },
					h("p", { className: "am-hint", style: { margin: 0 } }, t("subagents.role.caps.hint")),
					h("div", { className: "am-row" },
						h("button", {
							type: "button", className: "am-btn", "data-size": "sm", "data-variant": capsCustom === true ? "ghost" : "primary",
							onClick: function () { setCapsCustom(false); }
						}, t("subagents.role.caps.follow")),
						h("button", {
							type: "button", className: "am-btn", "data-size": "sm", "data-variant": capsCustom === true ? "primary" : "ghost",
							onClick: function () { setCapsCustom(true); }
						}, t("subagents.role.caps.custom"))
					),
					capsCustom === true ? [
						h("div", { key: "mcp", className: "am-form" },
							h("div", { className: "am-row" },
								h("span", { className: "am-group-title" }, t("subagents.role.caps.mcp"),
									h("span", { className: "am-badge" }, format(t("subagents.role.caps.count"), { n: capsMcp.length, t: mcpChoices.length }))
								),
								h("span", { className: "am-spacer" }),
								h("button", { type: "button", className: "am-btn", "data-size": "sm", "data-variant": "ghost", disabled: mcpChoices.length === 0, onClick: function () { setCapsMcp(mcpChoices.slice()); } }, t("subagents.role.caps.all")),
								h("button", { type: "button", className: "am-btn", "data-size": "sm", "data-variant": "ghost", disabled: mcpChoices.length === 0, onClick: function () { setCapsMcp([]); } }, t("subagents.role.caps.none"))
							),
							mcpChoices.length === 0 ? h("p", { className: "am-hint", style: { margin: 0 } }, t("subagents.role.caps.emptyMcp")) : h("div", { className: "am-pop-group" },
								mcpChoices.map(function (name) {
									return h("label", { key: name, className: "am-pop-row" },
										h("input", {
											type: "checkbox", checked: capsMcp.indexOf(name) >= 0,
											onChange: function (event) {
												setCapsMcp(event.target.checked ? capsMcp.concat([name]) : capsMcp.filter(function (item) { return item !== name; }));
											}
										}),
										h("span", { className: "am-pop-row-name", style: { maxWidth: "none", flex: "1" } }, name)
									);
								})
							)
						),
						h("div", { key: "skills", className: "am-form" },
							h("div", { className: "am-row" },
								h("span", { className: "am-group-title" }, t("subagents.role.caps.skills"),
									h("span", { className: "am-badge" }, format(t("subagents.role.caps.count"), { n: capsSkills.length, t: skillChoices.length }))
								),
								h("span", { className: "am-spacer" }),
								h("button", { type: "button", className: "am-btn", "data-size": "sm", "data-variant": "ghost", disabled: skillChoices.length === 0, onClick: function () { setCapsSkills(skillChoices.map(function (skill) { return skill.name; })); } }, t("subagents.role.caps.all")),
								h("button", { type: "button", className: "am-btn", "data-size": "sm", "data-variant": "ghost", disabled: skillChoices.length === 0, onClick: function () { setCapsSkills([]); } }, t("subagents.role.caps.none"))
							),
							skillChoices.length === 0 ? h("p", { className: "am-hint", style: { margin: 0 } }, t("subagents.role.caps.emptySkills")) : h("div", { className: "am-pop-group" },
								skillChoices.map(function (skill) {
									return h("label", { key: skill.dir, className: "am-pop-row" },
										h("input", {
											type: "checkbox", checked: capsSkills.indexOf(skill.name) >= 0,
											onChange: function (event) {
												setCapsSkills(event.target.checked ? capsSkills.concat([skill.name]) : capsSkills.filter(function (item) { return item !== skill.name; }));
											}
										}),
										h("span", { className: "am-pop-row-name", title: skill.description || skill.name, style: { maxWidth: "none", flex: "1" } }, skill.name),
										h("span", { className: "am-pop-desc", title: skill.description || "" }, skill.description || "")
									);
								})
							)
						)
					] : null
				)
			),
			error === "" ? null : h("p", { className: "am-error", role: "alert" }, error)
		);
		}



		// ---------------------------------------------------------------------------
		// Auto-retry page
		// ---------------------------------------------------------------------------

		/** Format milliseconds compactly for humans. */
		function formatWait(ms) {
			if (ms === null || ms === undefined || !isFinite(ms)) return "—";
			var s = Math.round(ms / 100) / 10;
			if (s < 60) return s + "s";
			var m = Math.round(s / 60);
			if (m < 60) return m + "m";
			var h = Math.round(m / 60 * 10) / 10;
			if (h < 48) return h + "h";
			return Math.round(h / 24) + "d";
		}

		/** Format an epoch ms timestamp as local HH:mm or MM-dd HH:mm. */
		function formatAt(atMs) {
			if (atMs === null || atMs === undefined || !isFinite(atMs)) return "—";
			var d = new Date(atMs);
			var pad = function (n) { return n < 10 ? "0" + n : String(n); };
			var time = pad(d.getHours()) + ":" + pad(d.getMinutes());
			var today = new Date();
			if (d.toDateString() === today.toDateString()) return time;
			return (d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + time;
		}

		/** Summarize one provider policy for the card line. */
		function policySummary(t, policy) {
			if (policy === null || policy === undefined) return t("retry.policy.notEditable");
			var lines = [];
			if (policy.mode === "always") {
				lines.push(t("retry.policy.infinite"));
			} else {
				lines.push(format(t("retry.policy.retries"), { n: policy.maxRetries ?? 5 }));
			}
			var init = policy.backoff?.initialDelayMs ?? 500;
			var max = policy.backoff?.maxDelayMs ?? 10000;
			var jitter = Math.round((policy.backoff?.jitterRatio ?? 0.1) * 100);
			lines.push(format(t("retry.policy.backoff"), { a: init, b: max, j: jitter }));
			if (policy.retryableCodes !== undefined && policy.retryableCodes !== null) {
				lines.push(format(t("retry.policy.codes"), { codes: policy.retryableCodes.join(", ") }));
			}
			return lines.join(" · ");
		}

		/** Policy editor modal: mode segment, retries, codes, backoff, presets. */
		function PolicyModal(props) {
			var t = props.t;
			var policy = props.policy || {};
			var mode = useState(policy.mode === "always" ? "always" : "normal");
			var setMode = mode[1]; mode = mode[0];
			var maxRetries = useState(String(policy.maxRetries ?? 5));
			var setMaxRetries = maxRetries[1]; maxRetries = maxRetries[0];
			var codes = useState(((policy.retryableCodes) || ["EMPTY_RESPONSE", "RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT"]).join(", "));
			var setCodes = codes[1]; codes = codes[0];
			var init = useState(String(policy.backoff?.initialDelayMs ?? 500));
			var setInit = init[1]; init = init[0];
			var maxDelay = useState(String(policy.backoff?.maxDelayMs ?? 10000));
			var setMaxDelay = maxDelay[1]; maxDelay = maxDelay[0];
			var jitter = useState(String(policy.backoff?.jitterRatio ?? 0.1));
			var setJitter = jitter[1]; jitter = jitter[0];
			var busy = useState(false);
			var setBusy = busy[1]; busy = busy[0];
			var error = useState("");
			var setError = error[1]; error = error[0];

			function applyPreset(kind) {
				if (kind === "default") {
					setMode("normal"); setMaxRetries("5"); setCodes("EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT");
					setInit("500"); setMaxDelay("10000"); setJitter("0.1");
				} else if (kind === "429") {
					setMode("normal"); setMaxRetries("8"); setCodes("EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT");
					setInit("1000"); setMaxDelay("60000"); setJitter("0.2");
				} else if (kind === "long") {
					setMode("normal"); setMaxRetries("10"); setCodes("EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT, QUOTA");
					setInit("5000"); setMaxDelay("21600000"); setJitter("0.1");
				} else if (kind === "always") {
					setMode("always"); setInit("1000"); setMaxDelay("30000"); setJitter("0.2");
				}
			}

			function save() {
				var value = { mode: mode };
				if (mode === "normal") {
					var retries = Number(maxRetries);
					if (!Number.isInteger(retries) || retries < 0) { setError(t("retry.policy.maxRetries")); return; }
					value.maxRetries = retries;
					var codeList = codes.split(",").map(function (c) { return c.trim(); }).filter(function (c) { return c !== ""; });
					if (codeList.length === 0) { setError(t("retry.policy.retryableCodes")); return; }
					value.retryableCodes = codeList;
				}
				var i = Number(init), m = Number(maxDelay), j = Number(jitter);
				if (!isFinite(i) || i <= 0 || !isFinite(m) || m <= 0 || i > m) { setError(t("retry.policy.backoffInit")); return; }
				if (!isFinite(j) || j < 0 || j > 1) { setError(t("retry.policy.backoffJitter")); return; }
				value.backoff = { initialDelayMs: i, maxDelayMs: m, jitterRatio: j };
				setError("");
				setBusy(true);
				props.onSave(value).then(function () { setBusy(false); }, function (message) {
					setBusy(false);
					setError(message || "save failed");
				});
			}

		return h(Modal, {
			title: props.provider + " · " + t("retry.policy.edit"),
			onClose: props.onClose,
			footer: [
				h("button", { key: "cancel", type: "button", className: "am-btn", onClick: props.onClose }, t("page.cancel")),
				h("button", { key: "save", type: "button", className: "am-btn", "data-variant": "primary", disabled: busy, onClick: save }, busy ? t("skills.saving") : t("mcp.save"))
			]
		},
			h("div", { className: "am-form" },
				h(Group, { title: t("retry.policy.group.presets") },
					h("div", { className: "am-inline-form" },
						h("button", { type: "button", className: "am-btn", "data-size": "sm", onClick: function () { applyPreset("default"); } }, t("retry.policy.presetDefault")),
						h("button", { type: "button", className: "am-btn", "data-size": "sm", onClick: function () { applyPreset("429"); } }, t("retry.policy.preset429")),
						h("button", { type: "button", className: "am-btn", "data-size": "sm", onClick: function () { applyPreset("long"); } }, t("retry.policy.presetLong")),
						h("button", { type: "button", className: "am-btn", "data-size": "sm", onClick: function () { applyPreset("always"); } }, t("retry.policy.presetAlways"))
					)
				),
				h(Field, { label: t("retry.policy.mode"), help: t("retry.policy.mode.help") },
					h("div", { className: "am-tabs" },
						h("button", { type: "button", className: "am-tab", "data-active": mode === "normal", onClick: function () { setMode("normal"); } }, t("retry.policy.normal")),
						h("button", { type: "button", className: "am-tab", "data-active": mode === "always", onClick: function () { setMode("always"); } }, t("retry.policy.always"))
					)
				),
				mode === "normal" ? h(Field, { label: t("retry.policy.maxRetries"), help: t("retry.policy.maxRetries.help") },
					h("input", { className: "am-input", value: maxRetries, onChange: function (e) { setMaxRetries(e.target.value); } })
				) : null,
				mode === "normal" ? h(Field, { label: t("retry.policy.retryableCodes"), help: t("retry.policy.retryableCodes.help") },
					h("input", { className: "am-input", value: codes, onChange: function (e) { setCodes(e.target.value); } })
				) : null,
				h(Group, { title: t("retry.policy.group.backoff") },
					h("div", { className: "am-row" },
						h(Field, { label: t("retry.policy.backoffInit"), help: t("retry.policy.backoffInit.help") },
							h("input", { className: "am-input", value: init, onChange: function (e) { setInit(e.target.value); } })
						),
						h(Field, { label: t("retry.policy.backoffMax"), help: t("retry.policy.backoffMax.help") },
							h("input", { className: "am-input", value: maxDelay, onChange: function (e) { setMaxDelay(e.target.value); } })
						),
						h(Field, { label: t("retry.policy.backoffJitter"), help: t("retry.policy.backoffJitter.help") },
							h("input", { className: "am-input", value: jitter, onChange: function (e) { setJitter(e.target.value); } })
						)
					)
				),
				mode === "always" ? h("p", { className: "am-hint", role: "alert" }, "⚠ " + t("retry.policy.alwaysWarn")) : null,
				error === "" ? null : h("p", { className: "am-error", role: "alert" }, error)
			)
		);
		}

		/** Rule editor modal with an embedded tester. */
		function RuleModal(props) {
			var t = props.t;
			var rule = props.rule || {};
			var name = useState(rule.name || "");
			var setName = name[1]; name = name[0];
			var when = useState(rule.when || "");
			var setWhen = when[1]; when = when[0];
			var flags = useState(rule.flags || "i");
			var setFlags = flags[1]; flags = flags[0];
			var providers = useState((rule.providers || []).join(", "));
			var setProviders = providers[1]; providers = providers[0];
			var codes = useState((rule.codes || []).join(", "));
			var setCodes = codes[1]; codes = codes[0];
			var waitKind = useState(rule.wait?.kind || "retry-after");
			var setWaitKind = waitKind[1]; waitKind = waitKind[0];
			var tz = useState(rule.wait?.tz || "+08:00");
			var setTz = tz[1]; tz = tz[0];
			var defaultMs = useState(String(rule.wait?.defaultMs ?? 15000));
			var setDefaultMs = defaultMs[1]; defaultMs = defaultMs[0];
			var fixedMs = useState(String(rule.wait?.ms ?? 60000));
			var setFixedMs = fixedMs[1]; fixedMs = fixedMs[0];
			var group = useState(String(rule.wait?.group ?? ""));
			var setGroup = group[1]; group = group[0];
			var maxRetries = useState(String(rule.maxRetries ?? 5));
			var setMaxRetries = maxRetries[1]; maxRetries = maxRetries[0];
			var clampMs = useState(String(rule.clampMs ?? ""));
			var setClampMs = clampMs[1]; clampMs = clampMs[0];
			var enabled = useState(rule.enabled !== false);
			var setEnabled = enabled[1]; enabled = enabled[0];
			var testText = useState(props.sample || "");
			var setTestText = testText[1]; testText = testText[0];
			var testResult = useState(null);
			var setTestResult = testResult[1]; testResult = testResult[0];
			var busy = useState(false);
			var setBusy = busy[1]; busy = busy[0];
			var error = useState("");
			var setError = error[1]; error = error[0];

			var WAIT_KINDS_UI = ["retry-after", "fixed", "duration-text", "duration-cn", "reset-at", "unix-seconds", "epoch-json", "clock-time"];

			function buildRule() {
				var value = {
					name: name.trim(),
					when: when,
					flags: flags.trim() === "" ? "i" : flags.trim(),
					enabled: enabled,
					wait: { kind: waitKind },
				};
				var providerList = providers.split(",").map(function (p) { return p.trim(); }).filter(function (p) { return p !== ""; });
				if (providerList.length > 0) value.providers = providerList;
				var codeList = codes.split(",").map(function (c) { return c.trim(); }).filter(function (c) { return c !== ""; });
				if (codeList.length > 0) value.codes = codeList;
				if (waitKind === "retry-after" && defaultMs.trim() !== "") value.wait.defaultMs = Number(defaultMs);
				if (waitKind === "fixed" && fixedMs.trim() !== "") value.wait.ms = Number(fixedMs);
				if (waitKind === "reset-at" && tz.trim() !== "") value.wait.tz = tz.trim();
				if (waitKind !== "retry-after" && waitKind !== "fixed" && group.trim() !== "") value.wait.group = Number(group);
				var retries = Number(maxRetries);
				if (Number.isInteger(retries) && retries >= 0) value.maxRetries = retries;
				if (clampMs.trim() !== "") {
					var clamp = Number(clampMs);
					if (Number.isInteger(clamp) && clamp >= 1000) value.clampMs = clamp;
				}
				return value;
			}

			function runTest() {
				var value = buildRule();
				setError("");
				api.testRetryRule(value, testText).then(function (response) {
					if (response.ok) {
						setTestResult(response.body.outcome);
						return;
					}
					setTestResult(null);
					setError((response.body && response.body.error) || String(response.status));
				}, function (networkError) {
					setTestResult(null);
					setError(networkError.message);
				});
			}

			function save() {
				var value = buildRule();
				if (value.name === "") { setError(t("retry.rules.field.name")); return; }
				setError("");
				setBusy(true);
				props.onSave(value).then(function () { setBusy(false); }, function (message) {
					setBusy(false);
					setError(message || "save failed");
				});
			}

			var outcomeView = null;
			if (testResult !== null) {
				if (testResult.matched === true) {
					outcomeView = testResult.waitMs === null || testResult.waitMs === undefined
						? h("p", { className: "am-hint" }, "⚠ " + t("retry.rules.noWait"))
						: h("p", { className: "am-hint" }, "✓ " + format(t("retry.rules.matched"), {
							wait: formatWait(testResult.waitMs),
							at: formatAt(Date.now() + testResult.waitMs),
						}));
				} else {
					outcomeView = h("p", { className: "am-hint" }, "✗ " + format(t("retry.rules.missed"), { reason: testResult.reason || "?" }));
				}
			}

		return h(Modal, {
			title: props.rule === undefined ? t("retry.rules.newRule") : t("retry.rules.editRule"),
			onClose: props.onClose,
			size: "wide",
			footer: [
				h("button", { key: "cancel", type: "button", className: "am-btn", onClick: props.onClose }, t("page.cancel")),
				h("button", { key: "save", type: "button", className: "am-btn", "data-variant": "primary", disabled: busy, onClick: save }, busy ? t("skills.saving") : t("retry.rules.save"))
			]
		},
			h("div", { className: "am-form" },
				h(Group, { title: t("retry.rules.group.basic") },
					h("div", { className: "am-row" },
						h(Field, { label: t("retry.rules.field.name"), help: t("retry.rules.field.name.help") },
							h("input", { className: "am-input", value: name, onChange: function (e) { setName(e.target.value); } })
						),
						h(Field, { label: t("retry.rules.field.flags"), help: t("retry.rules.field.flags.help") },
							h("input", { className: "am-input", value: flags, onChange: function (e) { setFlags(e.target.value); } })
						)
					),
					h(Field, { label: t("retry.rules.field.when"), help: t("retry.rules.field.when.help") },
						h("textarea", { className: "am-textarea", style: { minHeight: "60px" }, value: when, onChange: function (e) { setWhen(e.target.value); } })
					)
				),
				h(Group, { title: t("retry.rules.group.match") },
					h("div", { className: "am-row" },
						h(Field, { label: t("retry.rules.field.providers"), help: t("retry.rules.field.providers.help") },
							h("input", { className: "am-input", value: providers, onChange: function (e) { setProviders(e.target.value); } })
						),
						h(Field, { label: t("retry.rules.field.codes"), help: t("retry.rules.field.codes.help") },
							h("input", { className: "am-input", value: codes, onChange: function (e) { setCodes(e.target.value); } })
						)
					)
				),
				h(Group, { title: t("retry.rules.group.wait") },
					h("div", { className: "am-row" },
						h(Field, { label: t("retry.rules.field.waitKind"), help: t("retry.rules.field.waitKind.help") },
							h(AmSelect, {
								value: waitKind,
								options: WAIT_KINDS_UI.map(function (kind) {
									return { value: kind, label: t("retry.rules.wait." + kind) };
								}),
								onChange: setWaitKind
							})
						),
						waitKind === "reset-at" ? h(Field, { label: t("retry.rules.field.tz"), help: t("retry.rules.field.tz.help") },
							h("input", { className: "am-input", value: tz, onChange: function (e) { setTz(e.target.value); } })
						) : null,
						waitKind === "retry-after" ? h(Field, { label: t("retry.rules.field.defaultMs"), help: t("retry.rules.field.defaultMs.help") },
							h("input", { className: "am-input", value: defaultMs, onChange: function (e) { setDefaultMs(e.target.value); } })
						) : null,
						waitKind === "fixed" ? h(Field, { label: t("retry.rules.field.fixedMs"), help: t("retry.rules.field.fixedMs.help") },
							h("input", { className: "am-input", value: fixedMs, onChange: function (e) { setFixedMs(e.target.value); } })
						) : null,
						waitKind !== "retry-after" && waitKind !== "fixed" ? h(Field, { label: t("retry.rules.field.group"), help: t("retry.rules.field.group.help") },
							h("input", { className: "am-input", value: group, onChange: function (e) { setGroup(e.target.value); } })
						) : null
					)
				),
				h(Group, { title: t("retry.rules.group.limits") },
					h("div", { className: "am-row" },
						h(Field, { label: t("retry.rules.field.maxRetries"), help: t("retry.rules.field.maxRetries.help") },
							h("input", { className: "am-input", value: maxRetries, onChange: function (e) { setMaxRetries(e.target.value); } })
						),
						h(Field, { label: t("retry.rules.field.clampMs"), help: t("retry.rules.field.clampMs.help") },
							h("input", { className: "am-input", value: clampMs, onChange: function (e) { setClampMs(e.target.value); } })
						)
					),
					h("label", { className: "am-check" },
						h("input", { type: "checkbox", checked: enabled, onChange: function (e) { setEnabled(e.target.checked); } }),
						h("span", null,
							t("retry.rules.field.enabled"),
							h("span", { className: "am-label-wrap" },
								h("span", { className: "am-label-mark" }, "ⓘ"),
								h("span", { className: "am-label-help" }, t("retry.rules.field.enabled.help"))
							)
						)
					)
				)
			),
			h("div", { className: "am-tester" },
				h("div", { className: "am-toolbar" },
					h("span", { className: "am-label" }, t("retry.rules.testTitle")),
					props.sample !== undefined ? h("button", {
						type: "button", className: "am-btn", "data-size": "sm",
						onClick: function () { setTestText(props.sample); }
					}, t("retry.rules.testSample")) : null,
					h("div", { className: "am-spacer" }),
					h("button", { type: "button", className: "am-btn", "data-size": "sm", disabled: testText.trim() === "", onClick: runTest }, t("retry.rules.testRun"))
				),
				h("p", { className: "am-hint" }, t("retry.rules.testHint")),
				h("textarea", {
					className: "am-textarea", style: { minHeight: "64px" }, value: testText,
					placeholder: t("retry.rules.testText"),
					onChange: function (e) { setTestText(e.target.value); }
				}),
				outcomeView
			),
			error === "" ? null : h("p", { className: "am-error", role: "alert" }, error)
		);
		}

		/** Preset drawer modal: import built-in vendor rules in one click. */
		function PresetsModal(props) {
			var t = props.t;
			var presets = props.presets || [];
			var imported = useState("");
			var setImported = imported[1]; imported = imported[0];
			return h(Modal, {
			title: t("retry.rules.presetsTitle"),
			onClose: props.onClose,
			footer: [h("button", { key: "close", type: "button", className: "am-btn", onClick: props.onClose }, t("page.close"))]
		},
				h("p", { className: "am-hint" }, t("retry.rules.presetsHint")),
				h("div", { className: "am-list" },
					presets.map(function (preset) {
						return h("div", { key: preset.id, className: "am-card" },
							h("div", { className: "am-card-head" },
								h("span", { className: "am-card-name" }, preset.title),
								h("span", { className: "am-spacer" }),
								h("button", {
									type: "button", className: "am-btn", "data-size": "sm", "data-variant": "primary",
									onClick: function () { props.onImport(preset); }
								}, t("retry.rules.import"))
							),
							h("div", { className: "am-card-body" }, preset.description),
							preset.sample ? h("div", { className: "am-card-body", style: { fontFamily: "ui-monospace, Menlo, monospace", fontSize: "11px", whiteSpace: "pre-wrap", wordBreak: "break-all" } }, preset.sample) : null
						);
					})
				),
				imported === "" ? null : h("p", { className: "am-hint" }, "✓ " + format(t("retry.rules.importDone"), { name: imported }))
			);
		}

		/** The auto-retry settings page. */
		function RetryPage(props) {
			var t = props.t;
			var data = useState(null);
			var setData = data[1]; data = data[0];
			var error = useState("");
			var setError = error[1]; error = error[0];
			var needRestart = useState(false);
			var setNeedRestart = needRestart[1]; needRestart = needRestart[0];
			var tab = useState("policy");
			var setTab = tab[1]; tab = tab[0];
			var editingPolicy = useState(null);
			var setEditingPolicy = editingPolicy[1]; editingPolicy = editingPolicy[0];
			var editingRule = useState(null);
			var setEditingRule = editingRule[1]; editingRule = editingRule[0];
			var showingPresets = useState(false);
			var setShowingPresets = showingPresets[1]; showingPresets = showingPresets[0];
			var notice = useState("");
			var setNotice = notice[1]; notice = notice[0];
			var fallbackMs = useState("");
			var setFallbackMs = fallbackMs[1]; fallbackMs = fallbackMs[0];
			var tick = useState(0);
			var bumpTick = tick[1]; tick = tick[0];

			var load = useCallback(function () {
				api.retryState().then(function (response) {
					if (response.ok) {
						setData(response.body);
						setError("");
						setNeedRestart(false);
						setFallbackMs(String(response.body.fallback?.maxDelayMs ?? 21600000));
						return;
					}
					if (response.status === 404) { setNeedRestart(true); return; }
					setError((response.body && response.body.error) || String(response.status));
				}, function (networkError) {
					setError(networkError.message);
				});
			}, []);

			useEffect(function () {
				load();
				var timer = typeof setInterval === "function" && !needRestart ? setInterval(load, 5000) : null;
				return function () { if (timer !== null) clearInterval(timer); };
			}, [load, needRestart]);

			// Countdown refresh for active waits.
			useEffect(function () {
				var timer = typeof setInterval === "function" && !needRestart ? setInterval(function () { bumpTick(function (x) { return x + 1; }); }, 1000) : null;
				return function () { if (timer !== null) clearInterval(timer); };
			}, [needRestart]);

			function savePolicy(provider, policy) {
				return new Promise(function (resolve, reject) {
					api.saveRetryPolicy(provider, policy).then(function (response) {
						if (response.ok) {
							setData(function (prev) { return prev === null ? prev : Object.assign({}, prev, { targets: response.body.targets }); });
							setNotice(t("page.saveOk"));
							resolve();
						} else {
							reject((response.body && response.body.error) || String(response.status));
						}
					}, reject);
				});
			}

			function resetPolicy(provider) {
				if (typeof window !== "undefined" && typeof window.confirm === "function" && !window.confirm(t("retry.policy.resetConfirm"))) return;
				api.resetRetryPolicy(provider).then(function (response) {
					if (response.ok) {
						setData(function (prev) { return prev === null ? prev : Object.assign({}, prev, { targets: response.body.targets }); });
						setNotice(t("page.saveOk"));
					} else {
						setError((response.body && response.body.error) || String(response.status));
					}
				}, function (networkError) { setError(networkError.message); });
			}

			function saveRule(rule) {
				return new Promise(function (resolve, reject) {
					api.saveRetryRules([rule], false).then(function (response) {
						if (response.ok) {
							load();
							setNotice(t("page.saveOk"));
							resolve();
						} else {
							reject((response.body && response.body.error) || String(response.status));
						}
					}, reject);
				});
			}

			function importPreset(preset) {
				api.saveRetryRules([preset.rule], false).then(function (response) {
					if (response.ok) {
						setNotice(format(t("retry.rules.importDone"), { name: preset.title }));
						load();
					} else {
						setError((response.body && response.body.error) || String(response.status));
					}
				}, function (networkError) { setError(networkError.message); });
			}

			function deleteRule(name) {
				if (typeof window !== "undefined" && typeof window.confirm === "function" && !window.confirm(format(t("retry.rules.delConfirm"), { name: name }))) return;
				var kept = (data?.rules || []).filter(function (rule) { return rule.name !== name; });
				api.saveRetryRules(kept, true).then(function (response) {
					if (response.ok) { load(); setNotice(t("page.saveOk")); }
					else setError((response.body && response.body.error) || String(response.status));
				}, function (networkError) { setError(networkError.message); });
			}

			function saveFallback() {
				var value = Number(fallbackMs);
				if (!Number.isInteger(value) || value < 1000 || value > 86400000) {
					setError(t("retry.rules.fallback"));
					return;
				}
				api.saveRetryRules([], true, { maxDelayMs: value }).then(function (response) {
					if (response.ok) { setNotice(t("page.saveOk")); load(); }
					else setError((response.body && response.body.error) || String(response.status));
				}, function (networkError) { setError(networkError.message); });
			}

			var targets = (data && data.targets) || [];
			var rules = (data && data.rules) || [];
			var monitor = (data && data.monitor) || { active: [], recent: [] };
			var presets = (data && data.presets) || [];

			return h("div", { className: "am-page" },
				h("div", { className: "am-head" },
					h("h2", null, t("retry.pageTitle")),
					h("div", { className: "am-spacer" }),
					h("button", { type: "button", className: "am-btn", "data-variant": "ghost", disabled: needRestart, onClick: load }, "⟳ " + t("page.reload"))
				),
				needRestart ? h("p", { className: "am-hint", role: "alert" }, "⇢ " + t("retry.needRestart")) : null,
				h("div", { className: "am-toolbar" },
					h("div", { className: "am-tabs" },
						h("button", { type: "button", className: "am-tab", "data-active": tab === "policy", onClick: function () { setTab("policy"); } }, t("retry.tab.policy")),
						h("button", { type: "button", className: "am-tab", "data-active": tab === "rules", onClick: function () { setTab("rules"); } }, t("retry.tab.rules") + (rules.length > 0 ? " · " + rules.length : "")),
						h("button", { type: "button", className: "am-tab", "data-active": tab === "monitor", onClick: function () { setTab("monitor"); } }, t("retry.tab.monitor"))
					),
					h("div", { className: "am-spacer" }),
					notice === "" ? null : h("span", { className: "am-hint" }, notice)
				),
				error === "" ? null : h("p", { className: "am-error", role: "alert" }, error),
				!needRestart && data === null && error === "" ? h("p", { className: "am-hint" }, t("page.loading")) : null,

				tab === "policy" ? h("div", { className: "am-stack", "data-gap": "sm" },
				h("p", { className: "am-hint" }, t("retry.hint")),
				h("div", { className: "am-list" },
					targets.length === 0 && !needRestart && data !== null ? h("p", { className: "am-hint" }, t("page.loading")) : null,
					targets.map(function (target) {
						/** Vendor-label title derived from the route's model catalog. */
						var vendors = target.vendors || [];
						var title = vendors.length > 0
							? (vendors.length > 6 ? vendors.slice(0, 6).join(" · ") + " +" + (vendors.length - 6) : vendors.join(" · "))
							: (target.displayName || target.provider);
						/** The route id stays visible: rule providers filters reference it. */
						var sub = format(t("retry.policy.routeLine"), { route: target.provider });
						if (vendors.length > 0 && target.displayName !== undefined && target.displayName !== target.provider) sub += " · " + target.displayName;
						if (typeof target.modelCount === "number" && target.modelCount > 0) sub += " · " + format(t("retry.policy.models"), { n: target.modelCount });
						return h("div", { key: target.provider, className: "am-card" },
							h("div", { className: "am-card-head" },
								h("span", { className: "am-card-name" }, title),
								target.editable ? null : h("span", { className: "am-badge" }, t("retry.policy.notEditable")),
								h("span", { className: "am-spacer" }),
								h("button", { type: "button", className: "am-btn", "data-size": "sm", disabled: !target.editable, onClick: function () { setEditingPolicy(target); } }, t("retry.policy.edit")),
								h("button", { type: "button", className: "am-btn", "data-size": "sm", disabled: !target.editable, onClick: function () { resetPolicy(target.provider); } }, t("retry.policy.reset"))
							),
							h("div", { className: "am-card-body" }, policySummary(t, target.policy)),
							vendors.length > 0 ? h("div", { className: "am-card-body" }, sub) : null,
							vendors.length === 0 && target.displayName !== undefined && target.displayName !== target.provider ? h("div", { className: "am-card-body" }, target.provider) : null
						);
					})
				)
			) : null,

				tab === "rules" ? h("div", { className: "am-stack", "data-gap": "sm" },
					h("div", { className: "am-toolbar" },
						h("button", { type: "button", className: "am-btn", "data-variant": "primary", disabled: needRestart, onClick: function () { setEditingRule({}); } }, "+ " + t("retry.rules.add")),
						h("button", { type: "button", className: "am-btn", disabled: needRestart, onClick: function () { setShowingPresets(true); } }, "⬇ " + t("retry.rules.presets")),
						h("span", { className: "am-hint" }, t("retry.aiHint"))
					),
					h("div", { className: "am-toolbar" },
						h("span", { className: "am-label" }, t("retry.rules.fallback")),
						h("input", { className: "am-input", "data-size": "s", value: fallbackMs, onChange: function (e) { setFallbackMs(e.target.value); } }),
						h("button", { type: "button", className: "am-btn", "data-size": "sm", onClick: saveFallback }, t("mcp.save")),
						h("span", { className: "am-hint" }, t("retry.rules.clampHint"))
					),
					rules.length === 0 && !needRestart && data !== null ? h(Empty, {
					glyph: "\u2733", text: t("retry.rules.empty"),
					actions: [
						h("button", { key: "new", type: "button", className: "am-btn", "data-variant": "primary", onClick: function () { setEditingRule({}); } }, "+ " + t("retry.rules.add")),
						h("button", { key: "presets", type: "button", className: "am-btn", onClick: function () { setShowingPresets(true); } }, t("retry.rules.presets"))
					]
				}) : null,
					h("div", { className: "am-list" },
						rules.map(function (rule) {
							/** Friendly name for a harness failure code. */
							var codeLabel = function (code) {
								var friendly = t("retry.code." + code);
								return friendly !== "retry.code." + code ? friendly : code;
							};
							var providersLine = (rule.providers || []).length > 0
								? format(t("retry.rules.card.providers"), { p: rule.providers.join("、") })
								: t("retry.rules.card.allProviders");
							var codesLine = (rule.codes || []).length > 0
								? format(t("retry.rules.card.codes"), { c: rule.codes.map(codeLabel).join("、") })
								: t("retry.rules.card.allCodes");
							return h("div", { key: rule.name, className: "am-card" },
								h("div", { className: "am-card-head" },
									h("span", { className: "am-dot", "data-tone": rule.enabled === false ? "idle" : "ok" }),
									h("span", { className: "am-card-name" }, rule.name),
									rule.enabled === false ? h("span", { className: "am-badge" }, t("session.mcpOff")) : null,
									h("span", { className: "am-spacer" }),
									h("button", { type: "button", className: "am-btn", "data-size": "sm", onClick: function () { setEditingRule(rule); } }, t("subagents.edit")),
									h("button", { type: "button", className: "am-btn", "data-size": "sm", "data-variant": "danger", onClick: function () { deleteRule(rule.name); } }, t("retry.rules.del"))
								),
								h("div", { className: "am-card-body", style: { display: "flex", flexDirection: "column", gap: "3px" } },
									h("div", null, providersLine),
									h("div", null, codesLine),
									h("div", null,
										format(t("retry.rules.card.waitVia"), { kind: t("retry.rules.wait." + (rule.wait?.kind || "retry-after")) })
										+ (rule.maxRetries === 0
											? " · " + t("retry.rules.card.unlimited")
											: rule.maxRetries !== undefined ? " · " + format(t("retry.rules.card.budget"), { n: rule.maxRetries }) : "")
										+ (rule.clampMs !== undefined
											? " · " + format(t("retry.rules.card.clamp"), { w: formatWait(rule.clampMs) })
											: " · " + format(t("retry.rules.card.globalClamp"), { w: formatWait((data && data.fallback && data.fallback.maxDelayMs) || 21600000) }))
									)
								),
								h("div", { className: "am-regex", title: rule.when }, rule.when)
							);
						})
					)
				) : null,

				tab === "monitor" ? h("div", { className: "am-stack" },
					h("p", { className: "am-hint" }, t("retry.monitor.persistHint")),
					h("div", { className: "am-list" },
						h("div", { className: "am-card" },
							h("div", { className: "am-card-head" }, h("span", { className: "am-card-name" }, t("retry.monitor.active"))),
							monitor.active.length === 0 ? h("div", { className: "am-card-body" }, t("retry.monitor.none")) : monitor.active.map(function (entry) {
								return h("div", { key: entry.sessionId + ":" + entry.retryId, className: "am-tool-row" },
									h("span", { className: "am-tool-name" }, (entry.ruleName || entry.provider) + " · " + formatWait(entry.remainingMs)),
									h("span", { className: "am-tool-desc" }, (entry.ruleName !== undefined && entry.ruleName !== null ? t("retry.monitor.pluginRule") : t("retry.monitor.builtin")) + " · → " + formatAt((entry.time || 0) + (entry.delayMs || 0)))
								);
							})
						),
						h("div", { className: "am-card" },
							h("div", { className: "am-card-head" }, h("span", { className: "am-card-name" }, t("retry.monitor.recent"))),
							monitor.recent.length === 0 ? h("div", { className: "am-card-body" }, t("retry.monitor.noRecent")) : monitor.recent.slice(0, 30).map(function (entry) {
								/** Friendly failure-code name, falling back to the raw code. */
								var rawCode = entry.failure && entry.failure.code ? String(entry.failure.code) : "";
								var codeText = rawCode !== "" && t("retry.code." + rawCode) !== "retry.code." + rawCode ? t("retry.code." + rawCode) : rawCode;
								var countText = typeof entry.count === "number" && entry.count > 1 ? " ×" + entry.count : "";
								if (entry.kind === "failure") {
									var reasonKey = "retry.monitor.reason." + (entry.reason || "no-match");
									var reasonText = t(reasonKey);
									if (reasonText === reasonKey) reasonText = entry.reason || "";
									return h("div", { key: entry.sessionId + ":" + entry.retryId + ":" + entry.time, className: "am-tool-row" },
										h("span", { className: "am-tool-name" }, formatAt(entry.time) + " · " + (entry.provider || "?") + countText),
										h("span", { className: "am-tool-desc" },
											t("retry.monitor.failureRow") + " · " + reasonText
											+ (entry.ruleName ? " · " + entry.ruleName : "")
											+ (codeText !== "" ? " · " + codeText : ""))
									);
								}
								return h("div", { key: entry.sessionId + ":" + entry.retryId + ":" + entry.time, className: "am-tool-row" },
									h("span", { className: "am-tool-name" }, formatAt(entry.time) + " · " + (entry.ruleName || entry.provider || "?")),
									h("span", { className: "am-tool-desc" },
										(entry.retry !== null && entry.retry !== undefined ? format(t("retry.monitor.retry"), { n: entry.retry }) + " · " : "")
										+ (entry.delayMs !== null && entry.delayMs !== undefined ? formatWait(entry.delayMs) : "")
										+ (codeText !== "" ? " · " + codeText : ""))
								);
							})
						)
					)
				) : null,

				editingPolicy === null ? null : h(PolicyModal, {
					t: t,
					key: "policy:" + editingPolicy.provider,
					provider: editingPolicy.provider,
					policy: editingPolicy.policy,
					onClose: function () { setEditingPolicy(null); },
					onSave: function (policy) { return savePolicy(editingPolicy.provider, policy).then(function () { setEditingPolicy(null); }); }
				}),
				editingRule === null ? null : h(RuleModal, {
					t: t,
					key: "rule:" + (editingRule.name || "new"),
					rule: editingRule.name === undefined ? undefined : editingRule,
					sample: editingRule.sample,
					onClose: function () { setEditingRule(null); },
					onSave: function (rule) { return saveRule(rule).then(function () { setEditingRule(null); }); }
				}),
				showingPresets ? h(PresetsModal, {
					t: t,
					presets: presets,
					onClose: function () { setShowingPresets(false); },
					onImport: importPreset
				}) : null
			);
		}

		/** Create/edit modal for one global model-pool entry. */
		function PoolModelModal(props) {
			var t = props.t;
			var entry = props.entry || {};
			var provider = useState(entry.provider || "");
			var setProvider = provider[1]; provider = provider[0];
			var model = useState(entry.model || "");
			var setModel = model[1]; model = model[0];
			var name_ = useState(entry.name || "");
			var setName = name_[1]; name_ = name_[0];
			var usage = useState(entry.description || "");
			var setUsage = usage[1]; usage = usage[0];
			var effort = useState(entry.reasoningEffort || "");
			var setEffort = effort[1]; effort = effort[0];
			var enabled = useState(entry.enabled !== false);
			var setEnabled = enabled[1]; enabled = enabled[0];
			var error = useState("");
			var setError = error[1]; error = error[0];
			var busy = useState(false);
			var setBusy = busy[1]; busy = busy[0];

			var catalog = props.catalog || [];
			function providerOptions() {
				var seen = {}; var out = [];
				catalog.forEach(function (item) {
					if (seen[item.id] === undefined) { seen[item.id] = true; out.push({ value: item.id, label: item.id, desc: item.name !== item.id ? item.name : null }); }
				});
				if (provider !== "" && seen[provider] === undefined) out.push({ value: provider, label: provider });
				return out;
			}
			function modelOptions() {
				for (var i = 0; i < catalog.length; i++) {
					if (catalog[i].id === provider) return (catalog[i].models || []).map(function (m) { return { value: m.id, label: m.id, desc: m.name !== m.id ? m.name : null }; });
				}
				return model === "" ? [] : [{ value: model, label: model }];
			}
			function effortOptions() {
				for (var i = 0; i < catalog.length; i++) {
					if (catalog[i].id !== provider) continue;
					for (var j = 0; j < (catalog[i].models || []).length; j++) {
						if (catalog[i].models[j].id === model) return (catalog[i].models[j].efforts || []).map(function (e) { return { value: e, label: e }; });
					}
				}
				return [];
			}

			function save() {
				if (provider.trim() === "" || model.trim() === "") { setError(t("subagents.needModels")); return; }
				/** @type {object} */
				var payload = { provider: provider.trim(), model: model.trim(), enabled: enabled === true };
				if (name_.trim() !== "") payload.name = name_.trim();
				if (usage.trim() !== "") payload.description = usage.trim();
				if (effort !== "") payload.reasoningEffort = effort;
				setBusy(true);
				api.savePoolModel(payload).then(function (response) {
					setBusy(false);
					if (response.ok) props.onDone();
					else setError((response.body && response.body.error) || String(response.status));
				}, function (networkError) { setBusy(false); setError(networkError.message); });
			}

		return h(Modal, {
			title: props.entry === undefined ? t("subagents.pool.add") : t("subagents.edit"),
			onClose: props.onClose,
			footer: [
				h("button", { key: "cancel", type: "button", className: "am-btn", onClick: props.onClose }, t("page.cancel")),
				h("button", { key: "save", type: "button", className: "am-btn", "data-variant": "primary", disabled: busy, onClick: save }, t("subagents.save"))
			]
		},
			h("div", { className: "am-form" },
				h("div", { className: "am-row" },
					h(Field, { label: t("subagents.model.provider") },
						h(AmSelect, { value: provider, options: providerOptions(), placeholder: t("subagents.model.provider"), onChange: function (next) { if (next !== provider) { setProvider(next); setModel(""); setEffort(""); } } })
					),
					h(Field, { label: t("subagents.model.id") },
						h(AmSelect, { value: model, options: modelOptions(), placeholder: t("subagents.model.id"), allowCustom: true, onChange: function (next) { if (next !== model) { setModel(next); setEffort(""); } } })
					)
				),
				h("div", { className: "am-row" },
					h(Field, { label: t("subagents.pool.field.name") },
						h("input", { className: "am-input", value: name_, onChange: function (event) { setName(event.target.value); } })
					),
					h(Field, { label: t("subagents.pool.field.effort") },
						h(AmSelect, { value: effort, options: effortOptions(), placeholder: t("subagents.pool.field.effort"), allowCustom: true, onChange: setEffort })
					)
				),
				h(Field, { label: t("subagents.pool.field.usage") },
					h("textarea", { className: "am-textarea", style: { minHeight: "64px" }, value: usage, onChange: function (event) { setUsage(event.target.value); } })
				),
				h("label", { className: "am-check" },
					h("input", { type: "checkbox", checked: enabled, onChange: function (event) { setEnabled(event.target.checked); } }),
					h("span", null, t("subagents.pool.enabled"))
				),
				error === "" ? null : h("p", { className: "am-error", role: "alert" }, error)
			)
		);
		}

		/**
		 * Read-only export modal: the full role document as JSON for backup or
		 * migration; the textarea selects itself on focus for easy copying.
		 */
		function RolesExportModal(props) {
			var t = props.t;
			var text = JSON.stringify({ roles: props.roles || {} }, null, 2);
			return h(Modal, {
				title: t("subagents.export.title"),
				onClose: props.onClose
			},
				h("p", { className: "am-hint" }, t("subagents.export.hint")),
				h("textarea", { className: "am-textarea", style: { minHeight: "220px" }, readOnly: true, value: text, onFocus: function (event) { event.target.select(); } })
			);
		}

		/**
		 * The standalone delegation-roles settings page: page head with reload,
		 * the toolbar (add / import / export / counts / store badge), one card
		 * per role with its candidate models, and the modals. Data comes from
		 * /subagents (own 5s poll); a 404 means the running Host predates this
		 * feature and needs a full restart, which is surfaced as a hint.
		 */
		function SubagentsPage(props) {
			var t = props.t;
			var data = useState(null);
			var setData = data[1];
			data = data[0];
			var error = useState("");
			var setError = error[1];
			error = error[0];
			/** Hover card payload: { top, left, text } or null. Fixed-positioned, so
			 *  it never touches the scroll container's layout. */
			var hoverInfo = useState(null);
			var setHoverInfo = hoverInfo[1];
			hoverInfo = hoverInfo[0];
			var needRestart = useState(false);
			var setNeedRestart = needRestart[1];
			needRestart = needRestart[0];
			var catalog = useState(null);
			var setCatalog = catalog[1];
			catalog = catalog[0];
			/** @type {Array} */ var editing = useState(null);
			var setEditing = editing[1];
			editing = editing[0];
			var tab = useState("models");
			var setTab = tab[1]; tab = tab[0];
			var editingPool = useState(null);
			var setEditingPool = editingPool[1]; editingPool = editingPool[0];
			var exporting = useState(false);
			var setExporting = exporting[1];
			exporting = exporting[0];
			var notice = useState("");
			var setNotice = notice[1];
			notice = notice[0];

			var load = useCallback(function () {
				api.subagents().then(function (response) {
					if (response.ok) {
						setData(response.body);
						setError("");
						setNeedRestart(false);
						return;
					}
					if (response.status === 404) {
						setNeedRestart(true);
						return;
					}
					setError((response.body && response.body.error) || String(response.status));
				}, function (networkError) {
					setError(networkError.message);
				});
			}, []);

			useEffect(function () {
				load();
				var timer = typeof setInterval === "function" && !needRestart ? setInterval(load, 5000) : null;
				return function () { if (timer !== null) clearInterval(timer); };
			}, [load, needRestart]);

			// The provider catalog is best-effort: without it the modal keeps
			// manual provider entry (the current row value always stays an option).
			useEffect(function () {
				api.llmCatalog().then(function (response) {
					if (response.ok) setCatalog(response.body.providers || []);
				}, function () { /* manual entry remains available */ });
			}, []);

			// Auto-seed the model pool: once the catalog and the pool snapshot are
			// both in, silently import every catalog model the pool lacks (no
			// button, no prompt). The user's remaining work is filling usages.
			var seedRef = useRef(false);
			useEffect(function () {
				if (seedRef.current || catalog === null || needRestart || data === null) return;
				seedRef.current = true;
				var entries = [];
				catalog.forEach(function (provider) {
					(provider.models || []).forEach(function (model) {
						entries.push({ provider: provider.id, model: model.id, name: model.name });
					});
				});
				if (entries.length === 0) return;
				var known = {};
				(data.models || []).forEach(function (entry) { known[entry.provider + "/" + entry.model] = true; });
				var missing = entries.filter(function (entry) { return known[entry.provider + "/" + entry.model] !== true; });
				if (missing.length === 0) return;
				api.bulkPoolModels(missing).then(function (response) {
					if (response.ok && response.body.imported.length > 0) {
						setNotice(format(t("subagents.pool.importAll.done"), { n: response.body.imported.length, s: response.body.skipped.length }));
						load();
					}
				}, function () { /* auto-seed is best-effort */ });
			}, [catalog, data, needRestart]);

			function removeRole(name) {
				api.deleteRole(name).then(function (response) {
					if (response.ok) load();
					else setError((response.body && response.body.error) || String(response.status));
				}, function (networkError) {
					setError(networkError.message);
				});
			}


			var roles = (data && data.roles) || {};
			var pool = (data && data.models) || [];
			var roleNames = Object.keys(roles);
			var modelCount = roleNames.reduce(function (total, nameKey) {
				return total + (roles[nameKey].models ? roles[nameKey].models.length : 0);
			}, 0);
			// Built-in role states from the host: name → default | customized | hidden.
			var builtinInfo = (data && data.builtin) || {};
			var hiddenBuiltins = Object.keys(builtinInfo).filter(function (nameKey) { return builtinInfo[nameKey] === "hidden"; });
			// Export only user-authored content: a pure (uncustomized) builtin
			// carries nothing of the user's, and re-importing it elsewhere would
			// just pin today's shipped definition as a customization.
			var exportableRoles = {};
			roleNames.forEach(function (nameKey) {
				if (builtinInfo[nameKey] === "default") return;
				exportableRoles[nameKey] = roles[nameKey];
			});

			// Capability catalog for the role editor's MCP/skill whitelist:
			// loaded best-effort alongside the roles (missing → editor shows
			// its empty states but still saves a whitelist of unknown names).
			var capsData = useState(null);
			var setCapsData = capsData[1];
			capsData = capsData[0];
			useEffect(function () {
				if (tab !== "roles" || capsData !== null) return undefined;
				var stopped = false;
				api.state().then(function (response) {
					if (!stopped && response.ok) setCapsData({ servers: response.body.servers || {}, skills: response.body.skills || [] });
				}, function () { /* best-effort; the editor degrades to empty lists */ });
				return function () { stopped = true; };
			}, [tab, capsData]);

			return h("div", { className: "am-page" },
				h("div", { className: "am-head" },
					h("h2", null, t("subagents.pageTitle")),
					h("div", { className: "am-spacer" }),
					h("button", { type: "button", className: "am-btn", "data-variant": "ghost", disabled: needRestart, onClick: load }, "⟳ " + t("page.reload"))
				),
				needRestart ? h("p", { className: "am-hint", role: "alert" }, "⇢ " + t("subagents.needRestart")) : null,
				h("div", { className: "am-toolbar" },
					h("div", { className: "am-tabs" },
					h("button", { type: "button", className: "am-tab", "data-active": tab === "models", onClick: function () { setTab("models"); } }, t("subagents.tab.models")),
					h("button", { type: "button", className: "am-tab", "data-active": tab === "roles", onClick: function () { setTab("roles"); } }, t("subagents.tab.roles"))
				),
				tab === "roles"
					? h("button", { type: "button", className: "am-btn", "data-variant": "primary", disabled: needRestart, onClick: function () { setEditing({ name: "" }); } }, "+ " + t("subagents.add"))
					: h("button", { type: "button", className: "am-btn", "data-variant": "primary", disabled: needRestart, onClick: function () { setEditingPool(null); setEditingPool({ entry: undefined }); } }, "+ " + t("subagents.pool.add")),
							h("button", { type: "button", className: "am-btn", disabled: Object.keys(exportableRoles).length === 0, onClick: function () { setExporting(true); } }, t("subagents.export")),
					h("div", { className: "am-spacer" }),
							notice === "" ? null : h("span", { className: "am-hint" }, notice),
					roleNames.length === 0 ? null : h("span", { className: "am-hint" }, format(t("subagents.count"), { r: roleNames.length, m: modelCount }))
				),
				error === "" ? null : h("p", { className: "am-error", role: "alert" }, error),
				!needRestart && data === null && error === "" ? h("p", { className: "am-hint" }, t("page.loading")) : null,
				tab === "roles" && !needRestart && data !== null && roleNames.length === 0 && error === "" ? h(Empty, { glyph: "\u25c6", text: t("subagents.empty") }) : null,
			tab === "roles" ? (
					h("div", { className: "am-list" },
						roleNames.map(function (nameKey) {
							var role = roles[nameKey];
							var enabledNow = role.enabled !== false;
							var candidateCount = role.models ? role.models.length : 0;
							var builtinState = builtinInfo[nameKey];
							return h("div", { key: nameKey, className: "am-card" },
								h("div", { className: "am-card-head" },
									h("span", { className: "am-dot", "data-tone": enabledNow ? "ok" : "idle" }),
									h("span", { className: "am-card-name" }, "delegate_" + nameKey),
									enabledNow ? null : h("span", { className: "am-badge" }, t("subagents.off")),
									builtinState === "default" ? h("span", { className: "am-badge" }, t("subagents.builtin.badge")) : null,
									builtinState === "customized" ? h("span", { className: "am-badge" }, t("subagents.builtin.customized")) : null,
									candidateCount === 0 && role.openPool === true
										? h("span", { className: "am-badge" }, t("subagents.modelPoolOpen"))
										: h("span", { className: "am-badge" }, format(t("subagents.modelCount"), { n: candidateCount })),
									role.mcp !== undefined || role.skills !== undefined ? h("span", { className: "am-badge", "data-tone": "idle" }, t("subagents.role.caps")) : null,
									h("span", { className: "am-spacer" }),
									h("button", { type: "button", className: "am-btn", "data-size": "sm", onClick: function () { setEditing({ name: nameKey }); } }, t("subagents.edit")),
									h("button", {
										type: "button", className: "am-btn", "data-size": "sm", "data-variant": "danger",
										onClick: function () {
											var confirmText = builtinState === undefined ? t("subagents.delConfirm") : t("subagents.builtin.delConfirm");
											if (typeof window !== "undefined" && typeof window.confirm === "function" && !window.confirm(confirmText)) return;
											removeRole(nameKey);
										}
									}, t("subagents.del"))
								),
								h("div", { className: "am-card-body" }, role.description),
								role.models && role.models.length > 0 ? h("div", { className: "am-tools" },
									role.models.map(function (candidate, index) {
										return h("div", { key: String(index), className: "am-tool-row" },
											h("span", { className: "am-tool-name" }, candidate.provider + "/" + candidate.model + (candidate.reasoningEffort ? " · " + candidate.reasoningEffort : "")),
											h("span", { className: "am-tool-desc" }, candidate.description || "")
										);
									})
								) : null
							);
						})
					)
				) : null,

				// Hidden built-ins: deleting one only writes a hide marker, so it
				// stays discoverable and restorable here (drop the marker → the
				// shipped definition returns, also resetting a customization).
				tab === "roles" && !needRestart && hiddenBuiltins.length > 0 ? h("div", { className: "am-list" },
					h("div", { className: "am-group-title" }, t("subagents.builtin.hiddenTitle")),
					hiddenBuiltins.map(function (nameKey) {
						return h("div", { key: nameKey, className: "am-card" },
							h("div", { className: "am-card-head" },
								h("span", { className: "am-dot", "data-tone": "idle" }),
								h("span", { className: "am-card-name" }, "delegate_" + nameKey),
								h("span", { className: "am-badge" }, t("subagents.builtin.badge")),
								h("span", { className: "am-spacer" }),
								h("button", {
									type: "button", className: "am-btn", "data-size": "sm",
									onClick: function () {
										api.restoreRole(nameKey).then(function (response) {
											if (response.ok) load();
											else setError((response.body && response.body.error) || String(response.status));
										}, function (networkError) { setError(networkError.message); });
									}
								}, t("subagents.builtin.restore"))
							)
						);
					})
				) : null,

			tab === "models" ? h("div", { className: "am-list" },
				pool.length === 0 ? h(Empty, { glyph: "\u25c6", text: t("subagents.pool.empty") }) : null,
				Object.entries(pool.reduce(function (groups, entry) {
					(groups[entry.provider] = groups[entry.provider] || []).push(entry);
					return groups;
				}, {})).map(function (group) {
					var providerId = group[0];
					var providerName = providerId;
					for (var i = 0; i < (catalog || []).length; i++) {
						if (catalog[i].id === providerId) { providerName = catalog[i].name || providerId; break; }
					}
					return h("div", { key: providerId, style: { display: "flex", flexDirection: "column", gap: "6px" } },
						h("div", { className: "am-group-title" },
							providerName,
							h("span", { className: "am-badge" }, String(group[1].length))
						),
						group[1].map(function (entry) {
							var key = entry.provider + "/" + entry.model;
							return h("div", { key: key, className: "am-card" },
								h("div", { className: "am-card-head" },
									h("span", { className: "am-dot", "data-tone": entry.enabled === false ? "idle" : "ok" }),
									h("span", { className: "am-card-name" }, entry.name || entry.model),
									h("span", { className: "am-spacer" }),
									h("button", { type: "button", className: "am-btn", "data-size": "sm", onClick: function () { setEditingPool({ entry: entry }); } }, t("subagents.edit")),
									h("button", { type: "button", className: "am-btn", "data-size": "sm", "data-variant": "danger", onClick: function () {
										if (typeof window !== "undefined" && typeof window.confirm === "function" && !window.confirm(t("subagents.pool.delConfirm"))) return;
										api.deletePoolModel(key).then(function (response) {
											if (response.ok) load();
											else setError((response.body && response.body.error) || String(response.status));
										}, function (networkError) { setError(networkError.message); });
									} }, t("subagents.del"))
								),
								h("div", { className: "am-card-body" }, entry.model + (entry.reasoningEffort ? " · " + entry.reasoningEffort : "")),
								h("div", { className: "am-card-body" }, entry.description || t("subagents.pool.usageEmpty"))
							);
						})
					);
				})
			) : null,

				editing === null ? null : h(RoleModal, {
					t: t,
					key: editing.name === "" ? "new" : "edit:" + editing.name,
					name: editing.name === "" ? undefined : editing.name,
					role: editing.name === "" ? undefined : roles[editing.name],
					builtin: editing.name !== "" && builtinInfo[editing.name] !== undefined,
					catalog: catalog,
					pool: pool,
					capabilities: capsData,
					onClose: function () { setEditing(null); },
					onDone: function () {
						setEditing(null);
						setNotice(t("page.saveOk"));
						load();
					}
				}),
				exporting ? h(RolesExportModal, {
					t: t,
					roles: exportableRoles,
					onClose: function () { setExporting(false); }
				}) : null,
				editingPool === null ? null : h(PoolModelModal, {
					t: t,
					key: "pool:" + (editingPool.entry === undefined ? "new" : editingPool.entry.provider + "/" + editingPool.entry.model),
					entry: editingPool.entry,
					catalog: catalog,
				onClose: function () { setEditingPool(null); },
				onDone: function () {
						setEditingPool(null);
						setNotice(t("page.saveOk"));
						load();
					}
				})
			);
		}

		// ---------------------------------------------------------------------------
		// Composer capability chip
		// ---------------------------------------------------------------------------

		/**
		 * Use the seat's own per-session projection face, never the global
		 * sessions list. List rows are eventually consistent in exactly the
		 * two ways this chip cannot tolerate: the list phase flips ready only
		 * on the first successful pull, and a row's blank comes from a
		 * fail-soft checkpoint cache that can serve a stale blank=true for
		 * history. The opened history page instead seeds
		 * sessionListMetadata from an authoritative fold of the real log:
		 * undefined = not seeded yet, blank=false = durable turns exist,
		 * blank=true = genuinely new. Unknown state is not permission to
		 * edit capabilities.
		 */
		function SessionChipGate(props) {
			var sessionId = String(props.sessionId);
			var meta = props.useProjection("sessionListMetadata");
			var sessionBlank = props.useSession(useCallback(function (snapshot) {
				return !!snapshot && String(snapshot.sessionId) === sessionId
					&& snapshot.openState === "open" && snapshot.blank === true
					&& snapshot.subagent === null && snapshot.removed !== true
					&& snapshot.running !== true && snapshot.promptAttempted !== true
					&& snapshot.awaitingFirstTurn !== true
					&& (!snapshot.pendingSubmissions || snapshot.pendingSubmissions.length === 0);
			}, [sessionId]));
			if (!meta || meta.blank !== true || sessionBlank !== true) return null;
			// A new identity must not inherit another session's poll result,
			// selection or open popover, even for the render before effects run.
			return h(SessionChip, Object.assign({}, props, { key: sessionId }));
		}

		/**
		 * The session capability chip in the composer tool row. Shows enabled
		 * MCP/skill counts for the current session; the popover toggles either
		 * group and persists through the Host selection store immediately.
		 */
		function SessionChip(props) {
			var sessionId = props.sessionId !== undefined && props.sessionId !== null ? String(props.sessionId) : "";
			var open = useState(false);
			var setOpen = open[1];
			open = open[0];
			var state = useState(null);
			var setState = state[1];
			state = state[0];
			var selection = useState(null);
			var setSelection = selection[1];
			selection = selection[0];
			var wrapRef = useRef(null);

			// Locale re-render subscription.
			var localeTick = useState(0);
			var bumpLocale = localeTick[1];
			localeTick = localeTick[0];
			useEffect(function () {
				if (props.subscribeLocale === undefined) return undefined;
				return props.subscribeLocale(function () { bumpLocale(function (x) { return x + 1; }); });
			}, []);

			var t = props.t || function (key) { return zh[key] || en[key] || key; };

			useEffect(function () {
				if (sessionId === "") return undefined;
				var stopped = false;
				function load() {
					api.state().then(function (response) {
						if (!stopped && response.ok) setState(response.body);
					}, function () { /* transient */ });
					api.getSelection(sessionId).then(function (response) {
						if (!stopped && response.ok) setSelection(response.body.selection);
					}, function () { /* transient */ });
				}
				load();
				var timer = typeof setInterval === "function" ? setInterval(load, 5000) : null;
				return function () {
					stopped = true;
					if (timer !== null) clearInterval(timer);
				};
			}, [sessionId]);

			// The parent gate has already confirmed this Client session is blank.
			// Host polling can additionally veto subagents/started live sessions,
			// but a cold unknown id (fresh=true) cannot bypass that parent gate.
			var fresh = useState(null);
			var setFresh = fresh[1];
			fresh = fresh[0];
			useEffect(function () {
				if (sessionId === "" || fresh === false) return undefined;
				var stopped = false;
				function check() {
					api.sessionFresh(sessionId).then(function (response) {
						if (stopped) return;
						if (!response.ok) {
							// Legacy host without the route: keep the chip visible.
							setFresh(function (current) { return current === null ? true : current; });
							return;
						}
						if (response.body.fresh === false) {
							setFresh(false);
							setOpen(false);
						} else setFresh(true);
					}, function () {
						if (!stopped) setFresh(function (current) { return current === null ? true : current; });
					});
				}
				check();
				var timer = typeof setInterval === "function" && fresh !== false ? setInterval(check, 4000) : null;
				return function () {
					stopped = true;
					if (timer !== null) clearInterval(timer);
				};
			}, [sessionId, fresh]);

			// Opening the popover refreshes statuses immediately (pool + last
			// manual test outcome) instead of waiting for the next poll tick.
			useEffect(function () {
				if (open && sessionId !== "") {
					api.state().then(function (response) {
						if (response.ok) setState(response.body);
					}, function () { /* transient */ });
				}
			}, [open, sessionId]);

			// Click-outside closes the popover.
			useEffect(function () {
				if (!open) return undefined;
				function onDown(event) {
					if (wrapRef.current !== null && wrapRef.current !== undefined && !wrapRef.current.contains(event.target)) setOpen(false);
				}
				document.addEventListener("mousedown", onDown);
				return function () { document.removeEventListener("mousedown", onDown); };
			}, [open]);

			var servers = (state && state.servers) || {};
			var pool = (state && state.pool) || {};
			var skills = (state && state.skills) || [];
			var enabledNames = Object.keys(servers).filter(function (name) { return servers[name].enabled !== false; }).sort();
			var mcpPicked = selection !== null && selection.mcp !== null ? enabledNames.filter(function (name) { return selection.mcp.indexOf(name) >= 0; }) : enabledNames;
			var skillPicked = selection !== null && selection.skills !== null ? skills.filter(function (skill) { return selection.skills.indexOf(skill.name) >= 0; }) : skills;

			/** Top filter: substring match over server names and skill names/descriptions. */
			var filterText = useState("");
			var setFilterText = filterText[1];
			filterText = filterText[0];
			/** Segmented tab: which group the popover shows. */
			var popTab = useState("mcp");
			var setPopTab = popTab[1];
			popTab = popTab[0];
			/** Full description of the hovered skill, shown in the footer area. */
			var hoverDesc = useState(null);
			var setHoverDesc = hoverDesc[1];
			hoverDesc = hoverDesc[0];
			var needle = filterText.trim().toLowerCase();
			var matches = function () {
				for (var i = 0; i < arguments.length; i++) {
					var value = arguments[i];
					if (typeof value === "string" && value.toLowerCase().indexOf(needle) >= 0) return true;
				}
				return false;
			};
			var shownMcp = needle === "" ? enabledNames : enabledNames.filter(function (name) { return matches(name); });
			var shownSkills = needle === "" ? skills : skills.filter(function (skill) { return matches(skill.name, skill.description, skill.dir); });
			var nothingShown = popTab === "mcp" ? shownMcp.length === 0 : shownSkills.length === 0;

			function toggleMcp(name, checked) {
				var current = selection !== null && selection.mcp !== null ? selection.mcp.slice() : enabledNames.slice();
				var next = checked ? current.concat([name]) : current.filter(function (item) { return item !== name; });
				apply({ mcp: next, skills: selection !== null && selection.skills !== null ? selection.skills : null });
			}

			function toggleSkill(name, checked) {
				var current = selection !== null && selection.skills !== null ? selection.skills.slice() : skills.map(function (skill) { return skill.name; });
				var next = checked ? current.concat([name]) : current.filter(function (item) { return item !== name; });
				apply({ mcp: selection !== null && selection.mcp !== null ? selection.mcp : null, skills: next });
			}

			/**
			 * The active tab's select-all / select-none: they touch only the
			 * tab the user is looking at; the other group keeps its selection.
			 */
			function setAll(all) {
				if (popTab === "mcp") {
					apply({ mcp: all ? null : [], skills: selection !== null && selection.skills !== null ? selection.skills : null });
				} else {
					apply({ mcp: selection !== null && selection.mcp !== null ? selection.mcp : null, skills: all ? null : [] });
				}
			}

			function apply(next) {
				var optimistic = {
					mcp: next.mcp,
					skills: next.skills
				};
				setSelection(optimistic);
				api.setSelection(sessionId, next).then(function (response) {
					if (response.ok) setSelection(response.body.selection);
				}, function () { /* transient; the next poll re-reads */ });
			}

			if (sessionId === "" || fresh === null || fresh === false) return null;

			return h("div", { className: "am-chip-wrap", ref: wrapRef },
				h("button", {
					type: "button", className: "am-chip", "data-open": open,
					title: t("session.title"),
					onClick: function () {
						if (open) setFilterText("");
						setOpen(!open);
					}
				},
					h("span", { "aria-hidden": "true" }, "⚙"),
					h("span", null, format(t("session.chip"), { m: mcpPicked.length, s: skillPicked.length }))
				),
				open ? h("div", { className: "am-pop" },
					h("input", {
						className: "am-input am-pop-filter",
						type: "text",
						value: filterText,
						placeholder: t("session.filter"),
						spellCheck: false,
						onChange: function (event) { setFilterText(event.target.value); }
					}),
					h("span", { className: "am-pop-top-hint" }, t("session.hint")),
					h("div", { className: "am-pop-actions" },
						h("div", { className: "am-tabs" },
							h("button", {
								type: "button", className: "am-tab", "data-active": popTab === "mcp",
								onClick: function () { setPopTab("mcp"); }
							}, t("session.mcpGroup")),
							h("button", {
								type: "button", className: "am-tab", "data-active": popTab === "skills",
								onClick: function () { setPopTab("skills"); }
							}, t("session.skillGroup"))
						),
						h("div", { className: "am-spacer" }),
						h("button", { type: "button", className: "am-btn", "data-variant": "ghost", onClick: function () { setAll(true); } }, t("session.all")),
						h("button", { type: "button", className: "am-btn", "data-variant": "ghost", onClick: function () { setAll(false); } }, t("session.none"))
					),
					nothingShown ? h("span", { className: "am-hint", style: { padding: "6px 8px" } }, t("session.noMatches")) : null,
					popTab === "mcp" && shownMcp.length > 0 ? h("div", { className: "am-pop-group" },
						shownMcp.map(function (name) {
							var entry = pool[name];
							var tools = entry !== undefined && entry.toolCount !== undefined ? entry.toolCount : 0;
							var off = servers[name].enabled === false;
							/** Mirrors the settings card: live pool state first, then
							 * the host-recorded last manual test outcome. */
							var lastTest = entry !== undefined && entry.lastTest !== undefined && entry.lastTest !== null ? entry.lastTest : undefined;
							var tone = off || entry === undefined ? "idle"
								: entry.state === "connecting" || entry.state === "closing" ? "testing"
								: entry.state === "connected" ? "ok"
								: entry.state === "failed" && lastTest === undefined ? "fail"
								: lastTest !== undefined ? (lastTest.ok === true ? "ok" : "fail")
								: entry.state === "failed" ? "fail"
								: "idle";
							var dotPulse = !off && entry !== undefined && (entry.state === "connecting" || entry.state === "closing");
							var checked = selection !== null && selection.mcp !== null ? selection.mcp.indexOf(name) >= 0 : true;
							return h("label", { key: name, className: "am-pop-row" },
								h("input", {
									type: "checkbox", checked: checked,
									onChange: function (event) { toggleMcp(name, event.target.checked); }
								}),
								h("span", { className: "am-dot", "data-tone": tone, "data-pulse": dotPulse ? "true" : "false", title: entry !== undefined && entry.state === "failed" && entry.error ? entry.error : (lastTest !== undefined && lastTest.ok !== true && lastTest.error ? lastTest.error : "") }),
								h("span", { className: "am-pop-row-name", title: name }, name),
								off ? h("span", { className: "am-badge", "data-tone": "idle" }, t("session.mcpOff"))
									: h("span", { className: "am-badge" }, format(t("session.tools"), { n: tools }))
							);
						})
					) : null,
					popTab === "skills" && shownSkills.length > 0 ? h("div", { className: "am-pop-group" },
						shownSkills.map(function (skill) {
							var checked = selection !== null && selection.skills !== null ? selection.skills.indexOf(skill.name) >= 0 : true;
							return h("label", {
								key: skill.dir, className: "am-pop-row",
								onMouseEnter: function () { setHoverDesc({ name: skill.name, text: skill.description || "" }); },
								onMouseLeave: function () { setHoverDesc(null); }
							},
								h("input", {
									type: "checkbox", checked: checked,
									onChange: function (event) { toggleSkill(skill.name, event.target.checked); }
								}),
								h("span", { className: "am-pop-row-name" }, skill.name),
								h("span", { className: "am-pop-desc", title: skill.description || "" }, skill.description || "")
							);
						})
					) : null,
					hoverDesc !== null
						? h("div", { className: "am-pop-hoverdesc" },
							h("span", { className: "am-pop-row-name", style: { flex: "none", maxWidth: "40%" } }, hoverDesc.name),
							h("span", { style: { flex: "1", minWidth: "0", overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: "3", WebkitBoxOrient: "vertical" } }, hoverDesc.text === "" ? t("skills.untitled") : hoverDesc.text)
						)
						: null
				) : null
			);
		}

		// ---------------------------------------------------------------------------
		// Startup-failure toasts
		// ---------------------------------------------------------------------------

		/**
		 * Frame-wide toast layer: watches /state, and for every MCP server the
		 * Host just failed to start that the user has not seen yet, shows
		 * "「name」mcp 工具启动失败". Seen names persist in localStorage.
		 */
		function ToastLayer(props) {
			var t = props.t || function (key) { return zh[key] || en[key] || key; };
			var toasts = useState([]);
			var setToasts = toasts[1];
			toasts = toasts[0];

			useEffect(function () {
				var seen = {};
				try {
					(JSON.parse(localStorage.getItem(SEEN_FAILURES_KEY) || "[]")).forEach(function (name) { seen[name] = true; });
				} catch (error) { /* corrupted list starts fresh */ }

				function check() {
					api.state().then(function (response) {
						if (!response.ok || response.body.pool === undefined) return;
						var fresh = [];
						var failedNames = [];
						Object.keys(response.body.pool).forEach(function (name) {
							var entry = response.body.pool[name];
							if (entry.state === "failed") {
								failedNames.push(name);
								if (seen[name] !== true) {
									seen[name] = true;
									fresh.push({ name: name, error: entry.error || "", detail: false });
								}
							}
						});
						try {
							localStorage.setItem(SEEN_FAILURES_KEY, JSON.stringify(failedNames));
						} catch (error) { /* private mode */ }
						if (fresh.length > 0) setToasts(function (current) { return current.concat(fresh); });
					}, function () { /* transient */ });
				}

				check();
				var timer = typeof setInterval === "function" ? setInterval(check, 15000) : null;
				return function () { if (timer !== null) clearInterval(timer); };
			}, []);

			function dismiss(name) {
				setToasts(function (current) { return current.filter(function (toast) { return toast.name !== name; }); });
			}

			function toggleDetail(index) {
				setToasts(function (current) {
					return current.map(function (toast, at) {
						return at === index ? Object.assign({}, toast, { detail: !toast.detail }) : toast;
					});
				});
			}

			if (toasts.length === 0) return null;
			return h("div", { className: "am-toasts" },
				toasts.map(function (toast, index) {
					return h("div", { key: toast.name + "#" + index, className: "am-toast", role: "alert" },
						h("div", { className: "am-toast-title" },
							h("span", { className: "am-dot", "data-tone": "fail" }),
							format(t("toast.mcpStartupFailed"), { name: toast.name })
						),
						toast.detail && toast.error !== "" ? h("div", { className: "am-toast-detail" }, toast.error) : null,
						h("div", { className: "am-toast-actions" },
							toast.error === "" ? null : h("button", { type: "button", className: "am-btn", "data-variant": "ghost", onClick: function () { toggleDetail(index); } }, t("toast.detail")),
							h("button", { type: "button", className: "am-btn", "data-variant": "ghost", onClick: function () { dismiss(toast.name); } }, t("toast.dismiss"))
						)
					);
				})
			);
		}

		// ---------------------------------------------------------------------------
		// Session process panel
		// ---------------------------------------------------------------------------

		/**
		 * The floating session process panel (top-right): the services this
		 * conversation's AI reported through the report_service_process
		 * callback tool, each with status, port(s), pid, a link, its recent
		 * output, and a stop button. Only the active session's records are
		 * shown; collapsed to a small pill until the user opens it.
		 */
		/**
		 * The「进程」conversation-view tab: every live service process of the
		 * active session — name, pid/job badge, ports, command, stop button,
		 * auto/subagent badges, hover detail card. Same data path as the old
		 * floating panel (activeSession probe + /session/processes polling);
		 * rendered in-flow for the tab instead of a fixed overlay.
		 */
		function ProcessView(props) {
			var t = props.t || function (key) { return zh[key] || en[key] || key; };

			// Locale re-render subscription.
			var localeTick = useState(0);
			var bumpLocale = localeTick[1];
			localeTick = localeTick[0];
			useEffect(function () {
				if (props.subscribeLocale === undefined) return undefined;
				return props.subscribeLocale(function () { bumpLocale(function (x) { return x + 1; }); });
			}, []);

			/** null = not loaded yet; [] = loaded, nothing running. */
			var processes = useState(null);
			var setProcesses = processes[1];
			processes = processes[0];
			var stopping = useState("");
			var setStopping = stopping[1];
			stopping = stopping[0];
			var error = useState("");
			var setError = error[1];
			error = error[0];
			/** Hover card payload: { top, left, text } or null. Fixed-positioned, so
			 *  it never touches the tab's scroll layout. */
			var hoverInfo = useState(null);
			var setHoverInfo = hoverInfo[1];
			hoverInfo = hoverInfo[0];

			useEffect(function () {
				var stopped = false;
				function load() {
					var id = activeSession.get();
					if (id === "") {
						// No session owns the tab (e.g. no conversation open): the
						// empty hint stands in for a poll that cannot run.
						setProcesses([]);
						return;
					}
					api.sessionProcesses(id).then(function (response) {
						if (stopped) return;
						if (response.ok && Array.isArray(response.body.processes)) setProcesses(response.body.processes);
					}, function () { /* transient; the next poll re-reads */ });
				}
				load();
				var timer = typeof setInterval === "function" ? setInterval(load, 4000) : null;
				var unsubscribe = activeSession.subscribe(load);
				return function () {
					stopped = true;
					if (timer !== null) clearInterval(timer);
					unsubscribe();
				};
			}, []);

			// The tab lists live services; settled records (stopped/exited/failed)
			// drop out and an empty list shows the tab's own empty hint.
			var list = processes === null ? [] : processes.filter(function (item) { return item.status === "running"; });

			function stop(item) {
				var id = activeSession.get();
				if (id === "" || stopping !== "") return;
				if (typeof window !== "undefined" && typeof window.confirm === "function"
					&& !window.confirm(format(t("procs.stopConfirm"), { name: item.name }))) return;
				setStopping(item.name);
				setError("");
				api.stopProcess(id, item.name).then(function (response) {
					if (response.ok) {
						// Refetch once so the record shows its settled status.
						api.sessionProcesses(id).then(function (fresh) {
							setStopping("");
							if (fresh.ok && Array.isArray(fresh.body.processes)) setProcesses(fresh.body.processes);
						}, function () { setStopping(""); });
						return;
					}
					setStopping("");
					var code = response.body !== null && response.body !== undefined ? response.body.error : "";
					setError(code === "no-pid"
						? t("procs.errNoPid")
						: format(t("procs.errStop"), { message: code === "" ? String(response.status) : code }));
				}, function () {
					setStopping("");
					setError(t("procs.errNetwork"));
				});
			}

			return h("div", { className: "am-procview", role: "region", "aria-label": t("procs.title") },
				h("div", { className: "am-procview-head" },
					h("span", { className: "am-dot", "data-tone": "ok" }),
					h("span", { className: "am-proc-title" }, t("procs.title")),
					h("span", { className: "am-badge" }, format(t("procs.pill"), { n: list.length }))
				),
				h("div", { className: "am-procview-scroll" },
				h("div", { className: "am-procview-inner" },
				processes === null ? h("p", { className: "am-hint" }, t("page.loading")) : null,
					processes !== null && list.length === 0 ? h("div", { className: "am-proc-empty" },
					h("span", { className: "am-proc-empty-glyph", "aria-hidden": "true" }, "◍"),
					h("p", { className: "am-hint", style: { margin: 0 } }, t("procs.empty"))
				) : null,
				list.length > 0 ? h("div", { className: "am-proc-table" },
					h("div", { className: "am-proc-headrow" },
						h("span", null, t("procs.colName")),
						h("span", null, t("procs.colProcess")),
						h("span", null, t("procs.colPorts")),
						h("span", null, t("procs.colCommand")),
						h("span", { title: t("procs.colAction") }, "·")
					),
					list.map(function (item) {
						// Details stay one hover away: command, ports, pid, url,
						// lineage and the output excerpt ride the row tooltip.
						var tip = [
							item.name
								+ (item.source === "subagent" ? " · " + t("procs.subagent") : "")
								+ (item.source === "auto" ? " · " + t("procs.auto") : ""),
							item.command || "",
							(item.ports || []).map(function (port) { return ":" + port; }).join(" ")
								+ (item.pid !== undefined ? (item.ports || []).length > 0 ? " · PID " + item.pid : "PID " + item.pid : "")
								+ (item.jobId !== undefined ? " · " + item.jobId : ""),
							item.url || "",
							item.message || "",
							item.output !== undefined && item.output !== "" ? item.output : ""
						].filter(function (part) { return part !== ""; }).join("\n");
						var ports = (item.ports || []);
						// A stop button on every row: with a pid/jobId it stops the
						// process; without one it stays disabled and the button's
						// tooltip explains why (better than no affordance at all).
						var hasHandle = item.pid !== undefined || item.jobId !== undefined;
						var processId = item.pid !== undefined ? String(item.pid)
							: item.jobId !== undefined ? item.jobId : "—";
						return h("div", {
							key: item.name, className: "am-proc-item",
							onMouseEnter: function (event) {
								// Hovering the stop button is an action intent, not a
								// data-inspection one: no card there.
								var target = event.target;
								if (target && typeof target.closest === 'function' && target.closest('.am-proc-stop') !== null) return;
								var rect = event.currentTarget.getBoundingClientRect();
								setHoverInfo({
									top: Math.round(rect.bottom) + 4,
									left: Math.max(8, Math.min(Math.round(rect.left), Math.round(window.innerWidth) - 390)),
									text: tip,
								});
							},
							onMouseLeave: function () { setHoverInfo(null); },
						},
							h("div", { className: "am-proc-row" },
								h("span", { className: "am-proc-cellname" },
									h("span", { className: "am-dot", "data-tone": "ok" }),
									h("span", { className: "am-proc-name" }, item.name)
								),
								h("span", { className: "am-badge", title: processId }, processId),
								ports.length > 0
									? h("span", { className: "am-badge am-proc-ports" }, ":" + ports.join(",:"))
									: h("span", null, " "),
								h("span", { className: "am-proc-cmd" }, item.command || ""),
								h("button", {
									type: "button", className: "am-proc-stop",
									"aria-label": (hasHandle ? t("procs.stop") : t("procs.errNoPid")) + " — " + item.name,
									"aria-disabled": stopping !== "" || !hasHandle ? "true" : "false",
									title: hasHandle ? (stopping === item.name ? t("procs.stopping") : t("procs.stop") + " " + item.name) : t("procs.errNoPid"),
									onMouseEnter: function () { setHoverInfo(null); },
									onClick: function () { if (hasHandle && stopping === "") stop(item); }
								}, stopping === item.name ? "…" : "■")
							)
						)
					})
				) : null,
				error !== "" ? h("div", { className: "am-proc-msg", role: "alert" }, error) : null
				)
				),
				hoverInfo !== null ? h("div", {
					className: "am-proc-info",
					style: { top: hoverInfo.top + "px", left: hoverInfo.left + "px" },
				}, hoverInfo.text) : null
			);
		}

		// ---------------------------------------------------------------------------
		// Plugin body
		// ---------------------------------------------------------------------------

		/** Services this client plugin needs. */
		var inject = ["slots", "locale"];

		/**
		 * Register dictionaries and seat the four surfaces: the settings page,
		 * the composer chip, and the toast layer.
		 *
		 * @param {object} ctx - client root context.
		 */
		function apply(ctx) {
			injectStyle();

			var t = function (key) { return zh[key] || en[key] || key; };
			try {
				ctx.locale.register(NS, "zh", zh);
				ctx.locale.register(NS, "en", en);
				t = ctx.locale.bind(NS);
			} catch (error) {
				try { console.error("[" + NS + "] locale registration failed: " + String(error)); } catch (ignored) { }
			}
			function subscribeLocale(listener) {
				try {
					return ctx.locale.subscribe(listener);
				} catch (error) {
					return undefined;
				}
			}

			/**
			 * Which feature rows the Host actually loaded (the core row is this
			 * bundle's skeleton and always present; 'capabilities' covers MCP +
			 * skills + session selection). Fetched before seating any UI. A FAILED
			 * fetch (network error / non-OK) retries with backoff — seating
			 * everything on a transient error would permanently show menus for
			 * rows the user switched off. Only an explicit feature list from a
			 * healthy /state ever gates the surfaces; a legacy Host without the
			 * features field also answers everything (all rows compose).
			 *
			 * @param {() => void} seat - registers every gated surface.
			 * @returns {void}
			 */
			function seatByFeatures(seat) {
				var delays = [0, 500, 2000, 8000];
				var attempt = 0;
				function run() {
					api.state().then(function (response) {
						if (response.ok && Array.isArray(response.body.features)) {
							seat(response.body.features.reduce(function (acc, id) { acc[id] = true; return acc; }, {}));
							return;
						}
						if (response.ok) {
							// Healthy Host, no features field: legacy Host composes
							// every row — seat everything.
							seat({ capabilities: true, subagents: true, retry: true, processes: true });
							return;
						}
						retry();
					}, retry);
				}
				function retry() {
					if (attempt >= delays.length - 1) {
						// Host unreachable for ~10s: assume the worst case the
						// user notices (a missing menu reloads the page anyway).
						seat({ capabilities: true, subagents: true, retry: true, processes: true });
						return;
					}
					attempt += 1;
					if (typeof setTimeout === "function") setTimeout(run, delays[attempt]);
					else run();
				}
				run();
			}

			seatByFeatures(function (on) {
				// The invisible active-session probe rides the composer seat
				// whenever any consumer needs it: the capability chip
				// (capabilities row) or the「进程」tab (processes row).
				if (on.capabilities === true || on.processes === true) {
					try {
						ctx.slots.inject(COMPOSER_LEFT, function () {
							return ctx.slots.register({
								name: COMPOSER_LEFT,
								id: "agents-manager-probe",
								order: 39,
								label: function () { return t("session.title"); }
							}, function (props) {
								var sessionId = props.sessionId;
								var hasId = sessionId !== undefined && sessionId !== null && String(sessionId) !== "";
								return hasId ? h(ActiveSessionProbe, { sessionId: String(sessionId) }) : null;
							});
						});
					} catch (error) {
						try { console.error("[" + NS + "] active-session probe registration failed", error); } catch (ignored) { }
					}
				}

				// Capabilities surfaces「MCP 和技能」settings page, the composer
				// capability chip, and the MCP startup-failure toasts (own row:
				// hidden when the row is off).
				if (on.capabilities === true) {
					try {
						ctx.slots.inject(SETTINGS_SECTION, function () {
							return ctx.slots.register({
								name: SETTINGS_SECTION,
								id: "agents-manager",
								order: 850,
								label: function () { return t("page.title"); },
								locale: NS,
								inject: function () { return { t: t, subscribeLocale: subscribeLocale }; }
							}, AgentsManagerPage);
						});
					} catch (error) {
						try { console.error("[" + NS + "] settings page registration failed", error); } catch (ignored) { }
					}

					// Composer capability chip (session-scoped seat; the probe
					// above is separate so the processes row keeps working with
					// this row off).
					try {
						ctx.slots.inject(COMPOSER_LEFT, function () {
							return ctx.slots.register({
								name: COMPOSER_LEFT,
								id: "agents-manager",
								order: 40,
								label: function () { return t("session.title"); }
							}, function (props) {
								// Session-scoped seats supply these hooks after the official
								// adapter is ready. Missing hooks never authorize selection.
								if (typeof props.useSession !== "function" || typeof props.useProjection !== "function") return null;
								return h(SessionChipGate, Object.assign({ t: t, subscribeLocale: subscribeLocale }, props, { key: String(props.sessionId) }));
							});
						});
					} catch (error) {
						try { console.error("[" + NS + "] composer chip registration failed", error); } catch (ignored) { }
					}

					// Startup-failure toasts.
					try {
						ctx.slots.inject(SHELL_OVERLAY, function () {
							return ctx.slots.register({
								name: SHELL_OVERLAY,
								id: "agents-manager",
								order: 500,
								label: function () { return t("page.title"); }
							}, function () {
								return h(ToastLayer, { t: t });
							});
						});
					} catch (error) {
						try { console.error("[" + NS + "] toast layer registration failed", error); } catch (ignored) { }
					}
				}

				// Subagents settings page (own row: hidden when the row is off).
				if (on.subagents === true) {
					try {
						ctx.slots.inject(SETTINGS_SECTION, function () {
							return ctx.slots.register({
								name: SETTINGS_SECTION,
								id: "agents-manager-subagents",
								order: 851,
								label: function () { return t("subagents.pageTitle"); },
								locale: NS,
								inject: function () { return { t: t, subscribeLocale: subscribeLocale }; }
							}, SubagentsPage);
						});
					} catch (error) {
						try { console.error("[" + NS + "] subagents settings page registration failed", error); } catch (ignored) { }
					}
				}

				// Auto-retry settings page (own row).
				if (on.retry === true) {
					try {
						ctx.slots.inject(SETTINGS_SECTION, function () {
							return ctx.slots.register({
								name: SETTINGS_SECTION,
								id: "agents-manager-retry",
								order: 852,
								label: function () { return t("retry.pageTitle"); },
								locale: NS,
								inject: function () { return { t: t, subscribeLocale: subscribeLocale }; }
							}, RetryPage);
						});
					} catch (error) {
						try { console.error("[" + NS + "] retry settings page registration failed", error); } catch (ignored) { }
					}
				}

				//「进程」conversation-view tab (own row; replaces the old floating
				// panel, which lived on shell.overlay).
				if (on.processes === true) {
					try {
						ctx.slots.inject(CONVERSATION_VIEW, function () {
							return ctx.slots.register({
								name: CONVERSATION_VIEW,
								id: "agents-manager-processes",
								order: 20,
								locale: NS,
								label: function () { return t("procs.tab"); }
							}, ProcessView);
						});
					} catch (error) {
						try { console.error("[" + NS + "] process tab registration failed", error); } catch (ignored) { }
					}
				}
			});
		}

		module.exports.apply = apply;
		module.exports.inject = inject;
		return module.exports;
	}
});
