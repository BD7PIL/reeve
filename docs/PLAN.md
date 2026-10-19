# REEVE 实施计划

> **前置阅读**：[HANDOFF.md](HANDOFF.md) §0（背景/目的/术语）与 §15（执行协议）。
> **写代码前必读**：[research/opencode-v2-plugin-api.md](research/opencode-v2-plugin-api.md)
> ——它是 v2.0.32 插件 API 的**实测施工图**，取代 HANDOFF §6.1 的挂载点写法。
> **日期**：2026-10-19（重写）。**状态**：计划已定，尚未写任何代码。
>
> **每完成一步，把验收结果写进 [`docs/PROGRESS.md`](PROGRESS.md)**
> （格式：`步 N / 检查项 / 结果 / 日期`）。**没有记录的"完成"不算完成。**

---

## 0. 一句话

**REEVE 是 opencode v2 上的自有编排层**，管三件事：**派工**（把活派给专家 agent）、
**管账**（自持子任务台账，知道谁在跑谁死了）、**验活**（不接受 subagent 自述，亲自拿产物验收）。
（shire reeve → sheriff：监督并管账的地方官。）

**不是 omo 的 fork，也不是 omo 的移植**——是重新拥有这三件事。v2 原生已把机制给足
（`subagent` 工具、后台完成时唤醒父 agent、per-agent 的 `model`/`permissions`），
REEVE 只补 v2 缺的那几条，外加一套纪律。

**明确不做**：fork omo（上游已放弃该面 + 永久 SUL-1.0 + 1.8 版/天漂移）；
把回退做进插件（会随 v2 API 漂移一起烂）；控制台做成 controller（控制面在模型侧）。

---

## 1. 组件与所有权

| 件 | 形态 | 进程归属 | 配置源真相 | 运行时写者 | 只读方 |
|---|---|---|---|---|---|
| **编排内容** | markdown（agent 定义 + prompt） | 无进程（引擎加载） | **reeve 仓库** | 控制台 | — |
| **记账插件** | opencode v2 plugin | **引擎进程内**（调度器按目录进程级共享） | 无（仅并发上限等少量） | **插件自己** | 控制台 |
| **审查层** | `reviewer` agent + `skills/` | 无进程（引擎内跑 subagent） | reeve 仓库 | — | — |
| **代理层** | **独立进程**（Bifrost 静态二进制） | **ocrc** | reeve 仓库 `proxy/config.json` | 控制台 | 插件、引擎 |
| **控制台** | openchamber extension | openchamber 实例的 `service`（`runtime: "host"`） | — | 写配置、读台账 | — |

**REEVE 本体 = 2 件必需（编排内容 + 记账插件）+ 1 件可选（控制台）**：
- **编排内容与记账插件必须同仓**——它们是"一件事的两半"：prompt 说"派活前先查台账"，
  插件才提供那个工具。分两仓会让每次改动都要跨仓同步。
- **审查层不单独成件**——它是 agent 定义 + skill 文档，物理上就在编排内容里。
- **代理层不是我们开发的**（Bifrost，Apache-2.0，别人的 Go 二进制），REEVE 只消费它。

### 1.1 单一写者铁律（守住）

| 面 | 所有者 | 另一方 |
|---|---|---|
| 配置（档位表、模型链、agent 名单） | **控制台（extension）写** | 插件**只读** |
| 台账（子任务状态） | **插件写** | 控制台**只读** |

**绝不互相写。** 反例就在眼前：omo-slim 与 openchamber 抢 agent 配置——面板保存 agent 时
写出盘上覆盖文件，按 omo-slim 自己的优先级 `opencode.json` 的 agent 条目是终局覆盖，
**静默压掉预设**（openchamber#3881）。
→ **硬禁止：记账插件绝不写 `agents.*.model`。**

---

## 2. 前置：配置目录隔离

> **✅ 杠杆已确定（2026-10-19，两端都实测过）**：**`HOME`**。
> `OPENCODE_CONFIG_DIR` ❌ 与 `XDG_CONFIG_HOME` ❌ **都不重定向**配置目录。
>
> | 平台 | 引擎 | 基准（只有 HOME） | `OPENCODE_CONFIG_DIR=其他目录` | `XDG_CONFIG_HOME=其他目录` |
> |---|---|---|---|---|
> | Windows | v2.0.32 | 读到 `$HOME/.config/opencode` 的配置 | ❌ 仍读 HOME 的 | ❌ 仍读 HOME 的 |
> | **EL7** | **v2.0.27** | 读到 `$HOME/.config/opencode` 的配置 | ❌ 仍读 HOME 的 | ❌ 仍读 HOME 的 |
>
> 做法：往目标目录放一个含唯一标记 provider 的 `opencode.json`，
> `service stop` 后跑 `opencode debug config`，看读到哪个 provider。
> 证据见 [research/opencode-v2-plugin-api.md](research/opencode-v2-plugin-api.md) §14.2。

**问题**：ocrc 的实例启动行 `buildInstanceServeCommand` **没有做任何配置目录隔离**
（已核实：只导出 `OPENCODE_BINARY` / `OPENCHAMBER_UI_PASSWORD` /
`OPENCHAMBER_RELAY_HOST: 'off'` 与代理变量）。→ EL7 上的 v2 实例与 v1 生产引擎
**共用同一份用户配置**。

而 v1/v2 的键名不兼容：`agent`↔`agents`、`prompt`↔`system`、`permission`↔`permissions`、
`maxSteps`↔`steps`、`disable`↔`disabled`。**两个引擎会互相踩配置。**

**处置（归 ocrc，不归 reeve）**：给 v2 实例的启动行**改 `HOME`**（指向独立目录），
**不是**加 `OPENCODE_CONFIG_DIR`——后者实测无效。

> ⚠️ **改 `HOME` 的连带影响**（ocrc 要一并考虑）：`$HOME/.local/share/opencode`（数据/DB）、
> `$HOME/.cache/opencode`（bin、models 目录）、`$HOME/.local/state/opencode` 都会跟着搬。
> 这**恰好是想要的**（v2 实例的台账与 DB 与 v1 隔离），但 ocrc 里凡按 `homedir()` 拼的路径都要复核。
> 另一个候选是给实例单独一个系统用户（更彻底，但要动 EL7 的用户管理）。

