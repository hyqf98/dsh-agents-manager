# dsh-agents-manager

DeepSeek Harness (DSH) 插件：在设置页可视化 管理 **MCP 服务器**与**技能（Skills）**（「MCP 和技能」页），独立设置页管理**子代理角色**（「子代理」页）与**自动重试**（「自动重试」页），并为每个会话选择启用的 MCP 与技能。

## 功能总览

| 能力域 | 入口 | 功能点 |
|---|---|---|
| MCP 服务器 | 设置 → MCP 和技能 → MCP 服务器 | 统一存储/文件兜底双层数据 · 读取 `~/.agents/mcp.json` 只读导入 · 一键同步 Claude Code / Claude Desktop / Codex / zcode / Cursor / opencode / Gemini CLI / Qwen Code / MiMo Code / Windsurf / VS Code / Cline / Trae（13 来源跨平台） · 粘贴导入（解析预览+可选预测试） · stdio/streamable-http 表单配置 · 单测/全部测试连接 · 工具详情弹窗（方法级测试调用） · 启动自检 + 失败 toast · 卡片编辑/删除/启停 |
| 技能 | 设置 → MCP 和技能 → 技能 | GitHub 安装（tar.gz + SKILL.md 自动识别） · 技能列表 · 页内编辑器（目录树悬停展开、Markdown 渲染、单击进入编辑、Ctrl/Cmd+S、sha256 冲突检测、二进制/超大只读） |
| 子代理角色 | 设置 → 子代理（独立页） | 角色 → `delegate_<role>` 委派工具 · 候选模型链 + 自定义描述（主代理动态选模型） · 失败换模重试指引 · promptPrefix / agentPreset / maxTokens · 粘贴导入/导出 · provider 目录建议（可手填） · 宿主过旧时显示重启提示 |
| 自动重试 | 设置 → 自动重试（独立页） | 内核 per-provider 重试策略可视编辑（路由卡按厂商显示，热生效） · 14 组厂商预设规则一键导入（智谱/GLM 5h+周限额、Claude、Codex、OpenAI、Kimi、DeepSeek、Gemini、Cline、Factory、Antigravity、网关过载、中文中转站） · 正则+提取器自定义规则（7 种等待提取） · 规则测试抽屉（粘贴真实报错即时验证） · 进行中等待/最近事件监控（跨重启保留，含未重试失败及原因） · AI 工具三件套（读状态/试规则/写规则） |
| 会话能力选择 | 输入框工具行 chip（仅会话开始前） | 按会话勾选 MCP/技能（默认全选） · 会话开始后自动隐藏 · Tab 分组 · 筛选 · 状态点（绿/红） · 悬停查看技能说明 · 全选/全不选 · 即时生效 |
| 会话进程回显 | 会话顶部「进程」tab + `report_service_process` 工具 | AI 启动服务后回调上报（名称/端口/pid/回显） · 三层必掉（pre-execute 标记 → post-execute 一次性 notice 提醒 → jobs 事件自动登记/auto 徽标/手动接管） · 每会话独立面板 · 子代理上报自动归并到根会话（子代理徽标） · 进程回显展开查看 · URL 直达 · 一键停止（SIGTERM→SIGKILL） · 死进程自动标记已退出 |
| 组件行开关 | 插件 → dsh-agents-manager 详情 → 包含的组件 | 五个独立组件行，每行都有中文名与功能说明：**核心骨架**（agent 绑定 + 共享 HTTP 路由，不可关） · **MCP 技能管理**（MCP 服务器 + 技能 + 会话能力选择） · **子代理管理** · **自动重试** · **进程看板**——逐行启停，关闭即整块功能消失（无工具/无设置页/无引擎/无 MCP 连接），DSH 原生行级 Switch，重启生效 |
| 通用 | — | 中英双语文案（跟随宿主语言） · 明暗主题自适应（仅 `--dsw-alias-*` token） · 同源 HTTP API（`/agents-manager/api/v1`） |

## 功能

### MCP 管理（设置 → MCP 和技能 → MCP 服务器）

