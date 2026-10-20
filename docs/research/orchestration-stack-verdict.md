# 编排栈裁决：omo 上不了 opencode v2 之后（2026-10-19）

> **出处**：本文档撰写于 `D:\develop\ocrc`（`docs/research/orchestration-stack-verdict.md`），
> 随 REEVE 立项复制至此作为一手证据记录。文中出现的 ocrc 路径引用指的是那个仓库。
> **它是 REEVE 全部设计决策的依据来源**；[HANDOFF.md](../HANDOFF.md) 是它的可执行化版本。
>
> ⚠️ **本文档是 2026-10-19 的归档证据，其中若干条已被后续实测取代。**
> **读它之前先读 [opencode-v2-plugin-api.md](opencode-v2-plugin-api.md) §11 的逐条对照表**，
> 以及 [HANDOFF.md](../HANDOFF.md) 里标了"勘误"的段落。已知被取代的至少包括：
> §4.2 的挂载点写法（v1 钩子名）、§4.4① 的事件清单（`message.part.updated` / `question.*`）、
> §4.4③ 的惰性对账挂载点、§3.2 的 `SessionDomain` 方法清单、§7 的模型链表述。
> **不要按本文档直接施工。**

- **日期**：2026-10-19
- **性质**：决策记录。起因是 EL7 被控端从 opencode v1 + `oh-my-openagent`(omo) 迁往
  **openchamber + opencode v2**，而 omo 在 v2 上加载即失败。本文记录**调查所得的一手事实**、
  **据此做出的分层决策**、以及**尚未验证的开放项**。所有事实均有出处；推测处已标注。
- **结论一句话**：**不 fork omo**。把"模型回退""编排纪律""运行时记账""代码审查"拆成
  四个各自独立、许可各自干净的部分，分别落在代理层 / prompt+配置 / 薄插件 / 现成工具上。

## 0. 触发事实（为什么 omo 这条路断了）

### 0.1 上游明确拒绝把 omo 移植到 opencode v2

`code-yeongyu/oh-my-openagent`（原 `oh-my-opencode`，70,164★，SUL-1.0，默认分支 `dev`）
维护者本人在 issue **#9389**（2026-10-17）的原话：