**⚠️ 这条不阻塞步 1 的开发与验证**——开发机隔离栈自带独立 `HOME`，
`opencode v2.0.32` 已跑通（`debug agents` 可用）。它阻塞的是 **EL7 部署**。

---

## 3. 编排层（文本，零代码）

**目标**：把四阶段工作流写成 prompt + agent 定义。

### 3.1 agent 名单（8 个，按职能命名）

**不用 omo 的神祇名**（法律上：SUL-1.0 无商标授权；语义上：叫它 omo 的什么会把"fork"框架请回来）。
用 v2 frontmatter：`mode` / `model` / `system` / `permissions` / `steps`。

| agent | mode | model | permissions | 职责 |
|---|---|---|---|---|
| `foreman` | primary | `reeve/pro` | 全权 | 编排者：grill / plan / 派活 / **亲自验** |
| `planner` | subagent | `reeve/pro` | deny edit + shell | 把需求写成**自包含**实施文档 |
| `critic` | subagent | `reeve/pro` | **deny edit + shell** | **严格版**计划评审（多轮多角度） |
| `advisor` | subagent | `reeve/pro` | deny edit + shell | 对抗性顾问（架构/难题） |
| `scout` | subagent | `reeve/flash` | deny edit | 代码库检索 |
| `librarian` | subagent | `reeve/flash` | deny edit | 外部库/文档检索，带 permalink 证据 |
| `executor` | subagent | `reeve/flash` | 全权 | 照文档干活（唯一实现者） |
| `reviewer` | subagent | `reeve/pro` | 只读 | 代码 diff 独立审查（§6） |

**`critic` / `advisor` 用 `permissions` 拒掉 edit/shell —— 这就是质量闸门，纯配置零代码。**

**model ref 的读法**：`reeve/pro` = provider id `reeve` + models key `pro`。
该条目的 `modelID` 显式设为 `reeve/pro`，所以 **ref 与发给端点的线上名都是 `reeve/pro`**（两段同名）。
→ Bifrost 的 `cel_expression` 直接写 `model == "reeve/pro"`，**不需要任何映射层**。
（机制与证据见 §5.4①。）
以后接 Bifrost 还是直连 provider，**agent 定义都不用改**。

**对照实测数据**（678 个会话）：现有 8 个 category 里 `metis` / `prometheus` / `atlas`
**0 会话**（死配置）；`multimodal-looker` 239 会话但**已过时**（模型普遍多模态后主 agent 直接读图，
其残余价值只是上下文卸载）→ **不设 looker**。

### 3.2 orchestrator prompt

**结构**：`身份 → 意图门 → 委派判定 → 后台协议 → 验收阶梯 → 硬禁止`

**三段必写**（借思路，**不抄字面**——见 HANDOFF §10）：
1. **意图门 + Context-Completion Gate** —— "当前这条消息里没有明确实现动词就不许改文件；
   上一轮的'实现模式'不许跨轮继承"
2. **反重复 + "结束你的回复，等通知"** —— 派出去之后不许自己再搜一遍，也不许轮询
3. **"没有证据 = 没完成"**

**必须写死的架构约束**（由"agent 会欺上瞒下"推出）：

> **证据必须由 orchestrator 独立复现，不能由 subagent 自述。**
> 验证者不能是执行者，且拿到的是**产物本身**（diff、文件、真跑一遍），不是那份报告。

**明确不要写**："你是实现者"式的措辞——当前使用者的委派比例是合理的（实测 95% 的会话是子会话），
不需要更强制委派。

### 3.3 四阶段流程

```
1. grill    → 问清背景/目的/实施路线，产出需求定稿
2. plan     → 写自包含的实施文档（context-free 可执行）
3. 计划评审  → 多轮 × 多角度，直到通过
4. 执行+验证 → 便宜模型照文档干；orchestrator 亲自拿产物验
```

**"不携带上下文的 subagent 也能看懂的实施文档"这条约束很值钱**：它意味着**文档是接口**，
智力集中在文档里，执行可用便宜模型——正好接上整套免费档策略。

### 3.4 critic prompt（**这是与 omo 的核心分歧**）

omo 的计划评审 prompt 的立场是**拿不准就倾向批准**：认为计划"八成清楚就够了"、
对每次驳回的问题数**设上限**、并明确把"**强制多轮修订**"列为**不做**。
而需求是"**多轮次多角度评审**"——**方向相反**。（转述，非原文；见 HANDOFF §5.5 的许可说明。）

**要写的**：
- **多轮**：后续轮把已确认的发现作为 `{{confirmed_comments}}` 注入，**且撤掉计划**
  （理由：*"a plan tends to act as a coverage ceiling once the obvious issues are found."*）
- **多角度**：不同轮聚焦不同维度（正确性 / 安全 / 性能 / 可维护性 / 测试覆盖）
- **不设"最多 3 条"上限**，不设"80% 就够"
- **不通过必须给出可执行的修改项**，不接受"建议改进"这类模糊结论

### 3.5 落点

`agents/*.md`（8 个）。

> **⚠️ 2026-10-19 更正**：本节原定还要 `prompts/orchestrator.md` 与 `prompts/critic.md`。
> **实测证明 markdown 的正文就是 `system`**（施工图 §14.5①）——agent 定义文件与 system prompt
> 是同一个东西。再维护一份 `prompts/*.md` 会造成**两处真相**，与"链只在一处维护"的原则冲突。
> **故 `prompts/` 目录取消**，8 个 agent 的正文即其 prompt。
> 若将来确有多个 agent 共用的长文（如四阶段细则），再单独设共享目录并由 agent 用 `read` 取用。

---

## 4. 记账层（`@bd7pil/reeve`，唯一必需的代码阶段）

**目标**：补齐 v2 原生缺的八条（HANDOFF §3.2）。

**前置**：编排层完成（插件与 prompt 是一件事的两半）。
**施工图**：[research/opencode-v2-plugin-api.md](research/opencode-v2-plugin-api.md)——
**挂载点一律以它为准**，不要照 HANDOFF §6.1 写。

### 4.1 五处挂载点（v2 修正版）