- **配置主存储**：优先写入 DSH 提供的统一数据存储（`storageDomain` KV 域 `agents_manager`，zod 校验、写持久化优先、`domain/changed` 变更通知）；该服务未组合时自动落到 DSH 环境下的插件数据文件 `~/.dsh/agents-manager/mcp.json`。
- **读取 `~/.agents/mcp.json`**（只读导入源，标准 `mcpServers` JSON 格式，兼容 Claude Code / Cursor）：主存储为空且该文件存在时，启动自动一次性导入（标记完成不重复）；也可在「粘贴配置」弹窗中点「读取 ~/.agents/mcp.json（N）」按需导入。本插件不写该文件。
- **一键同步其他 Agent（13 个来源，跨平台路径）**：工具栏「⇄ 同步其他 Agent」自动检测并解析本机各 Agent 的 MCP 配置，勾选导入（同名覆盖；名称自动清洗为安全字符；跨来源重名取先者）：
  - **Claude Code** `~/.claude.json` → `mcpServers`
  - **Claude Desktop**：macOS `~/Library/Application Support/Claude/claude_desktop_config.json`；Windows `%APPDATA%\Claude\` 及 MSIX 重定向 `AppData\Local\Packages\Claude_*\LocalCache\Roaming\Claude\`；Linux `~/.config/Claude/`
  - **Codex** `~/.codex/config.toml` → `[mcp_servers.*]`（内置轻量 TOML 解析）
  - **zcode** `~/.zcode/cli/config.json` → `mcp.servers`
  - **Cursor** `~/.cursor/mcp.json`
  - **opencode** `~/.config/opencode/opencode.json[c]`（macOS `~/Library/Application Support/opencode/`）→ `mcp`，`type: local` 的 `command` 数组 + `environment` 自动转换为 stdio 形状；JSONC 注释/尾逗号容忍
  - **Gemini CLI** `~/.gemini/settings.json` → `mcpServers`，`httpUrl` 自动别名到 `url`
  - **Qwen Code** `~/.qwen/settings.json` → `mcpServers`
  - **MiMo Code** `~/.config/mimocode/mimocode.json[c]` → `mcp`，`local`/`remote` 双形状转换
  - **Windsurf** `~/.codeium/windsurf/mcp_config.json` → `mcpServers`
  - **VS Code**（含 Insiders）用户级 `mcp.json` → `servers`（`type: http/sse` 映射为 streamable-http；macOS 在 `~/Library/Application Support/Code/User/`，Windows 在 `%APPDATA%\Code\User\`，Linux 在 `~/.config/Code/User/`）
  - **Cline** VS Code globalStorage 下的 `cline_mcp_settings.json` → `mcpServers`
  - **Trae** `~/.config/Trae/mcp.json`（macOS `~/Library/Application Support/Trae/`）
  - 路径基于系统 home 目录 + 平台布局解析（XDG / Application Support / %APPDATA%），macOS/Linux/Windows 通用；全部只读，绝不回写。
- **粘贴导入**：粘贴 JSON（`{"mcpServers": {...}}`、单个服务器对象或裸数组均可）→ 解析预览（冲突/无效标注，可选导入前逐条测试）→ 导入所选。兼容 zcode 等格式别名：`type` 字段（`stdio`/`http`/`sse`/`remote`）与 `timeoutMs` 自动归一。
- **表单配置**：stdio（command/args/env/cwd）与 streamable-http（url/headers）两种传输，env/headers 键值对编辑，工具调用超时、启用开关。
- **描述字段（给 AI 看）**：每个服务器可写一行用途说明（≤500 字），保存后**注入到该服务器每个 MCP 工具的描述前缀**（`[name] 说明 — 原描述`），模型在选择工具时就能读到"这个 MCP 是干什么的"；卡片上以灰色说明行展示，导入/编辑弹窗均可维护。
- **stdio 子进程代理行为**：DSH 在代理策略激活时会向所有子进程注入 `NODE_USE_ENV_PROXY=1`（让 Node 子进程的 `fetch()` 走环境变量代理）——这会让连**内网**目标的 MCP 服务器被机器代理截断而连接失败。插件启动 stdio 型 MCP 服务器时默认剔除该注入，恢复 Node 默认直连（与 zcode 等其他 MCP 宿主一致）；`http_proxy`/`https_proxy`/`no_proxy` 原样透传供非 Node 服务器自取。确需让某个服务器走代理时，在其 env 配置里显式添加 `NODE_USE_ENV_PROXY=1`。
- **服务器卡片**：状态点 + 状态徽标（已连接 / 失败 / 测试中 / 已停用 / 未测试），工具名旁显示「N 个工具」徽标；卡片尾部**启停开关**（一键启用/停用，请求即时返回不卡顿；连接建立期间开关显示加载转圈、状态点呼吸闪烁「连接中」，停用即断开并注销其工具）；状态点优先显示实时池状态（已连接/失败/连接中），无池信息时显示最近一次手动测试结果；操作按钮：编辑（回填表单弹窗）、删除（确认后移除）、测试（单服务器重连式测试）；工具栏提供「全部测试」批量自检。
- **测试连接**：每个服务器一键测试（独立临时连接，10s 超时），返回成功/失败与工具清单；测试同时校准连接池状态（相当于手动重连）。**测试结果会同步反映到卡片状态点与状态徽标**（成功绿 / 失败红，池已连接时以池为准），并随 `/state` 带出——输入框底部「会话能力」选择器里的状态点同样显示最近测试结果（打开弹层即刷新）。
- **工具详情与测试调用**：卡片「⚙ 工具」打开该服务器的工具详情弹窗——逐个方法显示名称与描述（展开可见公共名 `mcp__<server>__<tool>`），内嵌 JSON 参数编辑器，一键**测试调用**任意方法并查看结果（结果面板限高滚动，超长自动换行）；调用走连接池、超时沿用服务器的工具调用超时配置。
- **启动自检 + 消息通知**：DSH 启动时自动连接所有已启用 MCP（即测试）；失败的服务器会在 Web GUI 弹出主题化通知「「xxx」mcp 工具启动失败」，可展开查看原因、可关闭。自动迁移 `~/.agents/mcp.json` 完成后在列表上方以提示行告知导入数量。DSH 未向插件开放系统级通知 API，故通知为 GUI 内提示。

### 技能管理（设置 → MCP 和技能 → 技能）

- **从 GitHub 安装**：列表顶部「⬇ 安装技能」支持 `owner/repo`、`owner/repo/子目录`、`#分支` 或完整 GitHub 链接（含 `/tree/<branch>/<path>`）；宿主下载仓库 tar.gz（内置无依赖 ustar 解析，含 GNU 长名）、自动识别含 `SKILL.md` 的技能目录（仓库根 / 一级目录 / `skills/*` 三种布局）并复制到 `~/.agents/skills`；同名已存在跳过不覆盖；私有仓库/路径错误有明确提示。**只复制文件，不执行仓库内任何代码**。
- 默认整行展示技能列表（名称、描述、目录/文件数）；**单击技能直接进入**。
- 编辑态：左侧默认**只显示一个 22px 侧栏手柄（☰）**，树形内容完全隐藏；鼠标移到手柄位置自动展开 300px 目录树浮层（文件夹可折叠、当前文件高亮），「← 返回列表」回到最外层技能列表。
- 右侧**无任何工具条、单容器**直接渲染内容：`.md` 走内置 Markdown 渲染，其他文本等宽预览；**单击内容即进入编辑**（右下角浮动胶囊：脏点/提示/保存/退出；Ctrl/Cmd+S 可用；sha256 冲突检测；渲染中的链接点击不会误入编辑）。二进制/超大文件只读。编辑器支持切换技能目录内任意文本文件（默认 SKILL.md）；编辑中点击左列其他技能即切换；「✕ 收起编辑」回到纯列表。