> "We are **not taking the full port into this repo**: OpenCode 2 support here stays scoped to
> loading the plugin (#10439, tracked in #8485), and **the full omo experience is shipped as
> OmO Native**. Your fork remains the place for a complete OpenCode 2 port."

并在 **#10374**（2026-10-16）主动暂停了社区移植线：

> "We've **paused the OpenCode V2 dual-host track on our side for now**, so these PRs won't get
> a review while it's paused… Please **hold further slices** until we reopen the track."

这是一次**反转**：2026-10-01 他曾称双宿主是"we're consolidating on"的方向并要求社区拆成可评审切片；
社区交了三片（#9391 / #9415 / #10374），第三片到达**当天**整条线被停。

### 0.2 上游实际交付的"v2 支持"= 加载 + 弹广告

**#10439**（2026-10-18 合并，随之关闭 #8485）自述的全部范围：

> "On OpenCode 2 the plugin loads, and **every start shows a TUI toast that points to OmO Native**
> with the install command and guide link."

4 个文件（`packages/omo-opencode/src/opencode-v2/{server-entry,tui-entry,startup-notice}.ts`），
钉 `@opencode/plugin` 2.0.32。**零功能。**

`latest` = 5.1.35 的默认导出仍是 V1 形状 `{id, server}`；#8485 的结论原文是
"Workaround: **None**. The plugin cannot load at all in V2. Users must stay on OpenCode V1."

### 0.3 上游的方向是离开 opencode

- README 标题：**"OmO 5.0: OmO ❤️ Pi"**——"It runs on **senpi**, our fork of pi"。
- 安装改为独立二进制（`curl get.omo.dev/install.sh`）或 npm 包 **`omo-ai`**；配置搬到 `~/.omo/omo.jsonc`。
- 作者自己的迁移指南是 **omo(OpenCode 插件) → omo Native**，不是修 opencode 插件。
- ROADMAP 把适配器列为"OpenCode、Codex、Senpi 和独立 Pi"——**OpenCode 只是其中之一**。

### 0.4 fork 的真实代价（用于判定"自己 fork"）

| 项 | 数字 |
|---|---|
| 上游推进速度 | 17.2 天发 **31 个版本**（≈1.8 版/天）；v5.1.4→v5.1.35 = **3,580 commits / 300 files** |
| 待移植面 | `packages/omo-opencode/src` = **2,709 个 .ts / 364,421 行**；**347 个文件** import `@opencode-ai/*`（18 天后已涨到 353） |
| 现有社区 PR | #9016 (+3415/−24)、#9094 (+3530)、#8768 (+3233)、#8626 (+2716)——**全部 CONFLICTING**；唯一可合并的 #8297（122 行）**BLOCKED** |
| `fazulfi/omo-v2` | **不是移植是重写**：删 2,493 个文件（该包非测试 LOC 的 ~89%），剩 25,335 行；**V2-only**（v1 侧会失去 omo）；**18 天未动**；钉 `@opencode/plugin` 2.0.20（最新 2.0.32） |
| 会继承的 bug | 同一作者报的 **22 个 V2 adapter issue**（~20 开着）：#10173 丢 `parentID`（UI 里子会话变顶层）、#10174 按显示名列出导致派发失败、#10248/#10465 压缩与事件管线、#10245 **静默覆盖显式配置的 MCP**。**多数是静默失败** |

### 0.5 许可：SUL-1.0 与 MIT 的分野

omo 的 `LICENSE.md` 经 diff 确认**就是 n8n 的 Sustainable Use License，逐字照搬**
（除引号形状；n8n 的两条 carve-out 被去掉，故本仓覆盖全部分支）。

| 允许 | 禁止 |
|---|---|
| fork / 修改 | 改许可、再授权（**non-sublicensable**） |
| 内部业务使用（含营利公司，royalty-free） | 收费分发 |
| 公开分发——**仅限免费且非商业** | 作为付费产品/服务提供 |
| — | 去掉版权/许可声明 |

**关键**：**无 Change Date、无到期转宽松**（区别于 Elastic License 2.0）。限制**永久**。
→ **结论：omo 的代码与 prompt 字面不能进 ocrc（MIT）。**

**对照组**：`oh-my-opencode-slim`（alvinunreal，9,6xx★）是 **MIT**——可 fork、可抄、**可进 ocrc**。

## 1. 决策总览：四层各归各位

| 层 | 职责 | 形态 | 许可 | 为什么放这 |
|---|---|---|---|---|
| **代理层** | 跨 provider 回退、配额/限流/网络故障转移 | 独立服务（候选 Bifrost） | Apache-2.0 | **与 opencode 版本无关，永不随 API 漂移而腐烂** |
| **编排层** | 调度纪律、依赖图、文件归属、验收循环 | **prompt + agent 定义** | 自写 | v2 原生已给足机制；这层是"文本"，迭代最快 |
| **记账层** | 子任务台账、静默死亡、在飞查询、墙钟、并发 | **薄插件** | 自写（可抄 MIT 的 slim） | v2 原生缺这八条，且**只**缺这八条 |
| **审查层** | 代码 diff 的独立审查 | 现成工具（OCR） | Apache-2.0 | 上游活跃且已支持 opencode v2，跟随比自己拥有便宜 |

**明确不做**：fork omo（上游已放弃该面 + 永久 SUL-1.0 + 1.8 版/天漂移）；
把回退做进插件（会随 v2 API 漂移一起烂）；vendored 任何 SUL-1.0 内容进 ocrc。

## 2. 代理层（回退）

### 2.1 为什么下沉到这里

- **数据证明回退是命根子**：EL7/本机 `opencode.log`（27 MB）里 1,045 条 ERROR——
  `exceeded your current quota` ×196、`Insufficient Balance` ×29、upstream rate limit ×26、
  Bad Gateway ×32、Service unavailable ×30、Authorization Required ×20、socket/TLS ×102。
  **`mode=primary` 505 次 vs `mode=subagent` 218 次**——**orchestrator 自己也频繁撞墙**。
  74 个会话中途换过模型，其中一个轮了 9 个。
- **opencode v2 自身零跨 provider 回退**（schema 无 fallback 字段；只有同模型重试 + 指数退避，
  且 auth/quota/content-policy **不重试**）。功能请求 #7602/#55008/#48991 全部关为 duplicate 或挂着。
- **插件层的回退只在插件正常加载时生效**——而配额耗尽恰恰是最容易让整条链崩的场景。

### 2.2 候选筛选（EL7 约束：glibc 2.17 / Python 3.6 / 不保证 Docker）

| 候选 | EL7 可跑 | 许可 | 结论 |
|---|---|---|---|
| **LiteLLM** | ❌ 要 Python **3.10+** 或 Docker（Alpine）；**无独立二进制** | MIT | 功能最全，EL7 上装不了 |
| **Bifrost** (`maximhq/bifrost`) | ✅ **静态链接 Go 二进制**（`file` 实测 `statically linked`，不依赖宿主 glibc） | Apache-2.0 | **首选** |
| new-api | ✅ Go 二进制 | ⚠️ **AGPL-3.0** | 许可顾虑 |
| Portkey Gateway | ✅ Node/TS（可用已有的 Node 24 glibc-217） | MIT | 备选 |
| ~~one-api~~ | — | MIT | **已废弃**（最后提交 2025-02） |

### 2.3 Bifrost：已确认的两件事

**① routing rules + TTFT 截止是 OSS，无门禁。** 证据：
`docs/docs.json` 的 OSS tab（52–316 行）含 `providers/routing-rules`，Enterprise tab（317–431）
全是 HA/RBAC/审计/guardrails；v2.3.0 的 **OSS changelog** 明写 TTFT 是 OSS 特性；
`plugins/routing/rules/engine.go` 零处 license/enterprise 引用；路由插件在 OSS 构建**无条件注册**。

**② 响应体 `model` 字段回的是"被服务的模型"，不是调用别名。** 源码：
`core/schemas/utils.go` 的
`// ServedModel returns the model the provider named on the response body. It can differ from the model the caller addressed.`
别名另在响应头暴露（每条路由都有）：`x-bifrost-routing-info-requested-model` /
`-model` / `-alias-model-id` / `-is-fallback`；响应体 `extra_fields.routing_info.*`。
（对比：**LiteLLM 文档明写响应体保持调用别名**，符合 OpenAI 约定。）

### 2.4 反向证据（必须记）

opencode 官方关闭的 PR **#26292**（"add LLM provider fallback chain"）给出的反对理由：

> "Why built-in instead of a proxy: cheaper providers are unreliable, and **routing through
> LiteLLM degrades tool-call quality**."

实锤：opencode issue **#56124** —— 前面挂 LiteLLM 撞到
`UnsupportedParamsError: Bedrock doesn't support tool calling without tools= param`。

**缓解**：**只做 OpenAI 兼容端点之间的纯透传，不做任何格式翻译。** 上述 bug 源于跨 provider
翻译；透传（同一请求换 endpoint 重发）绕开它。代价：原生 provider（`zhipuai-coding-plan`、
`deepseek`、`opencode`、`xiaomi`、`alibaba-cn`）需改写成 `@ai-sdk/openai-compatible`
自定义 provider 指向代理。

### 2.5 其他已知约束

- 二进制**不在 GitHub Releases**（所有 tag assets=0），只在 `downloads.getmaxim.ai`；~128 MB。
  **air-gap 分发要单独设计。**
- 改 `config.json` **要重启**；热改走 `POST /api/routing/rules`。
- **文档坑**：`governance.mdx` 示例写 `cel_expression: "request.model == 'gpt-4o'"`，
  但引擎注册的变量是 `model`（字符串），`request` 是**数值型预算变量**。正确写法 `model == "router/flash"`。
- `fallbacks` 用 `"provider/model"`；写 `"provider/"` 表示**同模型换 provider**。

### 2.6 决定性未知已解决：opencode 不理会响应体里的模型名（2026-10-19 实测）

**结论：opencode v2 在后续回合重发的是"调用者请求的模型名"，与响应体 `model` 字段无关。**
故 Bifrost 返回"被服务模型名"的行为**不影响 opencode 的路由**。→ **Bifrost 可用。**

实测记录（方法见 §8 实验）：

- 隔离栈跑 `opencode 2.0.32`，自定义 provider 指向本地桩服务，模型 id = `router/flash`
- 桩对**每一个**请求都返回 `"model": "SERVED-MODEL-X"`（调用者从未请求过的名字）
- **同一会话连发 4 轮，桩收到的 5 次请求全部是 `model: "router/flash"`**
  （第 3、4 轮**不带 `--model` 标志**，纯靠会话记忆 —— 仍是 `router/flash`）
- **数据目录里没有任何文件出现过 `SERVED-MODEL-X`** —— opencode 从未记录被服务的名字
- 响应模型名与请求不符时**没有报错、没有警告**

（此前担心的同族问题 opencode **#53060** "model cached per session pins subagents to a fallback
provider" 描述的是**插件调用 `session.switchModel`** 造成的行为，与本场景不同。）

**推论**：代理层可以放心用"虚拟别名"模型。别名是 opencode 侧唯一知道的名字，
链在代理内部随意变化，对引擎完全透明 —— **这正是把回退下沉到代理层的前提条件，现已成立。**

**源码级佐证（独立于实验，2026-10-19）**：在 `anomalyco/opencode` 的 `dev`(=v2, 2.0.32) 与
`v1.19.3` 两个 ref 上核实，机制一致：

- v2 里模型是**会话行的一列**（`Model.Ref` = providerID + catalog id + variant），
  唯一写点是 `SessionEvent.ModelSelected`，其唯一发布者是 `Session.switchModel`，
  而它的三个调用方**全部传请求侧的 ref**（服务端 `session.switchModel` API、
  `subagent` 工具的 `model` 参数 / agent frontmatter、插件面）。
- **没有任何代码读响应体的 `model`**：`LLMResponse` 结构里根本没有 model 字段；
  OpenAI-chat 的流式事件 schema 只声明 `choices`/`usage`/`error`，**响应 `model` 连解析都不解析**；
  AI SDK 桥接对 `response-metadata`（正携带 served modelId 的那个事件）**显式返回空**。
- 全仓搜 `servedModel` / `responseModelID` / `model_mismatch` → **各 0 命中**。

**对得上号的 issue 是 #38543**（不是 #53060）："Assistant message modelID records the requested
model, never reconciled against the provider response"——**已由 stale bot 以 `not_planned` 关闭**，
提案（捕获 `responseModelID` 并在不匹配时告警）从未实现。其中一条评论给了真实路由器的实测：

> 配 `openrouter/free`，OpenRouter 解析到具体模型并在响应里返回，
> 而 opencode **记录并持续显示请求的名字**（`openrouter/free`），不做对账。

（#53060 是**相邻但不同**的问题：agent frontmatter 的模型在 catalog 里查不到时，
子 agent 被静默切到另一个 provider 并冻结整个会话——触发源是 catalog 查找失败 +
`subagent` 工具显式 model 的优先级，不是代理替换模型。至今未修。）

**两条必须一并规划的限制**：

1. **opencode 永远不会告诉你实际是谁服务的。** 响应模型名不捕获，**响应头也被丢弃**
   （issue #26091，其评论里**点名 Bifrost** 的 `x-bifrost-resolved-model`）。所以
   UI 标题、`opencode stats`、会话导出、**成本记账全部按别名计**。
   → **"哪个 provider 真的服务了这次请求"必须在代理侧记账**（Bifrost 有 `served_model` 日志列），
   否则配额归因和成本分析会失真。
2. **别名必须在 catalog 里可解析**，否则 `SessionRunnerModel.resolve` 抛
   `ModelUnavailableError`（v2）——这正是 #53060 的失败形态。**别让别名从 catalog 里消失。**

**顺带一个可用的原生原语**：v2 有官方的 **Aliases** 特性——provider catalog 条目里的
`modelID` 决定"发给 provider 的名字"，而 catalog 的 `id` 是用户可选的名字。即
`{"model":"openai/coding-default", "providers":{"openai":{"models":{"coding-default":{"modelID":"gpt-5.2"}}}}}`
中 `openai/coding-default` 是可选项、`gpt-5.2` 是实际发出的名字。
**这正是"虚拟别名"的原生表达方式**，可以少写一层自定义 provider 配置。

**但另一条仍需实测**（见 §8）：代理在**流已经开始之后**才失败时，返回的是 HTTP 200 + 一个
错误事件，而非 HTTP 错误。这类"半截流"必须由代理在**首 token 之前**决定回退（Bifrost 的
`ttft_timeout_ms` 正是为此），否则客户端会把截断的流当成功。**这一条尚未验证。**

## 3. 编排层（prompt + agent 定义）

### 3.1 v2 原生给足了什么（零代码）

`subagent` 工具（v1 叫 `task`），参数 `agent` / `description` / `prompt` / `model` /
`sessionID` / `background`：

- **前台调用同步返回**，结果作为工具结果进入父 agent 上下文
- **后台调用（`background: true`）立即返回**，子任务终止时宿主注入
  `<subagent sessionID="…" state="completed">…</subagent>` 到父会话**并唤醒父 agent**
  （源码 `packages/core/src/session/subagent-completion.ts` 的 `sessions.synthetic(...)` +
  `execution.wake()`）；空闲父会话收到新回合，忙碌父会话收到 steer
- **每 agent 独立 `model` / `system` / `permissions`**——markdown frontmatter 或 JSONC，零插件
- 原生把 `Available subagents:` 名册注入工具描述；父 agent 可用 `subagent` 权限白名单限制可派对象
- `experimental.subagent_depth` 默认 **1**（需要多层要显式放开）
- v2 键是复数 **`agents`**（v1 单数 `agent`）；`prompt`→`system`、`permission`→`permissions`、
  `maxSteps`→`steps`、`variant` 以 `#variant` 后缀出现

**顺带纠正一个流传的说法**：`OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` 是 **v1-only** 变量，
**v2 里不存在**（v2 删掉了整个 flag 模块），后台 subagent 在 v2 是无条件的。

### 3.2 v2 原生缺的八条（= 记账层的需求来源）

| # | 缺什么 | 性质 |
|---|---|---|
| 1 | 没有 `task_status`（v2 删了）→ 无法查询在飞任务 | 代码 |
| 2 | **没有停止任务恢复** → 子任务静默死掉，父 agent 永远不知道 | 代码 |
| 3 | 没有周期性 orchestrator 唤醒 | 代码 |
| 4 | 没有 `task_message` / `task_cancel` / `task_revive` | 代码 |
| 5 | 没有 `todo` 工具（v2 删了） | 代码或 prompt 约定 |
| 6 | 没有并发上限 | 代码 |
| 7 | 没有墙钟超时 | 代码 |
| 8 | 没有 orchestrator prompt 与调度纪律 | **纯 prompt** |

**关键约束**：**v2 不把 `session.list` / `session.remove` / `session.status` / `session.todo` /
`session.children` 交给插件**。因此第 1/2/3 条**不能靠询问宿主**——插件必须**自持并落盘子会话台账**。
这条决定了记账插件的骨架。

### 3.3 omo 的 orchestrator prompt 解剖（借思路的来源）

`Sisyphus` 在 omo v4.19.4 的 `dist/index.js`（5.7 MB / 178k 行，未压缩）里位于 151861–156565，
**不是一个 prompt 而是 11 个模型族变体**，由 `resolveSisyphusPromptFamily` 分派。
`sisyphus.model = zhipuai-coding-plan/glm-5.3-flash` → **走 `glm-5-2` 变体**。

**三个对本次决策有直接价值的发现**：

1. **同一 omo，换模型就换一套编排哲学。** GLM 变体的委派段说
   **"是单个显而易见的改动就直接做"**；而 Claude-Opus-5 变体反而在**反过度委派**：
   **"你比工作本身需要的更爱用子 agent……几次工具调用就能干完的活，自己做"**。

2. **最强硬的一段（`buildParallelDelegationSection`）触发条件是 `deep` 或 `unspecified-high` 存在**：
   > 该段的立场：**拆解并委派——你不是实现者**；它把"自己动手"点名为**失败模式**，
   > 并要求**能委派时绝不直接实现**、**"你写的是 prompt，不是代码"**。

   → 用户有 `unspecified-high`，故**该段生效**（此前"可能没装防呆"的猜测不成立）。

3. **category 不是 agent。** `resolveCategoryExecution` 把每一个 category 都解析到同一个
   junior agent 常量 —— **8 个 category 全部派给同一个 `Sisyphus-Junior`**，
   只是模型档不同。真实拓扑比配置看起来简单得多。

**最值钱的三段（说扛住大部分效果、也最便宜移植）**：
- **意图门 + Context-Completion Gate**——"当前这条消息里没有明确实现动词就不许改文件；上一轮的
  '实现模式'不许跨轮继承"
- **反重复 + "结束你的回复，等通知"**——派出去之后不许自己再搜一遍，也不许轮询
- **"没有证据 = 没完成"**——改文件要 lsp 干净、跑命令要退出码 0、跑测试要过

### 3.4 omo 的两处必须改（这是"拥有编排"的直接论据）

**(a) `momus`（计划评审）被设计成"别挡路"，与需求方向相反。** 其 prompt 的立场（**转述，非原文**）：

> 它明确要求**在有疑问时倾向批准**，认为计划"**八成清楚就够了**"；
> 把"**强制多轮修订**"列进"不做"的清单；对每次驳回的问题数**设上限**；
> 并自我定位为"**找阻断项的人，不是完美主义者**"。

而需求是"**多轮次多角度评审**"。**从 omo 里拿不到这个纪律，除非改 prompt——一旦改了，你就拥有了它。**

> **⚠️ 许可处理（2026-10-19）**：本段与 §3.3 原先含 omo prompt 的**英文逐字引用**，
> 已改为中文转述——`NOTICE.md` 的提交门禁禁止把 omo 的 prompt 字面留在仓库里（SUL-1.0）。
> 论证不受影响；需要核对原始字面时，去上游源码（引用索引 §10 给了函数名与行号）。

**(b) omo 的"证据"是自述的。** 它的"证据要求"只是**改完文件后 LSP 诊断干净、测试跑过**
——而且这些结论由**子 agent 自己声称**。对"agent 会欺上瞒下"这个已知问题，这等于没有证据。

→ **架构约束（由需求推出）**：**证据必须由 orchestrator 独立复现，不能由 subagent 自述。**
验证者不能是执行者，且拿到的是**产物本身**（diff、文件、真跑一遍），不是那份报告。

### 3.5 目标工作流：四阶段

```
1. grill    → 问清背景/目的/实施路线，产出需求定稿      （omo 的 metis 是此角色的现成参照）
2. plan     → 写自包含的实施文档（context-free 可执行）
3. 计划评审  → 多轮 × 多角度，直到通过                  （严格版 momus + oracle；OCR 不覆盖此阶段）
4. 执行+验证 → 便宜模型照文档干；orchestrator 亲自拿产物验 + OCR 独立审 diff
```

**"不携带上下文的 subagent 也能看得懂的实施文档"这条约束很值钱**：它意味着**文档是接口**，
智力集中在文档里，执行可用便宜模型——正好接上整套免费档策略。

### 3.6 现有配置里的两个真问题（迁移时顺手修）

1. **`deep` 是幽灵档位。** 用户把内置 `deep` 改名成了 `deep-low`，但 `mergeCategories` 是
   `{...内置, ...用户}`——**改名不等于删除**，内置 `deep` 仍在，指向 `openai/gpt-5.6-sol` 且带
   `requiresModel` 门禁。用户 provider 里没有该模型 → **orchestrator 一旦选中 `deep` 就报
   "Model not configured for category"**。其余七个内置档位用户都覆盖了，**只有 `deep` 漏了**。
2. **`deep-low` 与 `ultrabrain` 的模型链逐字相同**，无区分度（注释却写 "TIER1: ultrabrain / deep"）。

## 4. 记账层（薄插件）

### 4.1 需求（用户确认：四条全要）

| 需求 | v2 原生 | 说明 |
|---|---|---|
| 子任务静默死亡的通知 | ❌ | 子任务死了，父 agent 永远不知道 |
| 在飞任务查询 | ❌ | v2 删了 `task_status`；重启/丢通知后查不到 |
| 跨重启续跑 | ❌ | 宿主不给会话列表，只能自持台账 |
| 墙钟超时 | ❌ | 子任务卡死没人掐 |
| （并发上限） | ❌ | 峰值约 88 个重叠子任务，无上限是失控风险 |

### 4.2 骨架（五处挂载点）

```
① 拦 subagent 调用（execute.after）
   → 拿返回的 { sessionID, status }，连同 agent/description/父会话 → 落台账
② 订阅事件：session.execution.succeeded/failed/interrupted
   → 命中在飞子任务 → 标终态、撤计时器
③ 每条子任务一个计时器（wall-clock）→ 超时 → 中断 + 标 timed_out
④ 派发前的闸门（concurrency）→ 在飞计数 ≥ N → 排队，不 spawn
⑤ 台账落盘 + 对账 → 非终态记录标 unknown → 父会话下次活动时补通知
   ⚠️ **这是全篇唯一没有参照实现的一块**：omo-slim 的台账**不落盘**（§4.4 ③），
      恢复是惰性 + 从父转录重建 + 不续跑。真正的"跨重启续跑"要自己设计。
```

**体量估计**：骨架约 500 行；**真正的难点是静默失败的边界**——例如必须能区分
"宿主已发过终态通知"与"没发过"，否则会把每个正常完成的子任务都误报成死亡。
**这类系统里最贵的 bug 不是崩溃，是静默不一致。**

### 4.3 与面板零冲突

记账插件**不碰 agent、不碰 model**——只注册工具 + 挂 hook。因此**不会重演 omo-slim 与
openchamber 抢 agent 配置的问题**（面板保存 agent 会写出盘上覆盖文件，按 omo-slim 自己的
优先级 `opencode.json` 的 agent 条目是终局覆盖，会静默压掉预设——openchamber#3881）。

### 4.4 omo-slim 的实现解剖（v3.0.5，MIT，抄代码的来源）

架构主干：`BackgroundJobBoard`（状态）← `BackgroundJobCoordinator`（单写者 + 监听分发）←
`BackgroundJobStore`（接口）← `BackgroundJobTerminalGate`（终态判定边界）+
`BackgroundJobSupervisor`（墙钟）+ `BackgroundTaskConcurrency`（准入）。

**① 静默死亡：没有"子任务死了"这个事件，全靠推断。**
`ctx.event.subscribe()` 只给 `session.created/idle/status/error/deleted`、`message.part.updated`、
`question.*`、`permission.*`。判定来自三处证据：宿主 live-status（**5 秒轮询**，
`RUNTIME_STATUS_RECONCILE_DELAY_MS`）、子会话转录分类（`classifyTerminalEvidence`）、
宿主会话自身的 `outcome` 字段。
**关键设计**：`session.idle` 只是**候选**，不立即判定终止；只有当转录判定为 `absent`
**且**静默已持续超过宽限期才落 `stopped`：

```ts
const stable = now() - Math.max(value.quiescentSince ?? now(), token.attemptStartedAt ?? 0) >= graceMs;
if (evidence.verdict === 'absent' && stable)
  return commit(token, 'stopped', STOPPED_WITHOUT_TERMINAL_RESULT, undefined, 'transcript');
```

`STOP_CONFIRMATION_GRACE_MS = 5_000`。**这就是我警告过的"静默失败边界"的实际解法**——
先用宽限期把"正常完成的最后一刻"和"真的死了"分开。任何无法证明为终态的一律保持
`running` + `statusUncertain`，并排一次重试（默认 3 次）。
另有发现：`noteStopConfirmation` / `stopConfirmationStartedAt` 这套 API **在生产里没有调用者**
（只有测试），真正的宽限实现在 terminal gate 内部。

**② 台账：全在内存，`Map`，零磁盘文件。**
`BackgroundJobRecord` 约 30 个字段（`taskID/parentSessionID/agent/state/generation/
terminalRevision/activityRevision/statusUncertain/timedOut/terminalUnreconciled/...`）。
`state ∈ running|completed|error|cancelled|stopped|reconciled`。
**台账本身就是子会话注册表**（因为 v2 不给 `session.list`）：子会话 id 来自
`session.created` 事件与 `task()/subagent()` 工具输出解析。键就是子会话 id。

**③ 跨重启：不存活——这是硬事实（未决 #2 的答案）。**
文档与源码三处明确：
- `docs/background-orchestration.md`：*"Aliases and reusable-session history are process-local and
  **do not survive process restarts** as a reusable board. Post-restart recovery is **partial and
  best-effort**."*
- `task-status.ts` 直接对模型说：`` `Task ${identity} is not tracked by the local background job
  board (its tracking does not survive a host or plugin restart).` ``
- `session-recovery.ts`：*"Tracking does not survive a host restart; verify whether the host
  restored it before re-dispatching."*

**只有墓碑与删除纪元持久化**（v2 `ctx.storage` 键值域，键 `omo/bgj/tombstone/<taskID>` /
`omo/bgj/epoch/<taskID>`，≤500 条；**别名不持久化**）。v1 宿主上是纯内存 no-op。
**恢复是惰性的**：`rehydrateHistoricalRunningTasks` 唯一调用点在
`experimental.chat.messages.transform` 钩子里 —— **下一次聊天请求时才跑，不是启动时**。
它从**父会话的持久化消息历史**里找出 output 仍是 `running` 的 `task` part，重新登记，
再 fire-and-forget 探一次 `session.get`：`NotFoundError` → 墓碑 + 拆毁；有终态 outcome → 落终态；
子会话缺失/空闲 → 停止候选（宽限期后落 `stopped, unreconciled`）；其他 → fail-open。
**它不尝试恢复执行。**

→ **推论：真正的"跨重启续跑"没有现成实现可抄。** 上游做的是"从父转录里重建在飞任务并
如实标未知"，不是续跑。**这一条要自己设计**，且源数据只能是父会话转录（因为宿主不给会话列表）。

**④ 墙钟：每任务一次性定时器 + 宽限。**
`BackgroundJobSupervisor` 只监督 `background === true` 的任务；只对新 `generation` 重新武装；
**忙碌/工具活动/存活信号都不续期**。到期后：先武装宽限定时器（`abortGraceMs` 默认 10s），
再发**恰好一次** `client.session.abort`（v2 映射为 `s.interrupt({sessionID, resume:false})`）。
宽限到期仍未确认 → 标 `statusUncertain` 并落 `error, timedOut:true, terminalUnreconciled:true`。
**已发布的硬超时不可被迟到的完成/忙碌替换。**

**⑤ 并发：在 `tool.execute.before` 里排队（子会话创建之前）。**
`BackgroundTaskConcurrency` 保持 `waiting` 队列 + `active` 集合；档位解析
**模型上限 > provider 上限 > 默认上限**，`0`/缺省 = 无限。两条正确性性质值得抄：
**(a) 嵌套的受管任务豁免**（它们已持槽，再等会自死锁）；
**(b) 调度器按目录进程级共享**（`acquireAdmissionRuntime`），插件重载后保留运行中槽位与排队票。

**⑥ 许可**：MIT，标准文本，`Copyright (c) 2025`，**`src/**` 下无任何 per-file 版权头** ——
抄代码只需带上顶层 `LICENSE` 与声明，无其他文件级约束。

### 4.5 为什么"自己写"而不是整体用 omo-slim

| | 判断 |
|---|---|
| A **自己写薄插件**，参照 omo-slim 实现（MIT，**可合法抄代码**） | ✅ **推荐** |
| B 整体用 omo-slim | ❌ 会把它的 orchestrator prompt 与 agent 阵容带进来——**那正是要自己拥有的**；外加抢 agent 配置、`/preset` 面板不可见、EL7 上 AST 工具死 |
| C fork omo-slim 再裁到只剩记账 | ❌ 剥离它纠缠的编排部分本身就是主要工作量，剩下那点自己写更干净 |

**关键对照**：`oh-my-opencode-slim` 是 **MIT**——**借思路和抄代码都合法，且可进 ocrc**；
omo 是 SUL-1.0，**只能借思路**。这个区别是"自己写"路线成立的前提。

## 5. 审查层（OCR）

### 5.1 项目确认

**`alibaba/open-code-review`**（品牌 OpenCodeReview，CLI `ocr`）——
47,590★ / **Apache-2.0** / Go / **v1.13.1（2026-10-17）** / 昨天仍在推。
中文 README 自述："它的前身是阿里集团内部官方 AI 代码审查助手，过去两年在内部服务了数万开发者"。

架构：**确定性管线 + LLM agent**——文件筛选 → 语义分组（只读元数据做一次 LLM 调用）→
每组分派（默认并发 8）→ 评论管线（行号定位 → 重定位 → **过滤可证明错误的评论**）。
LLM 只能通过 6 个工具干活。

### 5.2 三个对本次决策有直接价值的发现

**① 已有官方 opencode 插件，且是 V1/V2 双形态。**
`plugins/open-code-review/opencode/open-code-review.ts`，注册 `ocr_review` / `ocr_health`
工具与 `/ocr-review`、`/ocr-health` 命令。自述：
*"The single plugin file serves both versions: V1 reads its `server` entrypoint, V2 reads its
`id` + `setup` entrypoint."* ——**正是本仓库正在解决的 V2 注册问题，它已经解了。**
调用方式"参数数组 + `shell: false`"，30 分钟超时，10 MiB 输出上限。

**② 多轮评审是一等公民，且对"轮次"的理解可借鉴。**
`--effort low|medium|high` = 每组 **1/2/3 轮**。原文：
> "Each round after the first re-runs MAIN_TASK with the findings already confirmed by earlier
> rounds injected as `{{confirmed_comments}}`, and **without the plan** — a plan tends to act as
> a coverage ceiling once the obvious issues are found."

**③ 它在结构上对付"欺上瞒下"。** 每条评论是结构化 JSON：
`path` / `start_line` / `end_line` / `existing_code` / `suggestion_code` /
`severity`(critical|high|medium|low) / `category`(bug|security|performance|maintainability|test|style|documentation|other)
——**后两个必填**；行号用滑动窗口对 diff，**对不上就诚实标 `0`（unanchored）**；
另有 `REVIEW_FILTER_TASK` 专门删掉可证明错误的评论；`--format json` / `--audience agent`。

→ **这是"证据"而非"自述"**：判断过程被拆成可审计步骤，比"orchestrator 自检"强。

### 5.3 错位与约束

- **OCR 审的是代码 diff，不是实施计划**（输入是 `--from/--to`、`--commit`、`--scan`）。
  故它落在**第 4 阶段**，不覆盖第 3 阶段。
- **硬门禁：`git >= 2.41`**（`internal/gitcmd/version.go` 的 `gitVersionMin`，启动时检查）。
  **EL7 自带 git 1.8.3** → 必须先装新 git（源码编译或 SCL/EPEL）。
- 静态 Go 二进制（`CGO_ENABLED=0`），**不依赖宿主 glibc**；不需要 Docker；不需要 GPU。
- ⚠️ **npm 包装器会联网自更新**（每次运行后台查 registry 并自动升级）→ **用静态二进制绕开**。
- `ocr delegate preview|rule` **不需要任何 LLM key**（OCR 只做确定性部分，评审由宿主 agent 的模型做）。
- 规则四层优先级：`--rule` → `<repo>/.opencodereview/rule.json` → `~/.opencodereview/rule.json` → 内置；
  `"merge_system_rule": true` 可叠加而非替换。
- 规则文档 60+ 语言/格式，默认五维；但**Java 企业栈指纹明显**（MyBatis/Maven/FreeMarker/NPE/线程安全）。

### 5.4 融合建议

**分两步，先当工具再谈融合**：
1. **当独立审查工具接进来**（不改它）：用它的 opencode 插件，在第 4 阶段调用，拿结构化 JSON
   当**证据**喂给 orchestrator。**先解决 EL7 的 git 版本问题。**
2. **把它的"多轮 + 过滤 + 前递"设计借到第 3 阶段的计划评审 prompt 里**（纯文本借鉴）。

**不建议一开始就 fork 或深度改造**：它 47.6k★、两天前还在发版、有官方 opencode 插件——
**跟随比自己拥有便宜得多**。这与 omo 的处境正好相反。

**门禁 vs 建议**：建议**先是建议**（`critical`/`high` 不通过不卡流程），跑一段时间看误报率，
再决定哪些 severity 升级成门禁——因为它的规则有 Java 栈倾向，直接当门禁可能误报。

## 6. 许可矩阵（决定"什么能进 ocrc"）

| 件 | 许可 | 借思路 | 抄代码 | 进 ocrc(MIT) |
|---|---|---|---|---|
| omo | **SUL-1.0**（n8n 版，无 Change Date） | ✅ | ❌ | ❌ **永久不可** |
| **omo-slim** | **MIT** | ✅ | ✅ | ✅ |
| **OCR** | **Apache-2.0** | ✅ | ✅ | ✅ |
| **Bifrost** | Apache-2.0 | ✅ | ✅ | ✅ |
| openchamber | MIT | ✅ | ✅ | ✅ |

**实践规矩**：私有配置仓库（`D:\develop\OpenCodeConfig`）内可自由抄 omo；
**进 ocrc 的一律干净重写**（以 omo 为参照，不逐字抄）。

## 7. 实证附录：使用数据（678 个会话，2026-07-26 → 10-04）

数据源：`~/.local/share/opencode/opencode.db`（4.3 GB SQLite，`session_v2` + `session_message`）。

- **35 个顶层 / 643 个子会话（95%）**——派发是主导模式
- **深度**：1 层 500、2 层 139、**3 层 4**（最大 3）
- **并发**：25 个父会话有生命周期重叠的子会话；峰值一个父会话 **约 88 个**；
  `~/.omo/run-continuation/` 有 **37,466 个**状态文件
- **agent 分布**：`multimodal-looker` 239、`general` 169、`Sisyphus-Junior` 73、`librarian` 64、
  `explore` 47、`Sisyphus - ultraworker` **32（唯一顶层编排者）**、`oracle` 27、`Momus` 15、
  `plan` 7、`build` 3
- **死配置**：`metis` / `prometheus` / `atlas` **0 会话**；`lmuai/glm-5.3-flash` **0 命中**
- **成本**：$19.62 / 344.3M 输入 / 7.6M 输出

**由此得到的编排目标**（比配置看起来小得多）：

```
orchestrator × 1（Sisyphus 类）
子 agent：general / librarian / explore / oracle / momus / junior
（multimodal-looker 可撤——模型已普遍多模态，其残余价值只是上下文卸载；
  metis 是"grill 到清楚"的现成参照但当前 0 使用）
```

**已知的两处声明与实际的偏离**（迁移时修）：
- 当前 5.0.0 的链里 `lmuai/glm-5.3-flash` 零命中，而真正扛住 8–9 月负载的
  `wawapi-glm` / `xxyapi-glm` / `deepseek/deepseek-v4-flash` / `opencode/*-free` **都不在当前链里**
- 配置钉 `oh-my-openagent@5.0.0`，实际装的是 **4.19.4**；且 fallback 依赖**已废弃的
  `fallback_models` 键**（配置注释自述"等上了修好的 beta 再删"）
  → **"回退不靠谱"很可能部分源于此版本错配，而非 omo 设计**

## 8. 未决项

### 8.1 已解决

| # | 问题 | 结论 | 证据 |
|---|---|---|---|
| 1 | opencode 后续回合发回哪个模型名 | **发调用者请求的别名**，与响应体无关 → **Bifrost 可用** | 实验记录见 §8.3 |
| 2 | omo-slim 台账跨重启行为 | **不存活**（进程内 `Map`）；恢复是惰性的、从父转录重建、不续跑 | §4.4 ③ |
| 3 | omo-slim 四条记账的实现细节 | 已解剖到函数级（终态门、墙钟监督器、准入队列） | §4.4 |

### 8.2 仍未决

| # | 未决 | 影响 | 怎么解 |
|---|---|---|---|
| 4 | 代理"半截流"（首 token 之后才失败）的行为 | 决定是否需要 `ttft_timeout_ms` 之外的手段 | 桩服务发一半就断，看 opencode 是否把截断流当成功 |
| 5 | **真正的跨重启续跑没有现成实现可抄** | 决定记账插件里最贵的一块要自己设计 | 设计题：源数据只能是父会话转录（宿主不给会话列表） |
| 6 | Bifrost 静态二进制在 EL7 上真能起 | 决定部署路径 | 一次 smoke test |
| 7 | OCR 在自有代码上的误报率 | 决定 severity 何时升级为门禁 | 跑一段时间统计 |
| 8 | **"谁真的服务了这次请求"在 opencode 侧不可见**（响应头也被丢弃，#26091） | 成本/配额归因会全部记到别名上 | **必须在代理侧记 `served_model`**；决定配额告警与成本分析怎么做 |

### 8.3 实验记录（未决 #1，2026-10-19 已完成）

**问**：opencode 在会话后续回合发出的请求里，`model` 字段是**调用者请求的别名**，还是
**上一轮响应体里的模型名**？——这决定 Bifrost（响应体回"被服务模型名"）能否用。

**方法**（隔离栈，**不碰生产 :4096**）：

1. 约 60 行 Node 桩服务伪装成 OpenAI 兼容端点：记录每个请求的 `model` 字段到 `stub-log.jsonl`，
   并**对每一个请求都返回 `"model": "SERVED-MODEL-X"`**（调用者从未请求过的名字）
2. 隔离目录装 `@opencode/cli@2.0.32`（本机 `opencode` 在 PATH 上是 1.18.31，v1）
3. 隔离 `HOME` / `XDG_CONFIG_HOME` / `XDG_DATA_HOME` / `OPENCODE_CONFIG_DIR`
   指向 `D:\develop\ocrc-exp\home`，自定义 provider（`@ai-sdk/openai-compatible`，
   `baseURL=http://127.0.0.1:4599/v1`），模型 id = `router/flash`
4. 同一会话连发 4 轮：
   `opencode2 run --standalone --auto --session ses_probe0001 [--model probe/router/flash] "..."`
   —— **第 3、4 轮故意不带 `--model` 标志**（纯靠会话记忆）

**结果**：

| 请求序号 | 回合 | 是否带 `--model` | 桩收到的 `model` |
|---|---|---|---|
| 4 | 1 | ✅ | `router/flash` |
| 5 | 1（工具轮） | ✅ | `router/flash` |
| 6 | 2 | ✅ | `router/flash` |
| 7 | 3 | **❌** | `router/flash` |
| 8 | 4 | **❌** | `router/flash` |

- **5 次请求全部是 `router/flash`**，尽管每次响应体都写 `SERVED-MODEL-X`
- **数据目录里没有任何文件出现过 `SERVED-MODEL-X`** —— opencode 从未记录被服务的名字
- 响应模型名与请求不符时**无报错、无警告**

**结论**：**opencode v2 忽略响应体的 `model` 字段，始终以调用者请求的名字发请求。**
→ 代理层可以用"虚拟别名"模型：**别名是引擎侧唯一知道的名字，链在代理内部随意变化，
对引擎完全透明。** 这是把回退下沉到代理层的**前提条件，现已成立**。

**残留**：本实验只覆盖"完整响应"的情形。**首 token 之后才失败的"半截流"未验证**（见 §8.2 #4）——
那类失败返回的是 HTTP 200 + 一个错误事件而非 HTTP 错误，必须由代理在首 token 前决定回退
（Bifrost 的 `ttft_timeout_ms` 正是为此），否则客户端会把截断的流当成功。

**复现材料**：`D:\develop\ocrc-exp\`（`stub.mjs`、`stub-log.jsonl`、隔离的 `home/`）——
**在仓库之外**，未污染 ocrc 的 git 状态。

## 9. 形态与仓库（2026-10-19 定案）

### 9.1 三件套，各司其职

| 件 | 形态 | 必需性 | 职责 |
|---|---|---|---|
| **编排插件** | **opencode plugin** | **必需** | 记账（台账/静默死亡/在飞查询/墙钟/并发）；**只有插件 API 能注册工具、拦 `subagent` 调用、订阅引擎事件** |
| **编排内容** | markdown agent 定义 + orchestrator prompt | **必需** | 四阶段流程与调度纪律 |
| **控制台** | **openchamber extension** | 可选 | 只读可视化子会话运行状态 + 配置编辑 |

**为什么控制台必须是 extension 而不是插件**：可视化要的是 openchamber 的会话树（`listSessions()` +
`parentId`，`ocrc-omo-view` 已验证可行）与面板渲染能力；插件拿不到这些。
**为什么记账必须是插件**：extension 是沙箱 iframe，能力清单只有
`prompt/sessions/files/model/shells/network/origins/service/conversation`，
**碰不到引擎的工具管线**——既不能注册工具、也不能拦工具、也不能订阅引擎事件。

**两者同机**：实例级拓扑下，openchamber 实例与 opencode 引擎都在被控端，
extension 的 `service`（`runtime: "host"`）与插件在同一台机器上 →
**桥接可以是文件**（插件写台账 JSON，extension service 读），不必造网络协议。

**单一写者铁律**：配置编辑归 extension，插件**只读**；台账归插件，extension**只读**。
两边各有一个所有者，**绝不互相写**——omo-slim 与 openchamber 抢 agent 配置
（openchamber#3881：面板保存 agent 写出盘上覆盖文件，静默压掉预设）就是双写者造成的。

**边界（沿用 ocrc 的教训）**：控制台是**只读查看器 + 配置编辑器**，
**不做 controller**——控制面在模型侧（工具）。加人工控制面板会造出第二个产品面，
与 ocrc 当年删掉"上一代三块"是同一个教训。

### 9.2 独立仓库（用户裁决）

**新开一个仓库**，且**编排内容（agent 定义 + orchestrator prompt）必须一起搬进去**——
插件与 prompt 是一件事的两半（prompt 说"派活前先查台账"，插件才提供那个工具），
分在两个仓库会让每次改动都要跨仓同步。

建议内容物：插件 / agent 定义 + prompt / extension / 配置 schema / `LICENSE`（含抄自 omo-slim 的 MIT 声明）。

### 9.3 档位设计：3 档，不是 8 档

**判据：一个档位只有在"模型能力或配额池不同"时才成立；只是 prompt 不同的不算档位。**

现有 8 个 category 按此判据塌缩：

| 现有 | 归属 |
|---|---|
| `ultrabrain` / `deep-low` | → **pro**（且这两条链逐字相同，本就重复） |
| `quick` / `unspecified-low` / `unspecified-high` | → **flash** |
| `visual-engineering` | → **multimodal** |
| `writing` / `artistry` | **不是档位**——它们是 prompt 追加，应进 agent 定义 |

**结论：`flash` / `pro` / `multimodal` 三档。**

**"free" 不建议做成档位**：免费档的诉求是"先试免费、配额耗尽再付费"，这是**链的顺序**问题，
由代理层的链解决——做成档位只是把链头重复一遍。
**唯一该把它独立成档的理由**是策略性的："这类活永远不许溢出到付费配额"。
若确有这个需求，则保留第 4 档 `free-only`。

**可能需要的第 4 个能力档：`long`（长上下文）。** 依据：会话量级 344.3M 输入 token，
且长跑（约 88 并发、37k 续跑状态文件）。**若确有超长上下文的场景，它是能力差异而非 prompt 差异**，
按判据应当独立成档。

### 9.4 OCR：吸收进 subagent，不直接装（用户倾向，本文附议）

**不把 OCR 当外部工具装，而是把它的能力吸收进一个专职 reviewer subagent。** 理由：

1. **硬门禁**：OCR 要 `git >= 2.41`，**EL7 自带 1.8.3**——不升级 git 它根本起不来。
2. **npm 包装器会联网自更新**（每次运行后台查 registry 并自动升级）。
3. **规则有 Java 企业栈倾向**（MyBatis/Maven/FreeMarker/NPE/线程安全），在你的代码上误报风险高。
4. **它只审 diff，不审计划**——而第 3 阶段（计划评审）本来就得靠 prompt。
   两阶段都用 prompt 反而一致。
5. **你要的"多轮次多角度"是评审纪律**，而纪律是 prompt 的事（见 §3.4：omo 的 momus 被设计成
   "别挡路"，正是"从工具里拿不到纪律"的例证）。

**该吸收的具体内容**（Apache-2.0，可合法抄）：

- **规则文档**（`internal/config/rules/rule_docs/`，60+ 语言/格式的 markdown rubric）——
  **这是它真正的 IP**，而且形式就是 markdown，直接进 agent 的 skills。
  默认五维：正确性 / 安全 / 性能 / 可维护性 / 测试覆盖。
- **结构化输出契约**：每条评论必填
  `severity ∈ {critical,high,medium,low}` 与
  `category ∈ {bug,security,performance,maintainability,test,style,documentation,other}`，
  外加 `path` / 行号 / `existing_code`（锚点片段）/ `suggestion_code`。
  **必填字段迫使评审给出可定位的结论**，这是"证据而非自述"的一部分。
- **多轮设计**：后续轮次把已确认的发现作为 `{{confirmed_comments}}` 注入，
  且**撤掉计划**——原文理由："a plan tends to act as a coverage ceiling once the obvious issues are found."
- **误报过滤**：一轮专门的 `REVIEW_FILTER_TASK` 删掉可证明错误的评论。

**会失去什么（如实）**：行号锚定的滑动窗口算法、按元数据的语义分组、token 预算管理、
以及那 60+ 规则文档的**自动匹配**（改用 skill 让 agent 自己取用）。
这些在阿里那种"每天数千 PR"的量级上才成为必需；在"orchestrator 审一次改动"的量级上可以接受。

**升级路径**：若 subagent 的评审实测噪声大或定位不准，**再**把 OCR 作为第二道门禁装上
（此时才需要解决 EL7 的 git 版本）。

### 9.5 跨重启：采用 (b) 从父转录重建（用户裁决 Q1=B）

**语义**：宿主不给会话列表（v2 不暴露 `session.list`/`children`），
**父会话的持久化转录就是唯一事实源**。插件在**父会话下一次活动时**（惰性，不是启动时）
扫描历史里 output 仍为 `running` 的 `subagent` 调用，重新登记，再逐个探活：

| 探测结果 | 处置 |
|---|---|
| 子会话不存在（`NotFoundError`） | 墓碑 + 拆除（**不要复活成永远在跑的幽灵**） |
| 有终态 outcome | 落真实终态（`interrupted`→`stopped`，`failed`→`error`，`succeeded`→`completed`） |
| 子会话存在但空闲/无输出 | **停止候选** → 宽限期后落 `stopped, unreconciled` |
| 其他错误 | fail-open，保持登记 |

**明确不做**：不主动重新派发（那是 (c)，会重复副作用）。
**如实标注**：恢复是 best-effort，别名与终态结果**不恢复**。

**抄的对象**：omo-slim 的 `rehydrateHistoricalRunningTasks`
（唯一调用点在 `experimental.chat.messages.transform` 钩子里，即"下一次聊天请求时才跑"）
与 `background-job-terminal-gate` 的静默宽限（5 秒）——两者都是 MIT。

## 10. 引用索引

- omo：issue #9389 / #10374 / #10439 / #8485 / #9389 / #10369 / #10173 / #10174 / #10245 /
  #10248 / #10465 / #8295 / #9241 / #6169；PR #9016 / #9094 / #8768 / #8626 / #8297
- omo 源码（v4.19.4 `dist/index.js`）：`resolveSisyphusPromptFamily`(156511)、
  `buildDynamicSisyphusPrompt`(153105)、`buildParallelDelegationSection`(152010)、
  `resolveCategoryExecution`(132503)、`resolveCategoryConfig`(132331)、`MOMUS_DEFAULT_PROMPT`(158123)、
  `agentSources`(161447)、`createConfigHandler`(163213)
- opencode：v2 docs `/agents` `/models` `/tools` `/permissions` `/migrate-v1`；
  源码 `packages/core/src/tool/plugin/subagent.ts`、`packages/core/src/session/subagent-completion.ts`、
  `packages/schema/src/agent.ts`；issue #53060 / #56124 / #7602 / #55008 / #48991 / #26292
- omo-slim：`docs/background-orchestration.md`、`docs/configuration.md`、
  `docs/opencode-v2-compatibility.md`、`src/v2/mirror-conformance.ts`
- OCR：`alibaba/open-code-review`（Apache-2.0，v1.13.1）、`internal/gitcmd/version.go`、
  `plugins/open-code-review/opencode/open-code-review.ts`
- Bifrost：`maximhq/bifrost`（Apache-2.0，v2.3.0）、`core/schemas/utils.go` 的 `ServedModel()`、
  `docs/docs.json`、`plugins/routing/rules/engine.go`
- 本仓库：`src/core/remote-instance.ts:331-348`（v2 门禁与引擎 pin）、
  `src/core/remote-instance.ts:496-519`（实例 serve 行，**未设 `OPENCODE_CONFIG_DIR`** →
  v2 实例与 v1 引擎共用用户配置，迁移前必须先解决配置目录隔离）
- 用户配置：`D:\develop\OpenCodeConfig\.omo\omo.jsonc`（14 KB）、
  `...\.config\opencode\opencode.jsonc`、`...\.local\share\opencode\opencode.db`