| # | 挂载点 | v2 真实形态 |
|---|---|---|
| ① | 拦 `subagent`（**并发闸门，子会话创建之前**） | `ctx.tool.hook("execute.before", cb)`——`input` 可原地改、可返回 `Tool.Error` 阻断 |
| ② | 落台账 | `ctx.tool.hook("execute.after", cb)`——拿 `{ tool, sessionID, status: "completed"\|"error", result/error }` |
| ③ | 认终态 | `ctx.event.subscribe()` 认 `session.execution.succeeded/failed/interrupted`（`interrupted` 带 `reason`） |
| ④ | 墙钟 | 每任务一次性定时器 → 到期先武装宽限 → 发**恰好一次** `ctx.session.interrupt({ sessionID, resume: false })` |
| ⑤ | 落盘 + 对账 | `ctx.storage`（`get/set/remove/scan`；宿主自动加 `plugin.<id>.` 前缀） |

**注册工具**：
```ts
ctx.tool.transform(e => e.add({
  name: "task_status",
  description: "...",
  input: <JSON Schema | zod>,          // `input` 或 `args` 都行（实测）
  output: <同上>,
  options: { namespace: "reeve", codemode: false },   // ⚠️ 两个都要，否则模型看不见这个工具
  execute: async (args, ctx) => ({ ... }),
}))
```
> **⚠️ 实测更正（2026-10-19）**：早先写"必须带 `options.namespace`，否则模型看不见"——
> **归因错了**。`namespace` 只管命名（工具变成 `reeve_task_status`）；
> **真正决定"是否暴露给模型"的是 `options.codemode: false`**。
> 没有它时：工具**注册成功、`ctx.tool.list()` 里能看到、但模型工具表里没有**——**静默失败**。
> 证据见 [research/opencode-v2-plugin-api.md](research/opencode-v2-plugin-api.md) §3.1。

工具只读，**绝不 prompt / abort / register**。

### 4.2 静默死亡（最贵的那条）

**没有"子任务死了"这个事件，全靠推断。**

**关键设计**：`session.idle` 只是**候选**，不立即判定终止；只有当转录判定为 `absent`
**且**静默已持续超过宽限期才落 `stopped`：

```ts
const stable = now() - Math.max(value.quiescentSince ?? now(), token.attemptStartedAt ?? 0) >= graceMs;
if (evidence.verdict === 'absent' && stable)
  return commit(token, 'stopped', STOPPED_WITHOUT_TERMINAL_RESULT, undefined, 'transcript');
```

`STOP_CONFIRMATION_GRACE_MS = 5_000`。**这就是"静默失败边界"的实际解法**——
先用宽限期把"正常完成的最后一刻"和"真的死了"分开。
**否则会把每个正常完成的子任务都误报成死亡。**
任何无法证明为终态的一律保持 `running` + `statusUncertain`，并排一次重试（默认 3 次）。

> ⚠️ `session.idle` 在 v2 **仍然存在，但已标 `// deprecated`**。可以用作候选信号，
> **但不要在上面加深依赖**（见施工图 §5）。

### 4.3 在飞查询

**台账本身就是子会话注册表**（因为 v2 不给 `session.list`）。
子会话 id 来自 `session.created` 事件与 `subagent` 工具输出解析
（结构化字段优先：`output.sessionID` / `metadata.sessionID`；退化到文本正则
`(sessionID: <id>)` 与 `<subagent sessionID="<id>" ...>`）。键就是子会话 id。

### 4.4 墙钟

只监督 `background === true` 的任务；只对新 `generation` 重新武装；
**忙碌/工具活动/存活信号都不续期**。到期后：先武装宽限定时器（`abortGraceMs` 默认 10s），
再发**恰好一次** `ctx.session.interrupt({ sessionID, resume: false })`。
宽限到期仍未确认 → 标 `statusUncertain` 并落 `error, timedOut: true, terminalUnreconciled: true`。
**已发布的硬超时不可被迟到的完成/忙碌替换。**

### 4.5 并发

在 `execute.before` 里排队（**子会话创建之前**）。档位解析：
**模型上限 > provider 上限 > 默认上限**，`0`/缺省 = 无限。

两条正确性性质（抄 omo-slim）：
- **(a) 嵌套的受管任务必须豁免**——它们已持槽，再等会**自死锁**
- **(b) 调度器按目录进程级共享**，插件重载后保留运行中槽位与排队票

### 4.6 跨重启对账（**唯一没有参照实现可抄的一块**）

**语义（使用者裁决 = (b) 档）**：**从父转录重建**。
宿主不给会话列表 → **父会话的持久化转录是唯一事实源**。
**惰性触发**：父会话**下一次活动时**才扫（不是启动时扫）。

| 探测结果 | 处置 |
|---|---|
| 子会话不存在（`NotFoundError`） | 墓碑 + 拆除（**不要复活成永远在跑的幽灵**） |
| 有终态 outcome | 落真实终态（`interrupted`→`stopped`，`failed`→`error`，`succeeded`→`completed`） |
| 子会话存在但空闲/无输出 | **停止候选** → 宽限期后落 `stopped, unreconciled` |
| 其他错误 | fail-open，保持登记 |

**明确不做**：不主动重新派发（会重复副作用）。
**如实标注**：恢复是 best-effort，别名与终态结果**不恢复**。

> ✅ **挂载点已实测确定（2026-10-19）**：omo-slim 用的是 v1 钩子
> `experimental.chat.messages.transform`，**v2 里不存在**。
> 实测两个候选的触发时机：
> **`ctx.session.hook("prompt", cb)` 先触发**（回合一开始，早于 `session.execution.started`）；
> `ctx.session.hook("context", cb)` 在构造模型调用时才触发。
> → **惰性对账挂 `prompt`**（"父会话下一次活动时"最贴近的语义，且触发最早）。
> 证据见 [research/opencode-v2-plugin-api.md](research/opencode-v2-plugin-api.md) §14.7。

### 4.7 可抄的 MIT 参照（`oh-my-opencode-slim` v3.0.5）

架构主干：`BackgroundJobBoard`（状态）← `BackgroundJobCoordinator`（单写者 + 监听分发）
← `BackgroundJobStore`（接口）← `BackgroundJobTerminalGate`（终态判定边界）
+ `BackgroundJobSupervisor`（墙钟）+ `BackgroundTaskConcurrency`（准入）。

关键文件（**MIT，可合法抄代码**）：
```
src/hooks/task-session-manager/{event-router,index,idle-reconciliation,runtime-status-reconciliation}.ts
src/utils/background-job-{terminal-gate,board,supervisor,persistence}.ts
src/utils/background-task-concurrency.ts
src/admission-runtime.ts
src/tools/task-{status,revive}.ts
docs/background-orchestration.md          （932 行，先读这个）
```