### 子代理角色与模型池（设置 → 子代理，独立设置页）

- **模型池（全局模型清单）**：页内「模型池」Tab 登记模型 + **用途描述**（如"用于视觉 / 复杂任务 / 决策模型"）+ 默认推理强度；provider/模型/强度三级联动下拉（数据同 DSH 模型设置页）。这份说明就是主 Agent 与子代理共享的选型依据。
- **推理强度下拉**：所选模型在模型设置里广告了强度档位（如 minimal/low/medium/high 或厂商专属档）就用广告值；多数 provider 不广告时回退常用档位（minimal/low/medium/high），且**支持手动输入任意值**。
- **显示名称**：默认以**模型 ID 回显**（占位符跟随所选模型），留空保存即用模型 ID；用户输入自定义名称后以名称为准（卡片标题优先显示名称）。
- **list_delegation_models 工具**：模型池非空时自动注册，主 Agent 可随时调用读取全部模型的用途说明，按任务特征（视觉/复杂推理/决策路由）自行决策选哪个模型。
- **角色候选从模型池引用**：角色编辑弹窗内「从模型池添加候选」一键带入池中 provider/模型/强度/**用途描述**（池描述优先于角色内嵌值），支持上移/下移调整优先级；仍可手填池外模型。
- **向主 Agent 开放全池**：角色勾选「向主 Agent 开放整个模型池」后，该角色工具的 `model` 枚举 = 模型池全部启用模型（描述随池），由主 Agent 完全自主决策；未勾选则限定角色自己的候选链。
- **内置角色（开箱即用，随插件升级自动更新）**：插件自带 9 个按行业最佳实践精炼的角色——`frontend-dev`（前端开发）、`backend-dev`（后端开发）、`test-engineer`（测试）、`architect`（架构选型，只读）、`product-designer`（产品设计）、`visual-expert`（视觉专家，只读）、`effort-estimator`（工时评估）、`task-planner`（任务规划）、`code-reviewer`（代码评审，只读）。运行时合并进角色清单、不写入用户存储：内置角色不锁定候选模型（`openPool` + 空候选链，子代理默认**继承当前会话模型**，主代理也可从模型池按用途选路），编辑保存时可不设候选。提示词统一骨架（身份 / 角色边界互指 / 工作流 / 纪律 / 输出契约 / 停止条件，执行类角色带 `NEEDS_CONTEXT` / `BLOCKED` 收尾约定），精炼自 Claude Code 子代理规范、wshobson/agents、davila7/claude-code-templates、obra/superpowers、MetaGPT 角色节点与 OpenAI GPT-4.1/5 代理提示指南。同名用户记录**整体覆盖**内置定义（卡片显示「内置·已自定义」徽标）；删除内置角色仅写入隐藏标记（确认框说明），页面底部「已隐藏的内置角色」一键**恢复默认**（同时清除该名字下的自定义修改）；导出只导出用户内容，纯内置角色不带出。

- **角色 = 一个 `delegate_<角色名>` 模型工具**：每个启用角色在会话中注册一个委派工具，主代理用 `task`（必填）+ `model`（候选枚举，缺省第一个）+ `cwd`（可选）调用；工具描述携带角色说明、每个候选的**自定义描述**与失败重试契约，主代理据此按任务动态选模型。
- **候选模型链**：每角色配置有序候选（provider / 模型 ID / 推理力度 / 描述）；第一个为缺省。provider 输入框附带目录建议（datalist，来自当前注册的 LLM 适配器 `llm.listProviders` + `listModels`，懒加载、失败降级为纯手填）。
- **失败换模重试（回报式）**：一次调用一次尝试。子代理失败时（stopReason=error），工具结果返回「失败诊断 + 已用模型 + 剩余候选（含描述）+ 重试指引」，主代理自行换一个 `model` 重新调用。非模型故障（max-tokens / 中止 / 拒绝）原样报告，不误导换模。
- **可选角色增强**：任务前缀 `promptPrefix`（拼接在任务前）、`agentPreset`（spawn 支持的独立子代理组合）、`maxTokens` 输出上限、启用开关。
- **子代理能力白名单（MCP / 技能）**：角色编辑弹窗「子代理能力」组——默认「跟随会话选择」（该角色派出的子代理继承调用会话在输入框勾选的 MCP/技能）；切到「自定义白名单」后按角色勾选 MCP 服务器与技能（两组各有全选/全不选，互不影响）。实际生效集 = **角色白名单 ∩ 调用会话选择 ∩ 已启用清单**（子代理永远看不到其父会话没有的能力）。实现：委派工具执行时把交集写入 pendingCapabilities 预约（60s TTL，父会话结束即清），子代理 agent 创建时消费预约并据此注册 MCP 工具与 skill 守卫；无白名单的角色不预约、子代理直接沿用会话选择。角色卡片对带白名单的角色显示「子代理能力」徽标。
- **角色卡片**：启用状态点 + `delegate_<role>` 工具名 + 候选数徽标 + 候选清单（`provider/model · 推理力度 — 描述`）；操作：编辑（回填弹窗，角色名不可改）、删除（确认）。
- **保存即时生效**：写入后宿主立即重读角色并对所有在线 agent 重建工具注册（无需重启；已开会话立即可见，新会话自然生效）。
- **宿主版本自检**：页面加载时若 `/subagents` 路由不存在（运行中的宿主仍是旧模块），显示「需完全退出并重启 DeepSeek Harness」提示并停用写操作，不再裸报 `not-found`。
- **粘贴导入 / 导出**：`{"roles": {...}}` JSON 一键导入（逐条走服务端校验，角色名自动规范化、同名覆盖）、整包导出备份（点击全选便于复制）。
- 实现细节：调用 `ctx.subagents.startActivation`（`provider:'spawn'`、`delivery:'caller'`、`request.agentOptions` 覆盖子代理路由，调用前 `llm.resolveCallConfig` 路由预检），前台等待结果；不设工具超时；深度上限沿用宿主 `subagents.maxDepth` 设置；与原生 `subagent` / `subagent_fork` 工具互不影响，不注册 `list_subagent_models`。

### 会话能力选择（输入框工具行，仅会话开始前）

- **仅在会话开始前可选**：chip（如 `⚙ 3 MCP · 28 技能`）只在新会话发出第一条消息之前显示。判定读取座位自带的**会话级投影面** `useProjection("sessionListMetadata")`（打开的历史页由宿主对真实事件日志的权威折叠播种）与 `useSession` 快照（同 id、已打开、`blank===true`、非子代理、未运行或提交）联合授权：投影为 `undefined`（尚未播种）、`blank===false`（已有持久对话轮次）或任一快照否决时保持隐藏。**不读全局会话列表**——列表行的 `blank` 来自 fail-soft 投影缓存检查点（会话空白期写入、`turn/end` 刷盘失败时**过期为 blank=true**），且列表 `phase` 只在首次成功拉取才变 ready（失败即永久 pending），两者都会在冷启动时给出错误结论（历史误显示 / 新会话被藏）。首条提交、快照翻非空或投影纠正为 `blank=false` 时立即卸载 chip 与弹层。宿主 `/session/fresh` 每 4 秒补充否决：live 子代理、或事件日志中已出现 `turn/start`（与官方 blank 折叠**同语义**——非 turn 事件如自动标题不算开始，不能用 `seq===0` 这类事件计数启发式，web 版新建会话首条消息前就常带非 turn 事件）；宿主未知 id 不能单独授权显示；旧宿主无该路由时仍须通过客户端门禁。按 `sessionId` 隔离组件状态和迟到响应，冷开历史与切换回来行为一致。
- 点开弹层以 **Tab 方式切换「MCP 服务器 / 技能」**两组勾选，**默认全部启用**；「全选 / 全不选」只作用于**当前 Tab 这一组**，另一组保持原选择不变；弹层为实色抬升面板（与设置页弹框同款底色）。
- 弹层**顶部筛选框**可按名称/描述过滤；技能行跟随描述文字（超长省略），**鼠标悬停技能行时底部区域显示该技能的完整说明**。
- 取消勾选的 MCP 服务器的工具立即从该会话的模型工具集移除（重新勾选立即恢复）；取消勾选的技能在模型尝试加载（`skill` 工具）时被拒绝。选择仅作用于当前会话（内存态，随会话消失），新会话恢复默认全选。
- MCP 行首有**状态点**（绿=已连接、红=失败、黄=连接中、灰=未测试/停用，失败悬停显示异常信息），行尾直接显示「N 个工具」徽标（已停用的服务器显示「已停用」徽标）。

### 会话进程回显（会话顶部「进程」tab + `report_service_process` 工具）

- **回调工具**：AI（主代理或子代理）启动本地服务进程（dev server / HTTP 服务 / 构建监听 / 数据库等）后调用 `report_service_process`，上报 `name`（会话内主键，同名=更新）、`port`/`ports`、`pid`、`url`、`command`、`output`（启动回显，整体替换，上限 4000 字符）、`status`（running/stopped/exited/failed）与 `message`；**省略的字段继承上次上报值**（只改状态不会丢 pid/端口）。工具返回确认 + 当前会话进程摘要，主代理借此也能收集子代理启动的服务。工具描述含「启动本地服务后必须回调」硬约束与「前台命令在服务就绪前返回，先按预期端口上报、后补报修正」的指引。
- **三层「必掉」机制**（确保 AI 启动服务后回调不遗漏；零常驻 token、纯事件驱动）：
  1. **拦截标记**（`tools/pre-execute`）：前台 `bash`/`pwsh` 调用命中服务启动启发式（`java -jar` / spring-boot / `mvn`·`gradle` run / `npm`·`pnpm`·`yarn` dev·serve·start / vite·next·nuxt·astro / `python -m http.server`·uvicorn·flask / `node server.js` / redis·mongo·postgres / `docker compose up` / `php -S` 等；读类命令 grep/git/curl/ps/lsof 等一律豁免）或显式 `run_in_background` 时，按 callId 记入内存 pending 表（30s TTL、按 agent WeakMap 隔离、进程退出自动释放）；**只放行不改结果**。
  2. **结算提醒**（`tools/post-execute`）：被标记的调用结束时若 AI 尚未回调（`report_service_process` 成功即消费掉全部标记），通过内核 `additionalContexts` 通道（官方 repeat-tool-reminder 同款带标签 notice，落日志可回放）注入一条提醒要求立即补报；每 callId 只提醒一次，不阻塞、不重写结果。
  3. **自动登记**（jobs 事件桥）：订阅内核 `ctx.jobs`（内核已把每个 bash 命令注册为后台作业），`registered` 事件命中同款启发式时直接写一条 `source:'auto'` 记录进面板（显示命令行，无 pid/端口，行内「自动登记」徽标）；`settled` 时未被手动接管的 auto 记录翻 exited（kill 则 stopped）。AI 随后手动 report 同名记录即**接管**（端口/pid 补齐、徽标消失）；auto 更新不降级手动记录。`jobs` 服务未组合的 profile 该层整体静默跳过。
- **「进程」tab**：会话顶部视图 tab（`conversation.view` 官方座位，与「对话 / 轨迹」并列，「进程」行开启后显示）渲染当前会话的服务进程表：每行一个服务 = 状态点 + 名称 + pid/job 徽标 + 端口 + 启动命令 + **停止按钮**（仅带 pid/jobId 的记录）；URL/子代理来源/回显等详细信息收在行悬停提示卡里。空会话显示引导文案；4 秒轮询刷新；上报了 pid 的运行中记录在每次读取时做存活探测，进程已死自动翻为「已退出」并随之从表格消失。
- **每会话独立 + 子代理归并**：记录按**根会话**归档——工具执行时沿 `session.header.parentSession` 上溯（仅当各环 `origin==='subagent'`；防环、上限 32 跳），并以全局 `subagent/start` 事件的 child→parent 映射兜底；父链不可解析时回退记到调用者会话并 warn。子代理上报的记录在行提示中标注来源。切换会话时面板立即改读新会话（composer 槽位探针发布活跃 sessionId）。
- **停止语义**：停止按钮确认后 `SIGTERM` → 250ms×6 步宽限探测 → 仍存活则 `SIGKILL` → 记录翻「已停止」；无 pid 的记录不可远程停止（面板明确提示，绝不做按端口杀进程）；跨权限（EPERM 等）失败原样报错。
- **数据边界**：进程注册表为**内存态**（每会话上限 50 条，超限先淘汰已停记录再 FIFO）——DSH 重启后面板消失但服务进程仍在运行，需要 AI 重新上报一次即可恢复显示；插件卸载/会话关闭同样不杀任何进程。

### 自动重试（设置 → 自动重试，独立设置页）

两层恢复机制：**provider 策略**（内核 `dsh-llm-retry` 执行器的每路由配置）+ **表达式规则**（本插件在内核之前按厂商报错文本匹配并提取等待时长）。

#### 重试策略（Tab 1）

- 每个 LLM provider 路由一张卡片：**主标题按厂商显示**（从该路由模型目录推导：只列主要厂商——模型数达到该路由最多厂商 ⅓ 以上才进标题，按模型数降序，杂项模型不显示；超过 6 个折叠为 `+N`；推导不出时回退路由显示名），副行保留路由 id（规则 providers 过滤引用它）与模型数；卡片显示当前生效策略（模式、重试次数、可重试码、退避区间）；「编辑」弹窗支持 normal（有限次+码集合）/ always（无限重试）模式、backoff 三参数，附四组预设（默认 / 429 友好 / 长等待 6h / 无限重试）与 always 计费警示。
- 策略粒度是**路由**：本机网关（如 Magpie）的一条路由汇聚多家厂商，策略对该路由下全部厂商生效；厂商标签是纯显示层推导（`VENDOR_KEYWORDS` 关键词表 + 10s TTL 模型目录缓存），不影响规则匹配与策略寻址。
- 写入走 `ctx.settings.mutate`（settings 命名空间 `llm-pi-ai` 的 `providers.<route>.retryPolicy` / `llm-deepseek` 的 `retryPolicy`）→ 原子写入 profile `cordis.patch.yml` → `loader/volatile-update` 热重载；**不重启即对下一次请求生效**。「重置默认」删除覆盖，回到继承值。
- 归一失败码：`RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT / EMPTY_RESPONSE`（默认可重试）、`QUOTA / ACCOUNT_QUOTA / AUTH / INVALID_CREDENTIAL / INVALID_REQUEST / CONTEXT_WINDOW_EXCEEDED / PI_AI_ERROR`（默认不重试，可手动加入）。

#### 表达式规则（Tab 2）

- **规则 = 正则匹配 + 提取等待**：`{name, when(正则), flags, providers?[], codes?[], status?[], wait{kind,...}, maxRetries, clampMs}`；有序、首个命中生效；未命中完全透传给内核执行器（行为与现状逐字节一致）。
- **7 种等待提取器**：`retry-after`（厂商 Retry-After/`providerRetryAfterMs`，可配缺省）、`duration-text`（`resets in 4h 5min` / `Try again in 23h 59m` / `quota will reset after 3h19m30s` / `quotaResetDelay: 33s`）、`duration-cn`（`请 1 分钟后重试` / `30秒后再试`）、`reset-at`（`您的限额将在 2026-09-22 13:45:14 重置`，时区参数，缺省按北京时间——智谱/Z.ai 报文不带时区）、`unix-seconds`（`usage limit reached|1760000000`）、`epoch-json`（`{"error":{"resets_at":…,"resets_in_seconds":…}}`）、`clock-time`（`请于 17:00 后重试`）。
- **护栏**：所有等待 clamp 到 [1s, clampMs]（默认 6h，硬上限 24h）；每规则每 turn 独立预算 `maxRetries`（turn 结束重置）；等待可被会话停止按钮或插件卸载取消；规则数上限 100。
- **14 组内置预设**（调研自厂商 SDK、生产网关与官方文档的真机报文，样本即测试夹具）：`glm-zhipu-cn`（5h/周限额中文）、`glm-zai-en`、`claude-anthropic`、`claude-code-usage`（unix 时间戳）、`codex-usage-limit`（结构化 resets_at）、`openai-rate`、`kimi-moonshot`、`deepseek-429-503`、`gemini-quota`、`cline-free-daily`、`factory-weekly`、`antigravity-quota`、`gateway-overload`（网关 CPU 过载/服务器繁忙，覆盖 PI_AI_ERROR 瞬时错误）、`relay-cn-misc`（中文中转站杂项）。一键导入后可自由编辑（导入是复制，不是活链接）。
- **规则编辑弹窗内嵌测试抽屉**：粘贴任意厂商报错文本（或一键填入预设样本）→ 即时显示是否命中、提取的等待时长与预计恢复时刻；全局等待上限（fallback）单独可调。
- 规则主存储：DSH 统一存储独立域 `agents_manager_retry` → 回退 `~/.dsh/agents-manager/retry.json`。

#### AI 工具（暴露给主代理）

会话内自动注册三个模型工具，支持「把厂商报错粘进对话让 AI 建规则」的工作流：

- **`read_retry_state`**：当前 provider 策略摘要 + 已存规则 + 最近 20 条失败（**含厂商报错原文**）+ 预设清单；
- **`test_retry_rule`**：候选规则 × 样本文本 → 命中与否、提取的 waitMs、未命中原因（先试后存）；
- **`write_retry_rules`**：校验 + 落库（默认按名合并，`replace:true` 整表替换，可同时设 fallback），描述中写明护栏与编码契约。

#### 监控（Tab 3）

- **进行中的等待**：规则名/provider、剩余时间倒计时（秒级刷新）、预计恢复时刻；来源标记（本插件规则 / 内核执行器）。
- **最近事件**：最近 100 条，两类行——重试行（`llm/retry` / `llm/retry-started`：时间、会话、provider、失败码、第 n 次重试、等待时长）与**未重试失败行**（引擎 miss 上报：`无规则可匹配 / 规则未命中，交由内核默认策略 / 本回合重试预算用尽`，相邻同类失败折叠计数），回答「为什么没重试」。
- **跨重启持久**：最近事件写 `~/.dsh/agents-manager/monitor.json`（原子写、环形 100 条、消息截断、fail-soft），宿主重启后设置页仍能看到历史；载入时未终态的重试行标 `expired`（等待随旧宿主死亡，绝不复活为 active）；关闭会话不再清掉它的历史行。

#### 工作原理

```
模型请求失败
  └─ agent/request-error waterfall（本插件 prepend 监听，先于内核 dsh-llm-retry）
       ├─ 规则命中 → 预算检查 → session.append('llm/retry', {mode:'plugin-rule', ruleName, delayMs, failure})
       │    → cancellableDelay（AbortSignal.any(会话signal, 插件lifetime)）→ llm/retry-started → {kind:'retry'}
       │    → agent-loop 在同一 open turn 内重跑该 step（与内核执行器同款语义）
       └─ 未命中 → next() 透传 → 内核执行器按 provider retryPolicy（normal/always）处理
```

- 事件先落盘再等待（durable-before-wait）：崩溃/取消后日志一致；等待为**进程内**等待，需保持 DSH 运行（与内核执行器同语义）。
- pi-ai 适配器把无法归一的中文/杂项错误标记为 `PI_AI_ERROR`（不可重试），且不解析 Retry-After 响应头——预设规则的 `codes` 覆盖 `PI_AI_ERROR/QUOTA`，匹配依赖 message 正文，这正是表达式层存在的原因。

## 架构

```
src/host/                 宿主半（Node，按组件行分包——cordis.patch.yml 声明 5 行，详情页逐行 Switch 启停）
  index.js                核心行（骨架，不可关）：agents-manager:core 服务（功能注册表、能力接缝 mountCapabilities、委派接缝、re-sync 钩子）、
                         agent/created 每会话工具注册（MCP 工具经能力接缝 + 各行功能工具 + skill 守卫）、共享 HTTP 路由挂载
  features/               四个功能行（各自注入 agents-manager:core，独立启停）
    capabilities.js       「MCP 技能管理」行：MCP supervisor/配置主存储、技能后端、会话选择、子代理能力预约、启动自检
    subagents.js          「子代理管理」行：角色 store + delegate_<role> 工具注册 + /subagents 路由服务
    retry.js              「自动重试」行：规则 store + 引擎 prepend 监听 + 监控 + AI 三工具 + /retry 路由服务
    processes.js          「进程看板」行：进程注册表 + report_service_process 工具 + 三层必掉 + jobs 桥 + /session/processes 路由服务
    registry.js           功能注册表：toolDefinitions/apiServices/contributions 聚合，/state.features 的数据源
  mcp/                    MCP 功能包（capabilities 行消费）
    config.js             mcpServers JSON 读取/校验/粘贴解析（含 zcode/codex 别名归一）；dsh 工具命名契约
    store.js              配置主存储：DSH 统一存储（storageDomain 域）→ ~/.dsh 插件文件兜底；~/.agents/mcp.json 一次性迁移
    supervisor.js         连接池（@modelcontextprotocol/client）、工具发现、测试连接、调用桥接
    agent-sources.js      一键同步：Claude Code / Codex(TOML) / zcode / Cursor 配置探测解析（跨平台 home 路径）
  skills/                 技能功能包（capabilities 行消费）
    store.js              ~/.agents/skills 扫描、SKILL.md frontmatter 解析、受版本校验的文件读写
    installer.js          GitHub 技能安装：路径解析、tar.gz 下载解析、技能目录识别与复制
  subagents/              子代理角色功能包（subagents 行消费）
    store.js              角色主存储：DSH 统一存储（独立域 agents_manager_subagents）→ ~/.dsh 插件文件兜底；角色/候选模型校验
    router.js             角色 → delegate_<role> 工具：schema（model 枚举 + 自定义描述）、startActivation 调用、结果/失败报告映射
  retry/                  自动重试功能包（retry 行消费）
    extractors.js         7 种等待提取器（正则语法移植自 magpie/hermes-agent/codex 等生产实现）
    presets.js            14 组厂商预设（智谱/Z.ai/Claude/Codex/OpenAI/Kimi/DeepSeek/Gemini/Cline/Factory/Antigravity/网关过载/中转站）
    rules.js              规则校验（正则可编译/组越界/码集合/clamp 边界）+ 匹配求值（首命中）
    store.js              规则主存储：DSH 统一存储（独立域 agents_manager_retry）→ ~/.dsh 插件文件兜底；domain 为空时一次性收敛文件规则（防后端翻转丢规则）
    engine.js             agent/request-error prepend 监听：规则命中 → durable 等待（先落盘 llm/retry 再计时）→ {kind:'retry'}；未命中透传内核执行器并上报 onMiss（no-rules/no-match/budget-exhausted）
    monitor.js            session/event + 引擎 miss 上报 → 进行中等待（倒计时）+ 最近事件环形缓冲（100 条：重试行 + 未重试失败行，跨重启持久化到 ~/.dsh/agents-manager/monitor.json）
    manager.js            provider 重试策略读写（ctx.settings.mutate 热生效）+ 内核策略校验镜像 + 路由→厂商标签推导（vendors/modelCount，10s TTL 缓存）
    tools.js              AI 三工具：read_retry_state / test_retry_rule / write_retry_rules
  session/                会话功能包（capabilities/processes 行消费）
    selection.js          每会话 MCP/技能选择状态（内存，随会话消失）
    pending-capabilities.js  委派角色→子代理的能力预约（单次消费、60s TTL；角色白名单∩会话选择）
    processes.js          会话服务进程注册表（内存，按根会话）+ 子代理→根会话解析器；存活探测与 SIGTERM→SIGKILL 停止；source auto/手动接管语义
    process-tools.js      report_service_process 回调工具（AI 启动服务后上报端口/pid/回显；成功回调消费 service-detect 标记）
    service-detect.js     三层必掉：服务启动启发式 + pending 表 + pre/post-execute 监听（标记→一次性 notice 提醒）
  http/                   对外接口（核心行挂载，服务来自各行 apiServices 聚合；行关则对应路由 501）
    api.js                HTTP JSON API（/agents-manager/api/v1，含 /mcp/* /skills/* /session/selection /session/processes* /subagents* /retry/*）
locale/<row>/{zh,en}.json 各功能行的详情页显示名与说明（meta.title/meta.description，DSH readPluginMeta 读取）
client/client.js          浏览器半（手写 CJS factory，无构建）：三个设置页（「MCP 和技能」双 Tab、「子代理」页、「自动重试」页：策略卡/规则编辑+测试抽屉/预设导入/监控）、Markdown 预览、树形技能编辑、chip 弹层 + 活跃会话探针、会话「进程」视图 tab、通知；/state.features 按行隐藏对应 UI
test/                     测试镜像同结构（node --test 'test/**/*.test.mjs'），fixtures/echo-server.mjs 为手写 stdio MCP 测试服务器
```

- 客户端与宿主通过同源 HTTP JSON 通信（`agents-manager/api/v1`）。
- 工具命名遵循 dsh-mcp-client 的 pinned 契约（`mcp__<server>__<raw>`，64 字符截断 + sha256 后缀），与官方桥共存不冲突（重名时跳过注册并告警）。
- 界面只使用 DSH 主题 token（`--dsw-alias-*`），明暗主题自适应；中英双语文案。

## 配置存储

- **MCP 主存储**：DSH 统一数据存储（`storageDomain` 域 `agents_manager`，表 `servers`，记录 schema zod 校验）。该服务不可用时自动使用 `~/.dsh/agents-manager/mcp.json`（写前备份 `.bak`）。
- **子代理角色主存储**：同一设施下的独立域 `agents_manager_subagents`（表 `roles`；域名必须独立，因为设施拒绝同名二次 open）。回退文件 `~/.dsh/agents-manager/subagents.json`。
- **导入源（只读）**：`~/.agents/mcp.json`，标准 `mcpServers` 格式：

```json
{
  "mcpServers": {
    "example": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-everything"],
      "env": { "TOKEN": "..." },
      "enabled": true
    },
    "remote": {
      "transport": "streamable-http",
      "url": "http://localhost:3000/mcp",
      "enabled": true
    }
  }
}
```

`transport` 可省略（有 `command` 即 stdio，有 `url` 即 streamable-http）。主存储为空时启动自动一次性导入；之后随时可在「粘贴配置」弹窗中读取导入。

子代理角色存储的 `{"roles": {...}}` 形态（即导入/导出格式）：

```json
{
  "roles": {
    "researcher": {
      "description": "调研类任务：网络检索与资料汇总",
      "promptPrefix": "You are a research specialist.",
      "enabled": true,
      "models": [
        { "provider": "magpie-responses", "model": "modelhub/GLM-5.3", "reasoningEffort": "high", "description": "主力推理线，100 万上下文" },
        { "provider": "magpie-anthropic", "model": "zcode/GLM-5.3", "description": "备用线路（ZCode 中转）" }
      ]
    }
  }
}
```

`preset`（可选 agent-preset id）与 `maxTokens`（可选输出上限）同样支持；角色名自动规范化为 `delegate_<kebab>` 的合法后缀。

## 版本兼容

- **内核版本门禁**：`package.json` 声明 `engines.dsh: ">=0.2.1-rc.5 <0.3.0"`（验证基线为 0.2.1-rc.5）。宿主在 profile 组合时做兼容预检：不满足则**启动时禁用本插件行**并在 stderr 输出 `disabling profile plugin "agents-manager": …`，不会静默半坏。
  - `>=0.2.1-rc.5`：下限——更老的内核没有本插件依赖的子代理契约，必须拦截；
  - `<0.3.0`：上限——0.x 的次版本号视为破坏性变更线；`0.3.x` 及其 rc 都会被拦下，等本插件重新验证后放宽。
- **依赖的宿主接缝**（升级内核时的核对清单，均在 0.2.1-rc.5 实测确认）：
  1. `ctx.subagents.startActivation`：`{provider:'spawn', delivery:'caller', request:{prompt,parent,agentOptions,agentPreset?,maxDepth?,cwd?}, signal, label}`，返回 `{childId, result:{output,stopReason,structured}, dispose()}`，`stopReason ∈ completed|error|max-tokens|refusal|aborted`；
  2. `ctx.subagents.resolveMaxDepth()`；`ctx.llm.resolveCallConfig / listProviders / listModels`；
  3. `ctx.storageDomain.open({name,version,tables,global})`（KV 域，同名二次 open 拒绝）；
  4. 工具注册：`agent/created` → `agent.ctx` 上 `tools.register({name,description,parameters,output,execute(args,exec)})`，`exec.agent`/`exec.signal`；`tools.get(name)` 冲突检查；
  5. `agent/request-error` waterfall（本插件 `ctx.on(..., {prepend:true})` 先于 `dsh-llm-retry` 执行器；未命中调用 `next()` 透传）与 `session/event`（`llm/retry`/`llm/retry-started` 已在内核 KNOWN_SESSION_EVENT_TYPES 内，非 surface）；
  6. `ctx.settings.mutate(ns, ops, revision)`（volatile 配置热更新路径，写 profile patch 并触发 `loader/volatile-update`）与 `ctx.llm.listProviders / listConfigurableProviders / providerRetryPolicy`；
  7. 客户端：`settings.section` 槽位注册（独立页 `id: agents-manager-subagents` / `agents-manager-retry`）、`conversation.input.left`（会话级 props：`sessionId` + 探针渲染）、`conversation.view`（「进程」tab，`id: agents-manager-processes`）、`shell.overlay`（通知注册）、`--dsw-alias-*` 主题 token；全部按 /state.features 行开关注入；
  8. 会话进程回显：`Session` 句柄的 `header.parentSession`/`header.origin`（子代理→根会话解析）与全局 `subagent/start` 事件（child→parent 兜底映射，字段防御式探测）；Node `process.kill`（信号 0 存活探测、SIGTERM/SIGKILL）；
  9. 三层必掉回调：`tools/pre-execute`/`tools/post-execute` waterfall（post 决策的 `additionalContexts` 前插通道，同内核 repeat-tool-reminder 用法）；`ctx.jobs.events.subscribe({owners:'all'})` 的 `registered`/`settled` 事件（`ctx.inject(['jobs'])` 可选注入，未组合时该层静默跳过）与 `JobView {id, kind:'bash', label, owner, status}`。
- **升级内核后的验证步骤**：`pnpm test` → 完全重启 DSH → 插件行应仍为 enabled（被禁用则按上方 stderr 原因处理）→ 新建会话确认 `delegate_<role>` 工具与 MCP 工具正常 → 设置页「子代理」无重启提示。
- **被门禁拦截时的处理**：优先重新验证后放宽 `engines.dsh` 并升插件版本；也可在 plugin_manager 授予版本豁免（有崩溃/数据损失风险，需对确切版本对明确确认），不作默认路径。

## 已知边界

- 插件激活前已存在的会话不会绑定 MCP 工具（工具在每个 agent 创建时注册）；重启 DSH 或新建会话即生效。
- **插件数据（MCP、子代理角色、重试规则）为部署级共享**：DSH 的 profile（`~/.dsh/profiles/<name>`）是组合层（决定装哪些插件），统一存储根 `~/.dsh/storages` 与 `~/.dsh` 下的凭据/会话本身就不按 profile 分区——本插件数据遵循同一约定；两个 profile 同时装本插件时共享同一份配置（单一事实源）。未来需要隔离时可按 `DSH_PROFILE` 对域名/回退路径加命名空间。
- 子代理委派为前台等待式（一次调用拿到结果或失败报告）；每次重试都是全新子代理会话（重复计费）。宿主 `maxActiveSubagents`（默认 8）满时启动被拒并在结果中提示。
- 失败报告为 provider 安全诊断文本，不解析 LLM 错误码；非模型故障（max-tokens / 中止 / 拒绝）不会附带换模建议。
- 角色工具在 `subagents`/`llm` 服务未组合的环境中不注册（设置页仍可编辑配置）；与官方 `dsh-mcp-client` 桥及原生 `subagent` 工具共存，重名时跳过注册并告警。
- 技能取消勾选后，模型仍可能看到技能名称列表（系统提示由宿主组装），但加载会被拒绝并提示。
- 无自动重连：服务器掉线后其工具调用会报「not connected」，在设置页重新测试/保存即重连。
- MCP 结果中的图片以占位文本呈现（不做宿主附件投影）；需要图片桥接时请改用官方 `dsh-mcp-client` 行。
- 插件激活期间本会话内对源码的修改不会热替换宿主模块；重启 DSH 后生效（客户端半刷新页面即可）。
- 技能编辑为本插件页内编辑器（Markdown 等文件以纯文本编辑，不做页内渲染预览）。
- **自动重试边界**：① 规则等待为进程内等待，需保持 DSH 运行（内核执行器同语义；DSH 重启后等待丢失，但 `llm/retry` 事件留在会话日志里）；② always 模式与规则重试都会**重复计费输入 token**；③ pi-ai 路由的 message 是网关转写文本——若中转站改写报错正文，预设可能匹配不到，此时用 `read_retry_state` 读取真实正文即时建规则（这正是暴露 AI 工具的目的）；④ 直接 `ctx.llm.stream()` 调用（不走 agent loop 的裸流）不会被任何一层重试（内核执行器同边界）；⑤ 等待期间会话可被用户停止（取消等待），但不会自动恢复。
- **会话进程回显边界**：① 注册表为内存态，DSH 重启/插件卸载后面板消失但**进程仍在运行**（AI 重新上报一次即恢复显示）；② 无 pid 的记录无法远程停止（绝不按端口杀进程）；③ 停止按 AI 上报的 pid 发信号，存在极小概率的 pid 复用误杀；④ 子代理父链不可解析时记录回退到调用者会话（面板归属退化但不丢数据）并 warn 一次；⑤ 会话关闭/归档不清除记录（进程可能仍在运行，停止按钮保留）。
- **三层必掉边界**：① 启发式为内置常量清单，可能误报（如脚本里真的要启动服务的复合命令）——误报代价仅一条 notice + 一条 auto 记录，可后续做成 Config；② auto 记录只有命令行（内核 JobView 不含 pid/端口），无停止按钮，等 AI 手动 report 同名接管后补齐；③ 结算提醒每 callId 一次，若模型在 notice 后仍不回调，兜底只剩 auto 记录（后台作业）或无记录（前台且 jobs 未组合）；④ `additionalContexts` notice 走 agent inbox 注入，仅在回合尚在推进时可见——回合已结束时注入的提醒会随下一条用户消息进入下一步。

## 开发

```bash
pnpm install     # 安装运行依赖与 React 生命周期测试开发依赖
pnpm test        # node --test 'test/**/*.test.mjs'
```

安装到 DSH：`plugin_manager install_bundle`，target 为本目录绝对路径（本地 link 安装）。