**它的负面事实（重要）**：台账**不落盘**（进程内 `Map`），**跨重启不存活**。
→ **真正的"跨重启续跑"没有现成实现可抄**，要自己设计（§4.6 的判定表已给出）。

> ### ⚠️ 它是 **v1 插件**——算法可抄，接线必须重写（2026-10-19 核实）
>
> 已把 v3.0.5 的关键文件拉到仓库外的参照区 `D:\develop\omo-slim-ref\` 并核对：
>
> | 核实项 | 结果 |
> |---|---|
> | 架构主干（`BackgroundJobBoard` / `TerminalGate` / `Supervisor` / `TaskConcurrency`） | ✅ 对得上 |
> | `STOP_CONFIRMATION_GRACE_MS = 5_000` | ✅ 确认（`background-job-terminal-gate.ts:27`） |
> | 台账不落盘、跨重启不存活 | ✅ 确认（文档原文 *"process-local and do not survive process restarts"*） |
> | `acquireAdmissionRuntime(directory, config)` 按目录进程级共享 | ✅ 确认（`admission-runtime.ts:49`） |
> | `src/**` 无 per-file 版权头 | ✅ 确认（grep 零命中） |
> | **它用的钩子名** | ❌ **是 v1 的**：`'tool.execute.before'`（`task-session-manager/index.ts:719`）、`'experimental.chat.messages.transform'`（`:772`） |
>
> **→ 结论：可以抄它的算法（终态判定门、墙钟监督器、准入队列、静默宽限），
> 但入口、钩子名、工具注册必须按 v2 重写**（见 [施工图](research/opencode-v2-plugin-api.md)）。
> 照抄 v1 钩子名 = 插件能加载但**一个钩子都不会触发**。

**许可**：MIT，标准文本，`Copyright (c) 2025`，`src/**` 下无 per-file 版权头
→ 抄代码只需带顶层 `LICENSE` 与声明。**行动**：把上游 `LICENSE` 复制到
`licenses/oh-my-opencode-slim.LICENSE`，并在 `NOTICE.md` 登记被引入的文件清单。
（参照区已放一份：`D:\develop\omo-slim-ref\LICENSE`。）

### 4.8 体量与难点

骨架约 **500 行**。**真正的难点是静默失败的边界**——必须能区分"宿主已发过终态通知"
与"没发过"，否则会把每个正常完成的子任务都误报成死亡。
**这类系统里最贵的 bug 不是崩溃，是静默不一致**（台账说在飞、宿主说已死、父 agent 以为还在等）。

### 4.9 与面板零冲突

记账插件**不碰 agent、不碰 model**——只注册工具 + 挂 hook。
**绝不写 `agents.*.model`**（§1.1 铁律）。

### 4.10 落点

`plugin/`、`licenses/oh-my-opencode-slim.LICENSE`

---

## 5. 代理层（Bifrost）

**目标**：把跨 provider 回退从插件里搬出来，链只在一处维护。

### 5.1 拓扑

```
被控端（EL7）
  opencode v2 引擎 ──HTTP 回环──▶ Bifrost(127.0.0.1:8080) ──▶ 真实 provider
   只知道 reeve/flash|pro|multimodal          （链与回退全在这里）
```

### 5.2 进程谁持有 → **ocrc**

- ocrc 的职责就是"把运行时/引擎/应用推上去并连起来"，而且它**已经有版本 pin 的 bin-cache**
  （`~/.ocrc/bin-cache/` 里有 `remote-engine/2.0.27-linux-x64/`、`remote-runtime/24.22.0/`、
  `cli-linux-x64-2.0.27.tgz`、`remote-app/2.3.3/`）。Bifrost **不在 GitHub Releases**
  （只能从 `downloads.getmaxim.ai` 取，~128 MB），正需要这套 pin + 分发机制。
- ocrc 已有唯一启动入口 `buildInstanceServeCommand`（渲染 env exports + 起 openchamber serve）。
  Bifrost 就是它前面多起一个进程。
- **不能由插件持有**：插件活在被控端引擎进程里，引擎重启它就没了；
  且文档要求"回退不能随 v2 API 漂移一起烂"。
- 备选（不推荐）：手工 systemd——没有版本 pin、没有与被控端版本对账。

### 5.3 谁配置 → **源真相在 reeve 仓库，运行时唯一写者是控制台**

| 角色 | 权限 |
|---|---|
| reeve 仓库 | **持有源真相** `proxy/config.json`（链只在这里改一次） |
| ocrc | **只推送**，不生成内容 |
| 控制台（可选） | **唯一运行时写者**（编辑 UI，写回同一份源真相） |
| reeve 记账插件 | **只读**，绝不碰代理配置 |

**API key 不进仓库**：`keys[].value` 写 `env.<VAR>`，由 ocrc 的启动行注入
（它已在 `renderExports` 里注入 `HTTP_PROXY` / `NODE_EXTRA_CA_CERTS`，加几个变量是同一处改动）。

### 5.4 如何接入 → 两端各一次，零额外层

**① opencode v2 侧**：自定义 OpenAI 兼容 provider，`baseURL` 指向 Bifrost。

**已实测（隔离栈 + 桩服务）**：模型条目里有两个东西都能决定"发给端点的名字"——

| 字段 | 作用 | 实测结论 |
|---|---|---|
| `models` 的 **key** | ref 的第二段 | 会成为线上名（当时 ref 是 `probe/router/flash`，端点收到 `router/flash`） |
| 条目的 **`modelID`** | **显式指定线上名** | v2.0.32 支持（**文档没写**），`modelID ?? key` 决定线上名 |

**⚠️ 但 `modelID` 只在原生 provider 形态下生效**（这是静默失败，不报错）：

| provider 配置形态 | `modelID` | 桩收到的 `model` |
|---|---|---|
| **原生复数 `providers` + `package`/`settings`** | ✅ 生效 | `reeve/flash` |
| 遗留单数 `provider` + `npm`/`options` | ❌ **被忽略** | `flash` |

→ **REEVE 必须写成原生复数形态**，并用 `modelID` 让"ref"与"线上名"一致（§三 命名契约）：

```jsonc
"providers": { "reeve": { "name": "REEVE Router",
  "package": "@ai-sdk/openai-compatible",
  "settings": { "baseURL": "http://127.0.0.1:8080/v1", "apiKey": "{env:BIFROST_KEY}" },
  "models": {
    "flash":      { "modelID": "reeve/flash" },
    "pro":        { "modelID": "reeve/pro" },
    "multimodal": { "modelID": "reeve/multimodal" }
  } } }
```

agent 写 `model: reeve/flash` → 端点收到 `model: "reeve/flash"` → CEL `model == "reeve/flash"` 直接命中。
**零映射层。**

> **⚠️ 更正（两处）**：
> 1. 本节原写"**不需要** HANDOFF §4.8 说的原生 Aliases 那层"——**那是错的**。
>    当时只验证了"key 会成为线上名"（在遗留形态下确实如此），没验证 `modelID` 是否存在、是否可用。
>    **HANDOFF §4.8 从一开始就是对的。** 详见
>    [research/opencode-v2-plugin-api.md](research/opencode-v2-plugin-api.md) §10.1。
> 2. 本节原用的示例是**遗留单数 `provider` 形态**——在那个形态下 `modelID` 被忽略，
>    照抄会踩坑。**已改为原生复数形态。**

（2.0.32 上单数 `provider` 与复数 `providers` 都接受，见施工图 §10。）

**② Bifrost 侧**：
- `providers`：6 个 provider 全部写成 OpenAI 兼容自定义 provider
  （`custom_provider_config.base_provider_type: "openai"` + `network_config.base_url`
  + `keys[].value: "env.<VAR>"`）
- `governance.routing_rules`：三条，`name` = `reeve/flash` / `reeve/pro` / `reeve/multimodal`，
  `cel_expression: model == "reeve/<档>"`，`targets[0]` + `fallbacks[]`，`scope: "global"`，
  `priority` 唯一
- **`cel_expression` 用 `model`，不是 `request.model`**——官方文档示例是错的，
  `request` 是数值型限流百分比变量
- `fallbacks` 用 `"provider/model"`；写 `"provider/"` 表示**同模型换 provider**
- `weight` **必须合计为 1**（单 target 就是 `1`）
- 改 `config.json` **要重启**；热改走 `POST /api/routing/rules`

### 5.5 三条边界（照做，别踩）

1. **只做 OpenAI 兼容端点之间的纯透传，不做任何格式翻译。**
   反向证据：opencode 官方关闭的 PR **#26292** 明说 *"routing through LiteLLM degrades
   tool-call quality"*，实锤是 issue **#56124**（Bedrock 工具调用参数翻译出错）。
   **代价**：4 个原生 provider（`xiaomi` / `deepseek` / `zhipuai-coding-plan` / `alibaba-cn`）
   要改写成 OpenAI 兼容自定义 provider——**它们的 endpoint 是缺的输入**（§9）。
2. **半截流**：首 token 之后才失败的，客户端会当成 HTTP 200 + 一个错误事件。
   回退必须在**首 token 之前**决定 → `ttft_timeout_ms`。
   ⚠️ **官方文档对它的层级自相矛盾**：changelog + Helm schema + DB migration 三处说
   **target 级**，两份 MDX 说 **rule 级** → **实测定**。**未决 #1。**
3. **opencode 永远看不到"谁真的服务了这次请求"**（响应模型名不捕获、响应头也被丢弃 #26091）
   → 配额归因必须在代理侧记：Bifrost 把实际服务的模型落成 `logs` 表的 `served_model` 列
   （默认 SQLite `logs.db`，在 app-dir 下），另有 `/api/logs` 与响应头
   `x-bifrost-routing-info-{provider,model,requested-model,is-fallback,key,...}`。
   **不做这步，那 196 次 quota 错误永远分不清是哪个 provider 撞的。**

### 5.6 落点

`proxy/config.json`（链的唯一维护处）、`proxy/README.md`、`scripts/served-model.sh`

---

## 6. 审查层（吸收 OCR，不装工具）

**决定：把 OCR 的能力吸收进一个专职 `reviewer` subagent，不把 OCR 当外部工具装。**

理由：
1. ~~**硬门禁**：OCR 要 `git >= 2.41`，**EL7 自带 1.8.3**——不升级 git 它根本起不来~~
   → **⚠️ 勘误（2026-10-19 EL7 实测）：这条不成立。** EL7 上 `/usr/bin/git` 实测是
   **2.43.0**（EPEL 的 `git-core-2.43.0-1.ep7.x86_64`），**已经满足 `>= 2.41`**。
   原先"EL7 起不来 OCR"的判断是错的（来源是未核实的"自带 1.8.3"）。
2. **npm 包装器会联网自更新**（每次运行后台查 registry 并自动升级）
3. **规则有 Java 企业栈倾向**（MyBatis/Maven/FreeMarker/NPE/线程安全），在自有代码上误报风险高
4. **它只审 diff，不审计划**——而计划评审本来就得靠 prompt，两阶段都用 prompt 反而一致
5. **"多轮次多角度"是评审纪律，而纪律是 prompt 的事**（§3.4）

> **决定不变**：理由 2–5 仍然成立，而且"吸收进 subagent"还多一个好处——
> **不引入一个需要跟版本的外部依赖**。但要如实记：**第 1 条已经作废**，
> 所以"若评审噪声大就装 OCR"这条**升级路径现在更便宜了**（不必再解决 git 版本）。

### 6.1 吸收什么（Apache-2.0，可合法抄）

- **规则文档**：`internal/config/rules/rule_docs/` 的 markdown rubric
  （`default.md` / `typescript.md` / `python.md` / `go.md` …），默认五维
  **正确性 / 安全 / 性能 / 可维护性 / 测试覆盖** → 进 `skills/review/`，让 agent 自己取用
- **结构化输出契约**：每条评论**必填**
  `severity ∈ {critical, high, medium, low}` 与
  `category ∈ {bug, security, performance, maintainability, test, style, documentation, other}`，
  外加 `path` / 行号 / `existing_code`（锚点片段）/ `suggestion_code`。
  **必填字段迫使评审给出可定位的结论**——这是"证据而非自述"的一部分
- **多轮设计**：后续轮把已确认的发现作为 `{{confirmed_comments}}` 注入，**且撤掉计划**
- **误报过滤**：一轮专门的过滤，删掉可证明错误的评论

### 6.2 会失去什么（如实）

行号锚定的滑动窗口算法、按元数据的语义分组、token 预算管理、
以及 60+ 规则文档的**自动匹配**（改用 skill 让 agent 自己取用）。
**这些在"每天数千 PR"的量级才成为必需**，在"orchestrator 审一次改动"的量级可以接受。

### 6.3 门禁策略

**一开始都不卡流程**（`critical` / `high` 也只报告不阻塞），跑两周统计误报率再定升级哪些。

### 6.4 升级路径（留着）

若评审实测**噪声大或定位不准**，**再**把 OCR 作为第二道门禁装上
（此时才值得解决 EL7 的 `git >= 2.41` 门禁），并注意它的 npm 包装器会联网自更新
（用静态二进制绕开）。

### 6.5 落点

`agents/reviewer.md`、`skills/review/{SKILL.md,default.md,ts_js_tsx_jsx.md,python.md,go.md,yaml.md,json.md,package_json.md}`、
`licenses/open-code-review.LICENSE`、更新 `NOTICE.md`（列出被引入的具体文件清单）

> **⚠️ 文件名必须是 `SKILL.md`（实测）**：opencode v2 的 skill 发现规则是
> `scan("{*.md,**/SKILL.md}")`，且要求目录里有 **`SKILL.md`** 或 **`<目录名>.md`**。
> 叫 `README.md` **不会被当成 skill**（只能靠 `read` 硬读路径，skill 列表里没有它）。
> 同目录下的其他 `.md` 是 skill 自带的参考资料，靠 `read` 取用，不各自成为 skill。
> 出处：[research/opencode-v2-plugin-api.md](research/opencode-v2-plugin-api.md) §16.1。

---

## 7. 控制台（可选）

**形态**：openchamber extension，目录 `extensions/reeve`，`panel.id = reeve`。
**进程归属**：openchamber 实例的 `service`（`runtime: "host"`）。

### 7.1 参照实现

ocrc 的 `extensions/ocrc-omo-view`（**已验证可行**）：
- `h.listProjects()` → `h.listSessions(project.id)` + `h.onSessions(project.id, cb)`
  取会话快照与实时更新
- `parentId` 作树键（`parentId` 为 null 的是根；**悬空父节点降级为根，不丢弃**）
- **声明式注册**：`package.json` 的 `openchamber` 块贡献 `panel` 与 `actions`，无命令式注册调用

### 7.2 桥：同机文件桥

实例级拓扑下 openchamber 实例与 opencode 引擎都在被控端，
extension 的 `service` 与插件**在同一台机器上** → **插件写台账 JSON，extension service 读**，
不必造网络协议。

### 7.3 为什么必须与插件分开

- 可视化要 openchamber 的**会话树**（`listSessions()` + `parentId`）与面板渲染能力
  ——**只有 extension 拿得到**
- 记账要引擎的**工具管线**（注册工具、拦 `subagent`、订阅事件）——**只有插件拿得到**。
  extension 是沙箱 iframe，能力清单只有
  `prompt/sessions/files/model/shells/network/origins/service/conversation`，
  **碰不到引擎的工具管线**

### 7.4 边界

**只读查看器 + 配置编辑器，不做 controller**——控制面在模型侧（工具）。
加人工控制面板会造出第二个产品面（ocrc 曾因"上一代三块"整体删除一代功能）。

### 7.5 落点

`extensions/reeve/`（`package.json` + `panel/index.html` + `src/`）

---

## 8. 部署路径

- **REEVE 产出**：npm 包 `@bd7pil/reeve`（插件）+ `agents/` + `skills/` + `proxy/config.json`
  → 打包 `reeve.zip`，tag `reeve-<ver>` / `reeve-latest`
- **谁装**：**ocrc**（它已持有 ssh + bin-cache + 启动行）。把 REEVE 资产推进被控端的
  **隔离后的**配置目录（§2）；在 bin-cache 里加 reeve 条目，与 engine/runtime/app 同一套 pin 机制

**落到被控端的哪里**（`$CONF` = 隔离后的配置目录，即 `$HOME/.config/opencode`）：

| 资产 | 落点 | 实测结论 |
|---|---|---|
| `agents/*.md` | `$CONF/agent/` 或 `$CONF/agents/` | **两个目录都被扫**（实测） |
| `skills/review/` | `$CONF/skill/` 或 `$CONF/skills/` | **两个目录都被扫**；**目录里必须有 `SKILL.md`**（否则不成 skill） |
| 插件 | `plugins: ["<绝对路径>"]` 或 `$CONF/plugins/` | 目录根要有入口文件；**Windows 路径用正斜杠** |
| 台账 | `~/.reeve/ledger.json`（插件经 `ctx.storage` 落盘） | — |
| 代理配置 | `~/.reeve/bifrost/config.json`（Bifrost 的 app-dir） | — |

- **API key 语法两处不同**（实测）：opencode 侧用 **`{env:VAR}`**；Bifrost 侧用 **`env.VAR`**。
- **版本对账**：ocrc 记录被控端上 reeve / engine / runtime / bifrost 四个版本，不匹配就报

---

## 9. 命名派生与仓库布局

```
品牌        REEVE
机器标识    reeve
仓库        BD7PIL/reeve
npm 包      @bd7pil/reeve          插件
扩展目录    extensions/reeve        panel.id = reeve
台账        ~/.reeve/ledger.json
配置        ~/.config/opencode/reeve.jsonc（用户级）/ .opencode/reeve.jsonc（项目级）
发布资产    reeve.zip
tag         reeve-<ver> / reeve-latest
```

**两条命名规矩**：① 不用 omo 的名字，也不用它的神祇名（SUL-1.0 无商标授权；
且会把"fork"框架请回来）；② 给整件事起一个名，零件从它派生（品牌大写、机器标识小写、第二段是件类）。

```
reeve/
  README.md  NOTICE.md  LICENSE
  docs/
    HANDOFF.md                    背景与决策依据
    PLAN.md                       本文件
    PROGRESS.md                   每步验收记录
    research/
      orchestration-stack-verdict.md    立项证据（归档，含已被取代的说法）
      opencode-v2-plugin-api.md         v2 插件 API 实测施工图 ★写代码前必读
  agents/*.md                     8 个 agent 定义（正文即 system prompt，见 §3.5）
                                  ⚠️ 7 个 subagent 标 `hidden: true` —— 前台只出现 foreman（见 PROGRESS §6.1）
  skills/review/                  SKILL.md（契约与用法）+ 7 份 OCR rubric
  plugin/                         @bd7pil/reeve（记账层；含 roster.js 补名册）
  proxy/{config.json,README.md}   链的唯一维护处
  config/opencode.sample.jsonc    引擎侧配置样板（只出现编排者 / 三档位 / 插件 options）
  extensions/reeve/               控制台面板（只读；build.mjs / check.mjs / cdp-panel*.mjs）
  scripts/
    el7-deploy-staging.sh         受控端 staging 部署（env→config→起 Bifrost→**收敛**→VK），幂等
    el7-restart-bifrost.sh        改完 config 重启 Bifrost 并等就绪
    bifrost-sync-config.sh        把 config.json 收敛到运行中的 Bifrost（--check/--apply/--prune）
    check-config-sample.mjs       本地守门：样板必须是"整行注释 + 合法 JSON + 关键键都在"
    el7-verify-fallback.sh        回退验证（坏链头 key → 第 2 跳接手）
    el7-verify-multimodal-fallback.sh   视觉档验证 + 回退验证（合体版）
    served-model.{sh,mjs}         归因查询（node:sqlite 优先，退路 /api/logs；--json 可被定时消费）
  licenses/{oh-my-opencode-slim,open-code-review}.LICENSE
```

> **台账的落点**（与上面的"命名派生"表有出入，以这里为准）：权威是**引擎的 `ctx.storage`**
> （`opencode.db` 的 `kv` 表，键 `plugin:<hex(id)>:<你的键>`）。给面板看的那份 JSON 是**投影**，
> 位置由插件 `options.snapshotPath` 决定（实测用 `~/.local/share/opencode/reeve/ledger.json`）。

---

## 10. 实施顺序与硬门槛

| 步 | 内容 | 形态 | 前置 |
|---|---|---|---|
| **0** | 计划落成文档（本文件 + HANDOFF 勘误 + v2 API 施工图） | 文档 | — |
| **1** | **编排层**：8 个 agent 定义 + orchestrator/critic prompt + 四阶段 | 文本 | §2 配置目录隔离 |
| **2** | **记账插件** `@bd7pil/reeve`（台账/静默死亡/墙钟/并发/重启对账） | 代码 | 1 |
| **3** | **审查层**：`reviewer` + OCR rubric 与结构化契约 | 文本 | 1 |
| **4** | **代理层**：Bifrost 接入（含半截流实验、`served_model` 归因） | 配置 + ocrc 改动 | §2 配置目录隔离 |
| **5** | 控制台（可选） | 代码 | 2 |

### 验收（硬门槛，不过不进下一步）

**步 1 — 编排层**

| 检查 | 标准 |
|---|---|
| grill 先于动手 | 给一个模糊需求 → 它先提问，而不是直接改文件 |
| 文档是接口 | 给一个多步任务 → 它先出**自包含文档**，再派活 |
| 权限闸门 | `critic` / `advisor` 无法 edit/shell（尝试时应被拒） |
| 验收独立性 | subagent 声称完成 → `foreman` **自己**读产物/跑测试，不引用它的结论 |
| 多轮评审 | 一个有明显缺陷的计划被驳回 **≥2 轮**，且每轮聚焦不同维度 |
| 无 omo 字面 | 全仓 grep 无 `Sisyphus` / `Momus` / `Atlas` / `Prometheus` / `Metis` 与 omo 的 prompt 片段 |

**步 2 — 记账插件**

| 检查 | 标准 |
|---|---|
| 在飞可查 | `reeve_task_status` 返回 running 列表 |
| 静默死亡 | kill 一个子会话 → 父 agent 收到"已停止且无终态结果"的通知 |
| **无假警报** | **正常完成的子任务不产生任何误报**（回归测试） |
| 墙钟 | 卡死的子任务在到期后被中断，且父 agent 收到通知 |
| 并发 | 超限时**排队而不是直接失败**；**嵌套任务不被自己卡住** |
| 超时不可逆 | 迟到的"完成"事件不能覆盖已发布的超时 |
| 跨重启 | 重启后**如实标未知**（不谎报 running，也不谎报 completed）；已删除的子会话 → 墓碑 + 拆除，不留幽灵 |
| 零冲突 | 插件加载后，面板的 Agents 页保存操作不产生任何冲突或静默覆盖 |

**步 3 — 审查层**：故意提交一个有 bug 的 diff → 被抓到、**带行号**、输出符合结构化契约。

**步 4 — 代理层**

| 检查 | 标准 | 结果 |
|---|---|---|
| 回退可靠 | 链头用坏 key → 第二个模型必须接上，请求成功 | ✅ `hop=0 xiaomi error(Invalid API Key)` → `hop=1 zhipuai-coding-plan/glm-5.3-flash success` |
| 别名稳定 | 同一会话多轮，Bifrost 侧始终收到 `reeve/<档位>` | ✅ 引擎请求的 `routing_rule_name` 就是 `reeve/pro` / `reeve/flash` |
| 视觉别名 | 只有视觉调用走 `reeve/multimodal` | ✅ 带图那次走 `reeve/multimodal`，其余档位不变 |
| **半截流** | opencode **不把截断流当成功**（否则需要在代理侧额外处理） | ✅ 不当作成功，会重试（未决 #1 已关） |
| 归因可查 | 能回答"这 196 次 quota 错误分别是哪个 provider 撞的" | ✅ `scripts/served-model.sh` 输出档位→provider/model/key/状态 + 每跳归属 |
| 档位分流 | 主 agent 走 pro、被委派的子 agent 走 flash | ✅ 同一场对话里 foreman 9 次 `reeve/pro`、scout 8 次 `reeve/flash` |

**步 5 — 控制台**：面板能看到子任务状态与台账 ✅（真装进 EL7 的 openchamber 2.3.3，
真渲染，台账经宿主的文件桥读到；见 [PROGRESS.md](PROGRESS.md) §5）；
保存配置后插件正确读到 ✅ **面板层已在真界面上验过**：Agents 页保存一次，
**只新增一个 user 作用域 agent markdown**，`opencode.jsonc`（三端共享 symlink）/
`opencode.managed.json`（plugins 数组）/ staging `opencode.json` **逐字节未变**；
缺项目上下文时是 400 + 界面报错（**不是静默**）。详见 [PROGRESS.md](PROGRESS.md) §5.5；
**无任何双写冲突** ✅ 机制层 + 面板层都已验。

---

## 11. 未决项

| # | 未决 | 影响 | 怎么解 |
|---|---|---|---|
| 1 | ~~代理"半截流"（首 token 之后才失败）的行为~~ | ✅ **已解决（2026-10-19 实测）** | 见下 |
| 2 | ~~`ttft_timeout_ms` 放在 target 级还是 rule 级~~ | ✅ **已解决 = target 级** | EL7 上实测：运行时执行的迁移叫 `add_ttft_timeout_ms_column_to_routing_targets`，列在 **targets** 表 |
| 3 | ~~惰性对账挂 `ctx.session.hook("context")` 还是 `"prompt"`~~ | ✅ **已解决 = `prompt`** | 实测触发顺序：`prompt` → `execution.started` → `context` → `step.started`。`prompt` 最早，语义最贴"父会话下一次活动" |
| 4 | ~~Bifrost 静态二进制在 EL7 上真能起~~ | ✅ **已解决（2026-10-19）** | v2.3.0 静态链接，EL7 起得来；**并已跑完一整轮 staging 全链部署**（[PROGRESS.md](PROGRESS.md) §4.4） |
| 5 | **审查 subagent 的误报率** | 决定 severity 何时升级为门禁、要不要装 OCR | ⏳ **按默认取"都不卡流程"，跑两周再统计**（见 §12 #10） |
| 6 | ~~是否需要 `free-only` / `long` 档~~ | 决定 3 档还是 4–5 档 | ✅ **按默认取 3 档**；`free` 是链序不是档位，`long` 真遇到再加（§12 #1/#2） |

> **上机后新增的坑（已解决，记在这里免得重查）**：Bifrost 的两处静默失败
> （`base_url` 带 `/v1` 会双拼；**流式走单独的 `chat_completion_stream` override 键** ——
> 只设 `chat_completion` 时 curl 正常、引擎一跑就 405）、provider id 撞内置名、
> 保留期的键是 `client` 不是 `client_config`、推理默认要 virtual key、`served_model` 列恒 NULL。
> 逐条与证据在 **[PROGRESS.md §4.4](PROGRESS.md)**，`proxy/config.json` 已按实测修正。

### ✅ 未决 #1 的实测结论（2026-10-19）

**问**：代理在流已经开始之后失败时，opencode 会不会把**截断的流**当成成功？

**做法**：桩服务先发 2 个有内容的 `delta` chunk（首 token 已经发出去了），
然后 `res.destroy()` **直接掐断连接**——不送 `finish_reason`、不送 `[DONE]`。
客户端看到的是"HTTP 200 + 流中途断掉"，而不是 HTTP 错误。

**结果**：**opencode 不把截断流当成功。** 它**重试**——桩在窗口内被打了 **12 次**，
每次都被掐断，它始终没接受那段截断的文本。

**结论（对代理层设计的影响）**：
- **半截流不会造成"假成功"** → 不是正确性问题。
- 但**客户端重试会打回代理**，代理可能因此走回退链——**能成，但慢**（吃 opencode 的退避）。
- 所以 `ttft_timeout_ms` **仍然值得配**：它让代理在**首 token 之前**就换下一个 provider，
  比"等客户端重试"快，也避免客户端侧的重试抖动。**是优化项，不是正确性必需项。**

**复现材料**：`D:\develop\ocrc-exp\cuttest\cutstub.mjs`（`CUT_MODE=after-2-chunks | before-any`）。

**已解决**（别重复调查）：opencode 忽略响应模型名（HANDOFF §4.4）；omo-slim 台账跨重启不存活
（HANDOFF §6.4）；omo 上游拒绝移植（HANDOFF §1.2）；**v2 插件 API 的真实形态**
（[research/opencode-v2-plugin-api.md](research/opencode-v2-plugin-api.md)）。

---

## 12. 已取的默认值（**不是待确认，是已定；一句话就能改**）

原先这里挂着 6 个"待使用者确认"、外加 4 个实施期决定。执行时**全部按下表落定**并写进实现与文档。
依据在右列；**不同意任何一条，说一声就改**（都只是一处配置或一句文案）。

| # | 问题 | **已取的默认** | 依据 |
|---|---|---|---|
| 1 | 有没有"永远不许溢出到付费配额"的活？→ 3 档还是 4 档 | **3 档**（`flash`/`pro`/`multimodal`）；"先试免费"用**链序**表达（免费模型当头，配额耗尽自动落付费） | 链序本来就能做这件事；多一个档位只是多一处要维护的映射 |
| 2 | 有没有超长上下文场景？→ 要不要 `long` 档 | **先不加** | 3 档已覆盖日常；`long` 真遇到时加一行 rule 即可 |
| 3 | 那 4 个原生 provider 的 endpoint | ✅ **已解决**：models.dev 目录里就有（`npm=@ai-sdk/openai-compatible`），**且上机核对了路径拼接规则** | `proxy/README.md` 的 endpoint 表 + `config.json` 的双 override |
| 4 | 部署是否归 ocrc | **是**。本仓库只出**资产与脚本**（`scripts/el7-deploy-staging.sh` 等），ocrc 负责推与起 | 与"配置目录隔离杠杆 = `HOME`"是同一处改动；本仓库不越界改 ocrc |
| 5 | 插件包名 / 扩展目录 | **`@bd7pil/reeve`** / **`extensions/reeve`** | 已按此实现 |
| 6 | omo 实际生效版本（4.19.4 / 5.0.0） | **不追** | 与 REEVE 无关：v1+omo 这条线整体不救了 |
| 7 | 部署路径 | **先 EL7 staging（隔离 `HOME`）** —— ✅ 已做完；ocrc 集成留后续 | 隔离杠杆实测是 `HOME`；改 ocrc 是另一个仓库的活 |
| 8 | `limits.default` | **8** | 实测峰值 88；无上限是失控风险，8 是保守起点（插件支持按 model/provider 覆盖） |
| 9 | 台账 `retentionDays` / Bifrost `client.log_retention_days` | **都 30 天** | 台账只清**已落终态**的（在飞的不动）；Bifrost 默认 365 太松 |
| 10 | 审查 severity 是否卡流程 | **都不卡** | 规则带 Java 企业栈指纹，先跑两周看误报率再定 |
| 11 | 控制台（步 5）做不做、做完装不装 | **做，且已装到 EL7 的 openchamber 上**（只读、能力已批准） | 只读面板不会与引擎抢配置；不想要就在 设置 → 扩展 里移除 |
