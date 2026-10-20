# REEVE 交接文档

> **读者假设**：你是一个**从零开始的执行 agent**——没有参加过产生本项目的讨论，
> 不知道 openchamber / ocrc / omo 是什么，也不知道该先做什么。
> **本文档的目标是让你能独立、按顺序地把这个项目做出来**，而不是让你"了解背景"。
> 事实带出处；推测处已标注"推测"；**不确定的地方明确标注为"必须问人"**，不要猜。
> **日期**：2026-10-19。**状态**：设计定案，**尚未写任何代码**。
>
> **⚠️ 开工前先读 §15（执行协议）**——它告诉你最小必读集、按什么顺序做、
> 以及**哪四件事必须先问使用者**（不问就会猜错）。

---

## 0. 背景、目的与术语

### 0.1 现在的样子（先读这个，否则后面全是悬空引用）

**三个外部件**——REEVE 站在它们中间，它们各自是什么：

| 件 | 是什么 | 与 REEVE 的关系 |
|---|---|---|
| **opencode** | 一个开源的编码 agent 引擎（CLI/服务）。有 **v1** 与 **v2** 两代，插件 API **不兼容** | REEVE 的**宿主**：REEVE 的记账层就是一个 opencode 插件 |
| **openchamber** | opencode 之上的开源驾驶舱/IDE（MIT，约 11.8k★，`openchamber/openchamber`）。**它就是"面板"** | REEVE 的**显示面**（可选的控制台是它的扩展） |
| **ocrc** | **另一个项目**（`D:\develop\ocrc`，npm `@bd7pil/ocrc`）。职责是**把 openchamber 装到远程机器上并连起来**（ssh 推送运行时/引擎/应用 + 配对链接） | **邻居，不是本仓库的一部分**。本文出现的 `ocrc` 路径引用都指那个仓库 |

**拓扑**（REEVE 运行在哪）：

```
[面板宿主]  Win/Mac，跑 openchamber 桌面版
     │  ssh 转发
     ▼
[被控端]    EL7 机器（RHEL 7.9 / glibc 2.17 / 有外网）
     ├─ openchamber 实例（ocrc 装上去的）
     ├─ opencode v2 引擎   ← REEVE 的插件跑在这里
     └─（REEVE 的可选控制台：openchamber 扩展，与插件同机）
```

**关键**：控制台（openchamber 扩展）与插件（opencode 插件）**在同一台机器上**（都是被控端），
所以两者之间的桥接可以是文件。这条决定了 §8.1 的设计。

### 0.2 使用者是谁、现在怎么干活

单人自用、企业内网受控环境。**现在**的形态：

- 在被控端跑 **opencode v1** + **`oh-my-openagent`(omo)** 插件（多智能体编排）+
  `@bd7pil/opencode-deep-memory`（上下文/记忆）+ `@ramtinj95/opencode-tokenscope`（用量统计）
- 4 个 MCP（searxng / playwright / tavily / codegraph）、6 个 provider
  （**多为免费或第三方中转档**，配额经常耗尽）
- 通过一个 TG 通道遥控

**他实际怎么用**（实测数据，678 个会话，见 §11）：

- **95% 的会话是子会话**——"把活派给专家 agent、自己只看结果"是主导工作方式，不是理想
- 峰值一个父会话同时跑 **约 88 个子任务**
- **配额耗尽 196 次**、余额不足 29 次、限流 26 次——**跨 provider 回退是这套策略能成立的前提**

**他的四条工作原则**（他自己陈述的，§2.2 有展开）：

1. 写实施计划前，必须 **grill 到完全清楚**（背景、目的、实施路线）
2. 产出**不携带上下文的 subagent 也能看懂的实施文档**（文档即接口）
3. 实施计划必须经过**多轮次、多角度**评审
4. subagent 完成后，**orchestrator 必须亲自验证产物**——因为
   **"agent 直接会有欺上瞒下的问题"**

### 0.3 目的：要做成什么

**触发**：openchamber 只支持 opencode v2，而 **omo 在 v2 上加载即失败**，
且**上游明确拒绝移植**（§1.2 有维护者原话）。所以使用者需要在 v2 上**重建自己的编排层**。

**目标（按使用者的四条原则展开）**：

| 目标 | 对应层 |
|---|---|
| 配额耗尽不再卡死；模型链只在一处维护 | **代理层** |
| grill → plan → 多轮评审 → 执行 → **orchestrator 亲自验** | **编排层 + 审查层** |
| 无人值守长跑可靠：子任务死了要知道、卡死要被掐、并发不失控、重启不撒谎 | **记账层** |
| 能看到子任务在跑什么、能改配置 | 控制台（可选） |

**成功标准（可验收）**：

1. **回退可靠**：链头 provider 配额耗尽时，下一个自动接上，请求成功
2. **审查挡得住**：一个有明显缺陷的计划会被驳回 ≥2 轮，且每轮聚焦不同维度
3. **证据不自述**：subagent 声称完成时，orchestrator **自己**读产物/跑测试，不引用它的结论
4. **无人值守可用**：静默死亡的子任务会通知父 agent；卡死的会被墙钟掐掉；
   并发有上限；重启后台账**如实标未知**而不是谎报
5. **无许可污染**：仓库内不出现 omo 的任何代码或 prompt 字面

**明确不做**：fork omo（上游已放弃该面 + 永久 SUL-1.0 + 1.8 版/天漂移）；
把回退做进插件（会随 v2 API 漂移一起烂）；控制台做成 controller（控制面在模型侧）。

### 0.4 术语表（本文档的自造词）

| 词 | 含义 |
|---|---|
| **代理层 / 代理** | 站在 opencode 与真实 provider 之间的 LLM 网关（本方案用 Bifrost），负责跨 provider 回退 |
| **档位** | 一个"虚拟模型"（如 `reeve/pro`），背后是一条有序的模型链。**档位表达能力，链表达成本顺序** |
| **别名** | opencode 侧看到的模型名（即档位名，形如 `reeve/<档位>`）；真实模型对引擎不可见 |
| **台账** | 插件自持的子任务登记表（谁在跑、状态、起止时间）。因为 **v2 不给插件会话列表**，台账是唯一的账 |
| **编排层** | prompt + agent 定义，负责调度纪律与四阶段流程 |
| **记账层** | opencode 插件，负责台账/静默死亡/在飞查询/墙钟/并发 |
| **审查层** | 负责对代码 diff 做独立审查的 subagent |
| **被控端** | 跑 opencode 引擎与 openchamber 实例的那台机器（本方案是 EL7） |
| **面板宿主** | 跑 openchamber 桌面版的机器（Win/Mac） |
| **omo** | `oh-my-openagent`，当前在 v1 上用的多智能体编排插件，**要被替代的那个** |
| **OCR** | `alibaba/open-code-review`，阿里开源的代码审查工具，**只吸收其规则，不装工具** |

---

### 0.5 一句话总结

**REEVE 是在 opencode v2 上自有的多智能体编排层**：一个把活派给专家 agent、
自持子任务台账、并亲自验收产物（不接受 subagent 自述）的编排系统。

它由四层组成，每层用不同的许可、不同的实现形态：

| 层 | 职责 | 形态 | 许可 |
|---|---|---|---|
| **代理层** | 跨 provider 回退（配额/限流/网络故障转移） | 独立服务（Bifrost） | Apache-2.0 |
| **编排层** | 调度纪律、四阶段流程、agent 定义 | **prompt + 配置** | 自写 |
| **记账层** | 子任务台账、静默死亡、在飞查询、墙钟、并发 | **opencode plugin** | 自写（可抄 MIT） |
| **审查层** | 代码 diff 的独立审查 | **吸收 OCR 的规则进 subagent** | Apache-2.0 |

**控制台**（可选）：一个 openchamber extension，只读可视化 + 配置编辑。

---

## 1. 为什么这个项目存在

### 1.1 触发链

被控端（EL7，RHEL 7.9 / glibc 2.17）要从 **opencode v1 + `oh-my-openagent`** 迁往
**openchamber + opencode v2**。

- openchamber 面板**硬要求 opencode major=2 且 ≥ 2.0.20**
  （本仓库参照实现：`ocrc` 的 `src/core/remote-instance.ts:331-332`，pin 默认 `2.0.27`）
- **`oh-my-openagent`(omo) 在 v2 上加载即失败**：`latest` = 5.1.35 的默认导出仍是 V1 形状
  `{id, server}`，v2 要 `{id, setup}`。报错
  `Plugin must export a default definition with an id and an effect or setup function.`
  issue #8485 的结论原文：*"Workaround: **None**. The plugin cannot load at all in V2.
  Users must stay on OpenCode V1."*

### 1.2 上游明确拒绝移植（这是决定性的）

维护者本人 `code-yeongyu`，issue **#9389**（2026-10-17）：

> "We are **not taking the full port into this repo**: OpenCode 2 support here stays scoped to
> loading the plugin (#10439, tracked in #8485), and **the full omo experience is shipped as
> OmO Native**. Your fork remains the place for a complete OpenCode 2 port."

并在 **#10374**（2026-10-16）主动暂停了社区移植线：

> "We've **paused the OpenCode V2 dual-host track on our side for now**, so these PRs won't get
> a review while it's paused… Please **hold further slices** until we reopen the track."

这是一次**反转**：2026-10-01 他曾称双宿主是 *"the direction we're consolidating on"*，
要求社区拆成可评审切片；社区交了三片（#9391 / #9415 / #10374），第三片到达**当天**整条线被停。

### 1.3 上游实际交付的"v2 支持"

**PR #10439**（2026-10-18 合并，随之关闭 #8485）自述的全部范围：

> "On OpenCode 2 the plugin loads, and **every start shows a TUI toast that points to OmO Native**
> with the install command and guide link."

**4 个文件**（`packages/omo-opencode/src/opencode-v2/{server-entry,tui-entry,startup-notice}.ts`）。
**加载 + 弹广告，零功能。**

### 1.4 上游的方向是离开 opencode

- README 标题：**"OmO 5.0: OmO ❤️ Pi"** —— *"It runs on **senpi**, our fork of pi"*
- 安装改为独立二进制（`curl get.omo.dev/install.sh`）或 npm 包 **`omo-ai`**；配置搬到 `~/.omo/omo.jsonc`
- 作者自己的迁移指南是 **omo(OpenCode 插件) → omo Native**，不是修 opencode 插件
- ROADMAP 把适配器列为"OpenCode、Codex、Senpi 和独立 Pi"——**OpenCode 只是其中之一**

### 1.5 为什么不 fork

| 项 | 数字 |
|---|---|
| 上游速度 | 17.2 天发 **31 个版本**（≈1.8 版/天）；v5.1.4→v5.1.35 = **3,580 commits / 300 files** |
| 待移植面 | `packages/omo-opencode/src` = **2,709 个 .ts / 364,421 行**；**347 个文件** import `@opencode-ai/*`（18 天后涨到 353） |
| 现有社区 PR | #9016 (+3415/−24)、#9094 (+3530)、#8768 (+3233)、#8626 (+2716)——**全部 CONFLICTING**；唯一可合并的 #8297（122 行）**BLOCKED** |
| 社区那个"完成的"fork | `fazulfi/omo-v2` **不是移植是重写**：删 2,493 个文件（该包非测试 LOC 的 ~89%），剩 25,335 行；**V2-only**（v1 侧会失去 omo）；**18 天未动**；钉 `@opencode/plugin` 2.0.20（最新 2.0.32） |
| 会继承的 bug | 同一作者报的 **22 个 V2 adapter issue**（~20 开着）：#10173 丢 `parentID`（UI 里子会话变顶层）、#10174 按显示名列出导致派发失败、#10248/#10465 压缩与事件管线、#10245 **静默覆盖显式配置的 MCP**。**多数是静默失败** |

**结论：fork 意味着成为"omo-on-opencode"的唯一维护者，永久，而上游已放弃该面。**

---

## 2. 这个项目要解决什么（需求清单）

需求来自使用者的实际工作方式，不是猜的。

### 2.1 使用者确认的四条记账需求（全部要）

| 需求 | v2 原生 | 说明 |
|---|---|---|
| 子任务静默死亡的通知 | ❌ | 子任务死了，父 agent 永远不知道 |
| 在飞任务查询 | ❌ | v2 删了 `task_status`；重启/丢通知后查不到 |
| 跨重启续跑 | ❌ | 宿主不给会话列表，只能自持台账 |
| 墙钟超时 | ❌ | 子任务卡死没人掐 |
| （并发上限） | ❌ | 实测峰值约 88 个重叠子任务，无上限是失控风险 |

### 2.2 使用者的四阶段工作流（原话归纳）

1. **grill 到完全清楚** —— 写实施计划前，必须问清**任务背景、目的、具体实施路线**
2. **产出"不携带上下文的 subagent 也能看得懂的实施文档"** —— 文档是接口
3. **实施计划必须经过多轮次多角度评审**
4. **subagent 完成任务后，orchestrator 必须亲自验证生成质量**

第 4 条的理由是使用者的一句关键判断：**"agent 直接会有欺上瞒下的问题"**。
→ 这被提升为**架构约束**：**证据必须由 orchestrator 独立复现，不能由 subagent 自述。**

### 2.3 使用者的四条优先级（(a)(b)(c)(d) 全要）

| | 动机 | 归属 |
|---|---|---|
| (a) | 上下文污染——不想让探索过程塞满上下文 | 子会话天然 fresh context（原生） |
| (b) | 成本/模型分工——贵模型规划、便宜模型执行 | per-agent `model` + 代理档位 |
| (c) | 质量闸门——接受结果前有对抗性审查 | **编排层 + 审查层** |
| (d) | 吞吐——一次丢几个任务，过一会儿回来收 | 后台 subagent + 记账层 |

### 2.4 明确纠正过的两个误判（别重犯）

- **不是"orchestrator 太爱自己动手"** —— 使用者认为当前比例**合理**。
  （曾据 omo-slim 社区抱怨推断 omo 也有此问题，**那是错的**：抱怨来自另一个工具，
  使用者未用过 omo-slim。）
- **`multimodal-looker` 已过时** —— 模型普遍多模态后，主 agent 直接读图即可。
  其残余价值只是"上下文卸载"（其 prompt 原文：*"The main agent never processes the raw file -
  you save context tokens"*），而使用者判断读图不构成上下文压力。
  → **该 agent 可撤**（它是当前会话数第一名，239 个）。

---

## 3. v2 原生给足什么 / 缺什么（决定分层的根据）

### 3.1 原生给足（零代码）

`subagent` 工具（v1 叫 `task`），参数 `agent` / `description` / `prompt` / `model` /
`sessionID` / `background`：

- **前台调用同步返回**，结果作为工具结果进入父 agent 上下文
- **后台调用（`background: true`）立即返回**，子任务终止时宿主注入
  `<subagent sessionID="…" state="completed">…</subagent>` 到父会话**并唤醒父 agent**
  （源码 `packages/core/src/session/subagent-completion.ts` 的 `sessions.synthetic(...)` +
  `execution.wake()`）；空闲父会话收到新回合，忙碌父会话收到 steer
- **每 agent 独立 `model` / `system` / `permissions`** —— markdown frontmatter 或 JSONC，零插件
- 原生把 `Available subagents:` 名册注入工具描述；父 agent 可用 `subagent` 权限白名单限制可派对象
- `experimental.subagent_depth` 默认 **1**（需要多层要显式放开；注意在 `experimental` 下，无稳定性承诺）

**v1 → v2 的键名变化**（踩过就知道）：v2 是复数 **`agents`**（v1 单数 `agent`）；
`prompt`→`system`、`disable`→`disabled`、`permission`→`permissions`、`maxSteps`→`steps`、
`variant` 以 `#variant` 后缀出现。

**纠正一个流传的说法**：`OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` 是 **v1-only** 变量，
**v2 里不存在**（v2 删掉了整个 flag 模块），后台 subagent 在 v2 是无条件的。
omo-slim 的安装器还在导出它，在 v2 上是**空操作**。

### 3.2 原生缺的八条（= 记账层的全部需求）

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

### 3.3 一条决定插件骨架的硬约束

**v2 不把 `session.list` / `session.status` / `session.todo` / `session.children` 交给插件。**
v2.0.32 的 `SessionDomain` 是
`create/get/remove/switchAgent/switchModel/prompt/generate/command/compact/synthetic/interrupt/update/move/wait/context`。

> **⚠️ 勘误（2026-10-19 实测）**：旧版这里把 `remove` 误列进"不给"的一侧，并漏了 `compact`
> ——这两个**是给插件的**。"拿不到 `list`/`children`/`status`/`todo`"这条**仍然成立**。
> **且这条清单版本敏感**：上游 `dev` 分支后来把 `list` 加了进去。REEVE pin 2.0.32，
> **升级引擎必须重新核对**。出处：[research/opencode-v2-plugin-api.md](research/opencode-v2-plugin-api.md) §6。

→ **插件无法枚举会话。** 所以第 1/2/3 条**不能靠询问宿主**——
**插件必须自持并（可选）落盘子会话台账**，且**父会话的持久化转录是唯一事实源**。

---

## 4. 代理层（回退）

### 4.1 为什么把回退从插件里拿出来

- **数据证明回退是命根子**：`opencode.log`（27 MB）里 1,045 条 ERROR——
  `exceeded your current quota` ×196、`Insufficient Balance` ×29、upstream rate limit ×26、
  Bad Gateway ×32、Service unavailable ×30、Authorization Required ×20、socket/TLS ×102。
  **`mode=primary` 505 次 vs `mode=subagent` 218 次** —— orchestrator 自己也频繁撞墙。
  74 个会话中途换过模型，其中一个轮了 9 个。
- **opencode v2 自身零跨 provider 回退**（schema 无 fallback 字段；只有同模型重试 + 指数退避，
  且 auth/quota/content-policy **不重试**）
- **插件层的回退只在插件正常加载时生效** —— 而配额耗尽恰恰是最容易让整条链崩的场景
- **代理与 opencode 版本无关，永不随 API 漂移而腐烂**

### 4.2 候选筛选（EL7 约束：glibc 2.17 / Python 3.6 / 不保证 Docker）

| 候选 | EL7 可跑 | 许可 | 结论 |
|---|---|---|---|
| **LiteLLM** | ❌ 要 Python **3.10+** 或 Docker（Alpine）；**无独立二进制** | MIT | 功能最全，EL7 装不了 |
| **Bifrost** (`maximhq/bifrost`) | ✅ **静态链接 Go 二进制**（`file` 实测 `statically linked`，不依赖宿主 glibc） | Apache-2.0 | **选定** |
| new-api | ✅ Go 二进制 | ⚠️ **AGPL-3.0** | 许可顾虑 |
| Portkey Gateway | ✅ Node/TS（可用已有的 Node 24 glibc-217） | MIT | 备选 |
| ~~one-api~~ | — | MIT | **已废弃**（最后提交 2025-02） |

### 4.3 Bifrost 已确认的两件事

**① routing rules + TTFT 截止是 OSS，无门禁。** 证据：
`docs/docs.json` 的 OSS tab（52–316 行）含 `providers/routing-rules`，Enterprise tab（317–431）
全是 HA/RBAC/审计/guardrails；v2.3.0 的 **OSS changelog** 明写 TTFT 是 OSS 特性；
`plugins/routing/rules/engine.go` 零处 license/enterprise 引用；路由插件在 OSS 构建**无条件注册**。

**② 响应体 `model` 字段回的是"被服务的模型"，不是调用别名。** 源码
`core/schemas/utils.go`：
`// ServedModel returns the model the provider named on the response body. It can differ from the model the caller addressed.`
别名另在响应头暴露（每条路由都有）：`x-bifrost-routing-info-requested-model` / `-model` /
`-alias-model-id` / `-is-fallback`；响应体 `extra_fields.routing_info.*`。

### 4.4 ★ 关键实测：opencode 忽略响应体的模型名（**已解决**）

**这是本层选型的前提条件，已验证成立。**

**实验**（隔离栈，不碰生产引擎）：约 60 行 Node 桩伪装成 OpenAI 兼容端点，
**对每一个请求都返回 `"model": "SERVED-MODEL-X"`**（调用者从未请求过的名字），
记录每个请求的 `model` 字段。隔离目录装 `@opencode/cli@2.0.32`，
自定义 provider 指向桩，模型 id = `router/flash`。同一会话连发 4 轮
（**第 3、4 轮故意不带 `--model` 标志**）。

| 请求 | 回合 | 带 `--model` | 桩收到的 `model` |
|---|---|---|---|
| 4 | 1 | ✅ | `router/flash` |
| 5 | 1（工具轮） | ✅ | `router/flash` |
| 6 | 2 | ✅ | `router/flash` |
| 7 | 3 | **❌** | `router/flash` |
| 8 | 4 | **❌** | `router/flash` |

**5 次全是 `router/flash`**；数据目录里**没有任何文件出现过 `SERVED-MODEL-X`**；
模型名不匹配时**无报错无警告**。

**源码级独立佐证**（`anomalyco/opencode` 的 `dev`(=v2, 2.0.32) 与 `v1.19.3` 两个 ref）：

- v2 里模型是**会话行的一列**，唯一写点是 `SessionEvent.ModelSelected`，
  其唯一发布者是 `Session.switchModel`，三个调用方**全部传请求侧的 ref**
- **没有任何代码读响应体的 `model`**：`LLMResponse` 结构里没有 model 字段；
  OpenAI-chat 流式 schema 只声明 `choices`/`usage`/`error`，**响应 `model` 连解析都不解析**；
  AI SDK 桥接对 `response-metadata`（正携带 served modelId 的事件）**显式返回空**
- 全仓搜 `servedModel` / `responseModelID` / `model_mismatch` → **各 0 命中**

**对得上号的 issue 是 #38543**（不是 #53060）——"Assistant message modelID records the requested
model, never reconciled against the provider response"，**已由 stale bot 以 `not_planned` 关闭**。
其中一条评论是同类实测：配 `openrouter/free`，OpenRouter 返回真实模型名，
**opencode 记录并持续显示请求的名字**，不做对账。

→ **代理层可以放心用"虚拟别名"模型。别名是引擎侧唯一知道的名字，
链在代理内部随意变化，对引擎完全透明。**

**复现材料**：`D:\develop\ocrc-exp\`（`stub.mjs`、`stub-log.jsonl`、隔离的 `home/`）。

### 4.5 ★ 两条必须一并规划的限制

1. **opencode 永远不会告诉你实际是谁服务的。** 响应模型名不捕获，**响应头也被丢弃**
   （issue #26091，其评论里**点名 Bifrost** 的 `x-bifrost-resolved-model`）。
   所以 UI 标题、`opencode stats`、会话导出、**成本记账全部按别名计**。
   → **"哪个 provider 真的服务了这次请求"必须在代理侧记账**（Bifrost 有 `served_model` 日志列），
   否则**配额归因会失真**——196 次 quota 错误里分不清是哪个 provider 撞的墙。
2. **别名必须在 catalog 里可解析**，否则 `SessionRunnerModel.resolve` 抛
   `ModelUnavailableError`（v2）。这正是 #53060 那种"静默冻结"的失败形态。

### 4.6 其他已知约束

- 二进制**不在 GitHub Releases**，只在 `downloads.getmaxim.ai`；~128 MB。
  **air-gap 分发要单独设计。**
  - 下载 URL 形态（已核实）：`https://downloads.getmaxim.ai/bifrost/{版本|latest}/linux/amd64/bifrost-http`；
    版本号从 `https://getbifrost.ai/latest-release` 的 `name` 字段取（快照最新为 v2.3.0 / 2026-10-13，需复核）
  - **app-dir 默认是 OS 配置目录**（Linux `~/.config/bifrost`），**不是工作目录**；`config.json` 放里面
  - **静态链接已确认**（不依赖宿主 glibc → EL7 可跑）。但**别写成 `CGO_ENABLED=0`**——
    静态构建用的是 `-tags sqlite_static -extldflags '-static'`，SQLite 本身需要 CGO
    （顺带：`CGO_ENABLED=0` 那句在 verdict 文档里其实是讲 **OCR** 的，不是 Bifrost）
  - **⚠️ 勘误**：官方文档站是 **`docs.getbifrost.ai`**（`docs.getmaxim.ai/bifrost` 已 404）；
    且"所有 tag assets=0"这条**未能证实**（release workflow 是把二进制当 CI artifact 上传，
    不是 release asset——与"不在 Releases"一致，但不是证据）
- 改 `config.json` **要重启**；热改走 `POST /api/routing/rules`
- **文档坑**：`governance.mdx` 示例写 `cel_expression: "request.model == 'gpt-4o'"`，
  但引擎注册的变量是 `model`（字符串），`request` 是**数值型预算变量**。正确写法 `model == "reeve/flash"`
- `fallbacks` 用 `"provider/model"`；写 `"provider/"` 表示**同模型换 provider**
- **反向证据（必须记）**：opencode 官方关闭的 PR **#26292**（"add LLM provider fallback chain"）
  理由原文：*"Why built-in instead of a proxy: cheaper providers are unreliable, and
  **routing through LiteLLM degrades tool-call quality**."*
  实锤：issue **#56124** —— 前面挂 LiteLLM 撞到
  `UnsupportedParamsError: Bedrock doesn't support tool calling without tools= param`。
  **缓解：只做 OpenAI 兼容端点之间的纯透传，不做任何格式翻译。** 上述 bug 源于跨 provider 翻译；
  透传（同一请求换 endpoint 重发）绕开它。代价：原生 provider
  （`zhipuai-coding-plan`、`deepseek`、`opencode`、`xiaomi`、`alibaba-cn`）需改写成
  `@ai-sdk/openai-compatible` 自定义 provider 指向代理。

### 4.7 档位设计：**3 档，不是 8 档**

**判据：一个档位只有在"模型能力或配额池不同"时才成立；只是 prompt 不同的不算档位。**

现有 8 个 category 按此判据塌缩：

| 现有 | 归属 |
|---|---|
| `ultrabrain` / `deep-low` | → **pro**（且这两条链逐字相同，本就重复） |
| `quick` / `unspecified-low` / `unspecified-high` | → **flash** |
| `visual-engineering` | → **multimodal** |
| `writing` / `artistry` | **不是档位**——是 prompt 追加，应进 agent 定义 |

**结论：`flash` / `pro` / `multimodal` 三档。**

**"free" 不建议做成档位**：免费档的诉求是"先试免费、配额耗尽再付费"，这是**链的顺序**问题，
由代理层的链解决——做成档位只是把链头重复一遍。
**唯一该把它独立成档的理由**是策略性的："这类活永远不许溢出到付费配额"。
若确有这个需求，则保留第 4 档 `free-only`。**（待使用者确认）**

**可能需要的第 4 个能力档：`long`（长上下文）。** 依据：会话量级 344.3M 输入 token，
且长跑（约 88 并发、37k 续跑状态文件）。若确有超长上下文场景，**它是能力差异而非 prompt 差异**，
按判据应当独立成档。

### 4.8 别名有原生表达方式（可少写一层配置）

v2 的 provider catalog 条目里有 **`modelID`** 字段：它决定"发给 provider 的名字"，
而条目在 `models` 里的 **key** 是用户可选的名字。

```jsonc
{ "model": "openai/coding-default",
  "providers": { "openai": { "models": { "coding-default": { "modelID": "gpt-5.2" } } } } }
```

其中 `openai/coding-default` 是可选项、`gpt-5.2` 是实际发出的名字。
**这就是"虚拟别名"的原生表达方式。**

> **⚠️ 2026-10-19 实测更正两处**：
> 1. **它不是"官方 Aliases 特性"——文档里根本没写。** 字段真实存在且有测试断言其语义
>    （`packages/schema/src/config/provider.ts` 的 `Model.modelID`；
>    `packages/core/src/model-resolver.ts:234` 的 `modelID ?? id`；
>    `packages/core/test/model-resolver.test.ts:263`），但 `models.mdx` 里没有 Aliases 一节。
>    → **属于"可用但未文档化"，升级引擎时要重新核对。**
> 2. **REEVE 现在就用它**（早先一度判断"不需要这层"，那是错的——见
>    [research/opencode-v2-plugin-api.md](research/opencode-v2-plugin-api.md) §10.1）。
>    用法是让 **ref 与线上名一致**：`models: { "flash": { "modelID": "reeve/flash" } }`
>    → agent 写 `model: reeve/flash`，Bifrost 收到的也是 `reeve/flash`。

---

## 5. 编排层（prompt + agent 定义）

### 5.1 目标工作流：四阶段

```
1. grill    → 问清背景/目的/实施路线，产出需求定稿
2. plan     → 写自包含的实施文档（context-free 可执行）
3. 计划评审  → 多轮 × 多角度，直到通过
4. 执行+验证 → 便宜模型照文档干；orchestrator 亲自拿产物验
```

**"不携带上下文的 subagent 也能看得懂的实施文档"这条约束很值钱**：
它意味着**文档是接口**，智力集中在文档里，执行可用便宜模型——
正好接上整套免费档策略：**贵的模型写文档，便宜的模型照文档干活，orchestrator 亲自验。**

### 5.2 要写死的架构约束（由"agent 会欺上瞒下"推出）

> **证据必须由 orchestrator 独立复现，不能由 subagent 自述。**
> 验证者不能是执行者，且拿到的是**产物本身**（diff、文件、真跑一遍），不是那份报告。

**反面教材（omo 的做法）**：它的"证据要求"只是**改完文件后 LSP 诊断干净、测试跑过**
——而且这些结论由**子 agent 自己声称**。对一个会欺上瞒下的 agent，这等于没有证据。

### 5.3 agent 名单（从实测数据来，不是从配置来）

实测 678 个会话（2026-07-26 → 10-04）的分布：

| 角色 | 会话数 | 身份 |
|---|---|---|
| `multimodal-looker` | 239 | 子 agent（**建议撤**，见 §2.4） |
| `general` | 169 | 子 agent（**注意：这是 opencode 内置的**，omo 只配了模型、没给 prompt） |
| `Sisyphus-Junior` | 73 | 子 agent（执行手） |
| `librarian` | 64 | 子 agent |
| `explore` | 47 | 子 agent |
| `Sisyphus - ultraworker` | **32 顶层** | **唯一的 orchestrator** |
| `oracle` | 27 | 子 agent（审查） |
| `Momus - Plan Critic` | 15 | 子 agent（计划批评） |
| `plan` / `build` | 7 / 3 | 顶层偶用 |
| ~~`metis` / `prometheus` / `atlas`~~ | **0** | **死配置** |

**目标名单（6–8 个，按职能命名，不用 omo 的神祇名）**：
orchestrator（`foreman`/`lead`）+ `planner` / `critic` / `advisor` / `scout` / `librarian` /
`executor`（+ 可选 `looker`）。

**命名建议**：职能名比神祇名更能约束模型行为（`critic` 比 `Momus` 更直接地告诉模型该干什么），
且与 omo 的配置彻底解耦。代价：要重写 prompt 的自我认知段——**但本来就要重写**（见 §5.5）。

### 5.4 数据结构的关键认知：category 不是 agent

omo 的 `resolveCategoryExecution` 把**每一个 category 都解析到同一个 junior agent 常量**，
没有按 category 选择不同的执行者。

→ **8 个 category 全部派给同一个 `Sisyphus-Junior`**，只是模型档不同。
真实拓扑比配置看起来简单得多。**REEVE 里档位同样只是"模型选择"，不是"派给谁"。**

### 5.5 omo 的两处必须改（这是"自己拥有编排"的直接论据）

**(a) 计划评审被设计成"别挡路"，与需求方向相反。** omo 的 `momus` prompt 的立场（**转述，非原文**）：

> 它明确要求**在有疑问时倾向批准**，认为计划"八成清楚就够了"；
> 把"**强制多轮修订**"列进"不做"的清单；对每次驳回的问题数**设上限**；
> 并自我定位为"**找阻断项的人，不是完美主义者**"。

而需求是"**多轮次多角度评审**"。**从 omo 里拿不到这个纪律，除非改 prompt——一旦改了，你就拥有了它。**

> **⚠️ 许可说明（2026-10-19）**：此处原先是 omo prompt 的**英文逐字引用**，
> 已改为中文转述——`NOTICE.md` 的提交门禁禁止把 omo 的 prompt 字面留在仓库里（SUL-1.0）。
> 论证不受影响：结论是"它的评审纪律与我们的需求方向相反"。
> 原始字面见归档 [research/orchestration-stack-verdict.md](research/orchestration-stack-verdict.md)
> 的对应段落（该文档是**归档证据**，`NOTICE.md` 里有说明）。

**(b) 同一 omo 换模型就换一套编排哲学。** `Sisyphus` 有 **11 个模型族变体**
（`resolveSisyphusPromptFamily` 分派）。GLM 变体的委派段说
**"是单个显而易见的改动就直接做"**；而 Claude-Opus-5 变体反而在**反过度委派**：
**"你比工作本身需要的更爱用子 agent……几次工具调用就能干完的活，自己做"**。

> （**转述，非原文**——同上，许可门禁不允许留 omo 的 prompt 字面。）

### 5.6 可借鉴的三段（说扛住大部分效果、也最便宜移植）

1. **意图门 + Context-Completion Gate** —— "当前这条消息里没有明确实现动词就不许改文件；
   上一轮的'实现模式'不许跨轮继承"
2. **反重复 + "结束你的回复，等通知"** —— 派出去之后不许自己再搜一遍，也不许轮询
3. **"没有证据 = 没完成"** —— 改文件要 lsp 干净、跑命令要退出码 0、跑测试要过

（**借思路，不抄字面**——见 §10 许可。）

---

## 6. 记账层（opencode plugin）

### 6.1 五处挂载点

> **⚠️ 本节已于 2026-10-19 按 v2.0.32 实测重写。** 旧版写的是 **v1 的 hook 名**
> （`tool.execute.before` / `tool.execute.after`），**在 v2 里不存在**。
> 完整签名、返回值与未验证项见 **[research/opencode-v2-plugin-api.md](research/opencode-v2-plugin-api.md)**
> ——**写插件前先读它，不要照本节旧写法写。**

```
① 拦 subagent 调用：ctx.tool.hook("execute.before", cb)
   → 并发闸门在 before（子会话创建之前）；input 可原地改、可返回 Tool.Error 阻断
② 落台账：ctx.tool.hook("execute.after", cb)
   → 拿 { tool, sessionID, status: "completed"|"error", result/error } → 解析 sessionID 落台账
③ 订阅事件：ctx.event.subscribe()
   → session.execution.succeeded/failed/interrupted → 命中在飞子任务 → 标终态、撤计时器
④ 每条子任务一个计时器（wall-clock）→ 超时 → 中断 + 标 timed_out
⑤ 台账落盘 + 对账 → 非终态记录标 unknown → 父会话下次活动时补通知
```

**注册工具必须同时带 `namespace` 与 `codemode: false`**：
`ctx.tool.transform(e => e.add({ ..., options: { namespace: "reeve", codemode: false } }))`

> **⚠️ 勘误（2026-10-19 实测）**：早先这里写"不带 `options.namespace` 的工具会被注册但不出现在
> 模型工具表里"——**归因错了**。`namespace` 只管**命名**（工具变成 `reeve_task_status`）；
> **真正决定"是否暴露给模型"的是 `options.codemode: false`**。
> 四个变体实测：都注册成功、`ctx.tool.list()` 里都在，但**模型只收到带 `codemode: false` 的那两个**。
> **静默失败，不报错。** 证据见 [research/opencode-v2-plugin-api.md](research/opencode-v2-plugin-api.md) §3.1。

**注意 v2 的事件形状**：v2 发 `session.execution.started/succeeded/failed/interrupted`。

> **⚠️ 勘误**：旧版这里写"**不再发** `session.idle`"——**部分错**。v2.0.32 **仍然发**
> `session.idle`，只是源码里明确标了 `// deprecated`。REEVE 的用法不变
> （`session.idle` 只当**候选**，不作终止判定），但**不要在弃用 API 上加依赖**。
> 另外 `message.part.updated` 与 `question.*` **不在 v2 的类型联合里**（v1 遗留）；
> v2 原生的是 `session.text.*` / `session.tool.*` / `session.step.*`。

### 6.2 四条需求的设计

**① 静默死亡 —— 没有"子任务死了"这个事件，全靠推断。**
三处证据：宿主 live-status（**5 秒轮询**）、子会话转录分类、宿主会话自身的 `outcome` 字段。
**关键设计（抄 omo-slim）**：`session.idle` 只是**候选**，不立即判定终止；
只有当转录判定为 `absent` **且**静默已持续超过宽限期才落 `stopped`：

```ts
const stable = now() - Math.max(value.quiescentSince ?? now(), token.attemptStartedAt ?? 0) >= graceMs;
if (evidence.verdict === 'absent' && stable)
  return commit(token, 'stopped', STOPPED_WITHOUT_TERMINAL_RESULT, undefined, 'transcript');
```

`STOP_CONFIRMATION_GRACE_MS = 5_000`。**这就是"静默失败边界"的实际解法**——
先用宽限期把"正常完成的最后一刻"和"真的死了"分开。
任何无法证明为终态的一律保持 `running` + `statusUncertain`，并排一次重试（默认 3 次）。

**② 在飞查询 —— 台账本身就是子会话注册表**（因为 v2 不给 `session.list`）。
子会话 id 来自 `session.created` 事件与 `subagent()` 工具输出解析；键就是子会话 id。
工具只读，绝不 prompt/abort/register。

**③ 跨重启 = (b) 档：从父转录重建**（使用者裁决）。
**宿主不给会话列表 → 父会话的持久化转录是唯一事实源。**
恢复是**惰性的**：父会话**下一次活动时**才扫（不是启动时扫）。

| 探测结果 | 处置 |
|---|---|
| 子会话不存在（`NotFoundError`） | 墓碑 + 拆除（**不要复活成永远在跑的幽灵**） |
| 有终态 outcome | 落真实终态（`interrupted`→`stopped`，`failed`→`error`，`succeeded`→`completed`） |
| 子会话存在但空闲/无输出 | **停止候选** → 宽限期后落 `stopped, unreconciled` |
| 其他错误 | fail-open，保持登记 |

**明确不做**：不主动重新派发（会重复副作用）。
**如实标注**：恢复是 best-effort，别名与终态结果**不恢复**。

**④ 墙钟 —— 每任务一次性定时器 + 宽限。**
只监督 `background === true` 的任务；只对新 `generation` 重新武装；
**忙碌/工具活动/存活信号都不续期**。到期后：先武装宽限定时器
（`abortGraceMs` 默认 10s），再发**恰好一次** `client.session.abort`
（v2 映射为 `s.interrupt({sessionID, resume:false})`）。宽限到期仍未确认 →
标 `statusUncertain` 并落 `error, timedOut:true, terminalUnreconciled:true`。
**已发布的硬超时不可被迟到的完成/忙碌替换。**

**⑤ 并发 —— 在 `execute.before` 钩子里排队（子会话创建之前）。**
即 `ctx.tool.hook("execute.before", cb)`——**不是** v1 的 `tool.execute.before`。
档位解析：**模型上限 > provider 上限 > 默认上限**，`0`/缺省 = 无限。
两条正确性性质（抄 omo-slim）：
**(a) 嵌套的受管任务必须豁免**（它们已持槽，再等会**自死锁**）；
**(b) 调度器按目录进程级共享**，插件重载后保留运行中槽位与排队票。

### 6.3 体量与难点

骨架约 **500 行**。**真正的难点是静默失败的边界**——例如必须能区分
"宿主已发过终态通知"与"没发过"，否则会把每个正常完成的子任务都误报成死亡。
**这类系统里最贵的 bug 不是崩溃，是静默不一致**（台账说在飞、宿主说已死、父 agent 以为还在等）。

### 6.4 可抄的 MIT 实现（`oh-my-opencode-slim` v3.0.5）

架构主干：`BackgroundJobBoard`（状态）← `BackgroundJobCoordinator`（单写者 + 监听分发）
← `BackgroundJobStore`（接口）← `BackgroundJobTerminalGate`（终态判定边界）
+ `BackgroundJobSupervisor`（墙钟）+ `BackgroundTaskConcurrency`（准入）。

关键文件（**MIT，可合法抄代码**）：
- `src/hooks/task-session-manager/{event-router,index,idle-reconciliation,runtime-status-reconciliation}.ts`
- `src/utils/background-job-{terminal-gate,board,supervisor,persistence}.ts`
- `src/utils/background-task-concurrency.ts`、`src/admission-runtime.ts`
- `src/tools/task-{status,revive}.ts`
- `docs/background-orchestration.md`（932 行）

**它的负面事实（重要）**：**台账不落盘**，全是进程内 `Map`；
**跨重启不存活**（文档原话 *"do not survive process restarts"*）。
只有墓碑与删除纪元持久化（v2 `ctx.storage`，键 `omo/bgj/tombstone/<taskID>` /
`omo/bgj/epoch/<taskID>`，≤500 条；**别名不持久化**）。
→ **真正的"跨重启续跑"没有现成实现可抄，要自己设计**（但 (b) 档的做法已在上表给出）。

**许可**：MIT，标准文本，`Copyright (c) 2025`，**`src/**` 下无任何 per-file 版权头**——
抄代码只需带上顶层 `LICENSE` 与声明。

> **⚠️ 勘误（2026-10-19）**：omo-slim 的惰性对账 `rehydrateHistoricalRunningTasks`
> 挂在 v1 钩子 `experimental.chat.messages.transform` 上——**v2 里不存在这个钩子名**。
> v2 需改用 `ctx.session.hook("context", cb)` 或 `ctx.session.hook("prompt", cb)`
> 作为"父会话下一次活动"的触发点，**选哪个必须先实测**。
> 出处：[research/opencode-v2-plugin-api.md](research/opencode-v2-plugin-api.md) §4.3 与 §12.3。
>
> **另注**：`src/` 与 `docs/background-orchestration.md` **在本机磁盘上还没有**
> ——动手前先取下来（v3.0.5），并把上游 `LICENSE` 复制到 `licenses/oh-my-opencode-slim.LICENSE`。

---

## 7. 审查层（吸收 OCR，不装工具）

### 7.1 为什么是"吸收"而不是"安装"

**决定：把 OCR 的能力吸收进一个专职 reviewer subagent，不把 OCR 当外部工具装。**

理由：

1. **硬门禁**：OCR 要 `git >= 2.41`（`internal/gitcmd/version.go` 的 `gitVersionMin`，
   启动时 `exec git --version` 检查），**EL7 自带 1.8.3**——不升级 git 它根本起不来

> **⚠️ 勘误（2026-10-19）**：EL7 上的 git 实测是 **2.43.0**（EPEL），**不是 1.8.3** →
> **这条硬门禁其实是满足的**。但另外四条理由仍然成立，**"不装 OCR"的决定不变**。
> 见 §12 环境类的勘误与 [PLAN.md](PLAN.md) §6。
2. **npm 包装器会联网自更新**（每次运行后台查 registry 并自动升级）
3. **规则有 Java 企业栈倾向**（MyBatis/Maven/FreeMarker/NPE/线程安全），在自有代码上误报风险高
4. **它只审 diff，不审计划** —— 而第 3 阶段的计划评审本来就得靠 prompt，两阶段都用 prompt 反而一致
5. **"多轮次多角度"是评审纪律**，而纪律是 prompt 的事（见 §5.5(a)）

### 7.2 该吸收的具体内容（Apache-2.0，可合法抄）

- **规则文档**（`internal/config/rules/rule_docs/`，60+ 语言/格式的 markdown rubric，
  默认五维：正确性 / 安全 / 性能 / 可维护性 / 测试覆盖）——**这是它真正的 IP**，
  形式就是 markdown，直接进 agent 的 skills
- **结构化输出契约**：每条评论**必填**
  `severity ∈ {critical,high,medium,low}` 与
  `category ∈ {bug,security,performance,maintainability,test,style,documentation,other}`，
  外加 `path` / 行号 / `existing_code`（锚点片段）/ `suggestion_code`。
  **必填字段迫使评审给出可定位的结论**，这是"证据而非自述"的一部分
- **多轮设计**：后续轮把已确认的发现作为 `{{confirmed_comments}}` 注入，
  且**撤掉计划**——原文理由：
  *"a plan tends to act as a coverage ceiling once the obvious issues are found."*
- **误报过滤**：一轮专门的 `REVIEW_FILTER_TASK` 删掉可证明错误的评论
- **规则四层优先级**（若将来装工具）：`--rule` → `<repo>/.opencodereview/rule.json` →
  `~/.opencodereview/rule.json` → 内置；`"merge_system_rule": true` 可叠加而非替换

### 7.3 会失去什么（如实）

行号锚定的滑动窗口算法、按元数据的语义分组、token 预算管理、
以及 60+ 规则文档的**自动匹配**（改用 skill 让 agent 自己取用）。

**这些在"每天数千 PR"的量级才成为必需**，在"orchestrator 审一次改动"的量级可以接受。

### 7.4 升级路径（留着）

若 subagent 的评审实测**噪声大或定位不准**，**再**把 OCR 作为第二道门禁装上
（此时才值得解决 EL7 的 git 版本）。

### 7.5 项目参考信息

`alibaba/open-code-review`（品牌 OpenCodeReview，CLI `ocr`）：47,590★ / **Apache-2.0** / Go /
v1.13.1（2026-10-17）/ 昨天仍在推。中文 README 自述：
"它的前身是阿里集团内部官方 AI 代码审查助手，过去两年在内部服务了数万开发者"。
**它已有官方 opencode 插件，且是 V1/V2 双形态**（`plugins/open-code-review/opencode/open-code-review.ts`，
注册 `ocr_review`/`ocr_health` 工具与 `/ocr-review`/`/ocr-health` 命令）——
**这正是本仓库面临的 V2 注册问题，它已经解了，可作为参考。**

---

## 8. 形态与仓库

### 8.1 三件套，各司其职

| 件 | 形态 | 必需性 | 职责 |
|---|---|---|---|
| **编排插件** | **opencode plugin** | **必需** | 记账；**只有插件 API 能注册工具、拦 `subagent` 调用、订阅引擎事件** |
| **编排内容** | markdown agent 定义 + orchestrator prompt | **必需** | 四阶段流程与调度纪律 |
| **控制台** | **openchamber extension** | 可选 | 只读可视化子会话运行状态 + 配置编辑 |

**为什么控制台必须是 extension 而不是插件**：可视化要的是 openchamber 的会话树
（`listSessions()` + `parentId`，`ocrc` 的 `ocrc-omo-view` 扩展已验证可行）与面板渲染能力。
**为什么记账必须是插件**：extension 是沙箱 iframe，能力清单只有
`prompt/sessions/files/model/shells/network/origins/service/conversation`，
**碰不到引擎的工具管线**——既不能注册工具、也不能拦工具、也不能订阅引擎事件。

**两者同机**：实例级拓扑下，openchamber 实例与 opencode 引擎都在被控端，
extension 的 `service`（`runtime: "host"`）与插件在**同一台机器**上 →
**桥接可以是文件**（插件写台账 JSON，extension service 读），不必造网络协议。

### 8.2 单一写者铁律（必须守住）

| 面 | 所有者 | 另一方 |
|---|---|---|
| 配置（档位表、链、agent 名单） | **extension 写** | 插件**只读** |
| 台账（子任务状态） | **插件写** | extension **只读** |

**绝不互相写。** 反例：omo-slim 与 openchamber 抢 agent 配置
（openchamber#3881：面板保存 agent 写出盘上覆盖文件，按 omo-slim 自己的优先级
`opencode.json` 的 agent 条目是终局覆盖，**静默压掉预设**）——那就是双写者造成的。

### 8.3 边界（沿用 ocrc 的教训）

控制台是**只读查看器 + 配置编辑器**，**不做 controller**——控制面在模型侧（工具）。
加人工控制面板会造出第二个产品面，与 ocrc 当年删掉"上一代三块"是同一个教训。

### 8.4 仓库

**独立仓库**（使用者裁决）。**编排内容（agent 定义 + orchestrator prompt）必须一起搬进来**——
插件与 prompt 是一件事的两半（prompt 说"派活前先查台账"，插件才提供那个工具），
分在两个仓库会让每次改动都要跨仓同步。

建议内容物：插件 / agent 定义 + prompt / extension / 配置 schema / `LICENSE`（含外来内容的声明）。

---

## 9. 命名与派生

**REEVE**（使用者选定）。选它的理由：历史上 reeve 就是"**监督并管账的地方官**"
（shire reeve → sheriff），恰好是这个项目的定义——派工、管账、验活。
几乎无重名（`reeve` 作为机器标识很干净）。

**两条命名规矩**：

1. **不要用 omo 的名字，也不要继续用它的神祇**（`Sisyphus`/`Atlas`/`Prometheus`/`Metis`/`Momus`）。
   **法律上**：SUL-1.0 的商标条款是 *"Any use of the licensor's trademarks is subject to
   applicable law"* —— **没有商标授权**。**语义上**：叫它 omo 的什么，会把"fork"这个已否掉的
   框架请回来；而且继续用别人的品牌资产，每次解释都要说"这不是 omo"。
2. **给整件事起一个名，零件从它派生**（按 ocrc 的 AGENTS.md 立的规矩：品牌大写、
   机器标识小写、第二段是件类）。

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

**内部角色名一并换掉**（现在是 `Sisyphus - ultraworker` / `Sisyphus-Junior` /
`Momus - Plan Critic`，带 omo 的 display name）：
orchestrator → `foreman`（或 `lead`）；其余按职能命名
（`planner` / `critic` / `advisor` / `scout` / `librarian` / `executor`）。
**好处**：与 omo 配置彻底解耦，看日志不会再分不清"这是 omo 的 Sisyphus 还是我的"；
且职能名比神祇名更能约束模型行为。

---

## 10. 许可边界（决定"什么能进这个仓库"）

### 10.1 SUL-1.0 与 MIT 的分野

`oh-my-openagent` 的 `LICENSE.md` 经 diff 确认**就是 n8n 的 Sustainable Use License，
逐字照搬**（除引号形状；n8n 的两条 carve-out 被去掉，故本仓覆盖全部分支）。

| 允许 | 禁止 |
|---|---|
| fork / 修改 | 改许可、再授权（**non-sublicensable**） |
| 内部业务使用（含营利公司，royalty-free） | 收费分发 |
| 公开分发——**仅限免费且非商业** | 作为付费产品/服务提供 |
| — | 去掉版权/许可声明 |

**关键**：**无 Change Date、无到期转宽松**（区别于 Elastic License 2.0）。**限制永久。**
商标无授权。**→ omo 的代码与 prompt 字面不能进本仓库。**

### 10.2 许可矩阵

| 件 | 许可 | 借思路 | 抄代码 | 进本仓库 |
|---|---|---|---|---|
| omo | **SUL-1.0** | ✅ | ❌ | ❌ **永久不可** |
| **omo-slim** | **MIT** | ✅ | ✅ | ✅ |
| **OCR** | **Apache-2.0** | ✅ | ✅ | ✅ |
| **Bifrost** | Apache-2.0 | ✅ | ✅ | ✅ |
| openchamber | MIT | ✅ | ✅ | ✅ |

**实践规矩**：私有配置仓库内可自由抄 omo；**进本仓库的一律干净重写**
（以 omo 为参照，不逐字抄）。抄 MIT/Apache 内容必须带上其 `LICENSE` / `NOTICE`。

---

## 11. 实证数据：使用画像

数据源：`~/.local/share/opencode/opencode.db`（4.3 GB SQLite，`session_v2` + `session_message`）。
范围 2026-07-26 → 10-04，**678 个会话**。

- **35 个顶层 / 643 个子会话（95%）** —— 派发是主导模式
- **深度**：1 层 500、2 层 139、**3 层 4**（最大 3）
- **并发**：25 个父会话有生命周期重叠的子会话；峰值一个父会话 **约 88 个**；
  `~/.omo/run-continuation/` 有 **37,466 个**状态文件
- **agent 分布**：见 §5.3
- **成本**：$19.62 / 344.3M 输入 / 7.6M 输出
- **错误**：1,045 条 ERROR，明细见 §4.1

### 11.1 现有配置里已发现的两个真问题（迁移时顺手修）

1. **`deep` 是幽灵档位。** 使用者把内置 `deep` 改名成了 `deep-low`，
   但 omo 的 `mergeCategories` 是 `{...内置, ...用户}`——**改名不等于删除**，
   内置 `deep` 仍在，指向 `openai/gpt-5.6-sol` 且带 `requiresModel` 门禁。
   使用者的 provider 里没有该模型 → **orchestrator 一旦选中 `deep` 就报
   "Model not configured for category"**。其余七个内置档位都覆盖了，**只有 `deep` 漏了**。
2. **`deep-low` 与 `ultrabrain` 的模型链逐字相同**，无区分度（注释却写 "TIER1: ultrabrain / deep"）。

### 11.2 声明与实际的偏离

> **⚠️ 勘误（2026-10-19 实测，原表述不准确）**：原写"真正扛住 8–9 月负载的
> `wawapi-glm` / `xxyapi-glm` / `deepseek/deepseek-v4-flash` / `opencode/*-free`
> **都不在当前链里**"。实测 `D:\develop\OpenCodeConfig\.omo\omo.jsonc` 的 `categories`：
> **`xxyapi-deepseek/deepseek-v4.1-flash` 与 `opencode/mimo-v2.6-flash-free` 都在链里**
> （`quick` / `unspecified-high` / `explore` / `librarian` / `sisyphus-junior` 等）；
> **只有 `wawapi` 全仓零命中**。且文档里的模型名与配置里的实际名对不上
> （`xxyapi-glm` vs `xxyapi-deepseek/deepseek-v4.1-flash`）。
> → **代理层的链设计不能建立在这句话上**，要先跑一遍真实调用量统计（见 PLAN 步 4）。

- `lmuai/glm-5.3-flash` 在配置里**存在**（在 `quick` / `unspecified-high` / `sisyphus-junior` 等链里），
  但据实测**零调用**——"在链里"与"真在用"是两件事。
- **⚠️ 待确认**：原写"配置钉 `oh-my-openagent@5.0.0`，实际装的是 **4.19.4**"。
  现在配置**确实钉 5.0.0**，且 `OpenCodeConfig` 最新 commit 就是
  `upgrade omo plugin 4.19.4 -> 5.0.0`；但 `omo.jsonc` 头部注释仍写 "oh-my-openagent v4.19.3+"、
  fallback 注释仍解释 "OMO 4.19.4 读取废弃字段 `fallback_models`"。
  → **实际生效的是哪个版本需要确认**，它直接影响"回退不靠谱"该归因于版本错配还是 omo 设计。
- fallback 依赖**已废弃的 `fallback_models` 键**（配置注释自述"等上了修好的 beta 再删"）
  —— **这一条仍然成立**（`omo.jsonc` 里每个 agent/category 都同时写了 `models` 与内容相同的 `fallback_models`）。

### 11.3 使用者的机器与配置位置

- **被控端**：`demo@192.168.26.101`（V93000VM / RHEL 7.9 / glibc 2.17），**有外网**
- **配置仓库**：`D:\develop\OpenCodeConfig`（git 仓库，49 commits，2026-02-15 → 09-28，
  内容全是链重排/provider 换代/key 同步/插件版本 bump），symlink 进 Windows home，
  自述"三端同步：WSL / VMware VM / Windows 原生"
  - `.omo/omo.jsonc`（14 KB）、`.config/opencode/opencode.jsonc`
- **4 个 MCP**：`searxng`（`npx -y mcp-searxng`，内网 `192.168.96.11:8080`）、
  `playwright`（`npx -y @playwright/mcp@next --cdp-endpoint 127.0.0.1:9222`）、
  `tavily`（remote，URL 内嵌 key）、`codegraph`（本机二进制）
- **6 个 provider**：`xiaomi` / `deepseek` / `zhipuai-coding-plan` / `alibaba-cn`（内置）
  + `lmuai` / `xxyapi-deepseek`（自定义 OpenAI 兼容）
- **omo 侧设置**：`disabled_mcps: ["lsp"]`、`disabled_hooks: ["todo-continuation-enforcer", "start-work"]`、
  `background_task.defaultConcurrency: 5`、`hashline_edit: true`、`telemetry: false`

---

## 12. 硬约束与坑（清单）

**环境类**

- EL7 = RHEL 7.9 / **glibc 2.17** / Python 3.6 / **不保证 Docker**

> **⚠️ 勘误（2026-10-19 实测，EL7 上跑的）**：原写 "`git` 是 **1.8.3**"——**不准确**。
> 实测 `/usr/bin/git` 是 **2.43.0**，来自 **EPEL 的 `git-core-2.43.0-1.ep7.x86_64`**（2023-11 装的）。
> 系统自带的那个已被它替换（`/usr/bin/git` 只有一个）。
> **影响**：OCR 的 `git >= 2.41` 硬门禁**其实是满足的**——原先"EL7 起不来 OCR"这条理由**不成立**。
> 但"不装 OCR"的其余四条理由仍然成立（npm 包装器自更新、规则有 Java 企业栈倾向、
> 它只审 diff 不审计划、"多轮多角度"是 prompt 的事），**决定不变**。
> 详见 [PLAN.md](PLAN.md) §6 与 [PROGRESS.md](PROGRESS.md) 步 3.0。
- 可用的现代运行时：ocrc 给 openchamber 实例推的 **Node 24.22.0 glibc-217**
  （被控端装在 `~/.ocrc/remote/runtime/`；**开发机侧的缓存**在
  `~/.ocrc/bin-cache/remote-runtime/24.22.0/`，是 `.tar.xz` + `.sha256`，未解包）
- 本机（开发机）`opencode` 在 PATH 上是 **1.18.31（v1）**；**v2 没有全局装**——
  `@opencode/cli@2.0.32` 只作为依赖存在于 `D:\develop\ocrc-exp\node_modules\`（隔离栈用）

**opencode v2 类**

- 插件**拿不到会话列表**（§3.3）——这是记账插件所有设计的起点
- v2 发 `session.execution.*`；**`session.idle` 仍然发，但已标 `// deprecated`**（勘误，见 §6.1 注）
- **钩子真名**：`ctx.tool.hook("execute.before"|"execute.after", cb)`——**不是** v1 的
  `tool.execute.before`；工具注册走 `ctx.tool.transform(e => e.add({...}))`，且
  **必须带 `options: { namespace: "reeve", codemode: false }`**
  （`codemode: false` 才是"暴露给模型"的开关，`namespace` 只管命名）。详见施工图 §3.1
- **配置 JSON 里路径一律用正斜杠**——反斜杠是非法转义，会让**整份配置被静默丢弃**（施工图 §15）
- 键名：`agents`（复数）、`system`（非 `prompt`）、`permissions`（非 `permission`）、`steps`
- `experimental.subagent_depth` 默认 **1**（要 3 层得显式放开，且它在 `experimental` 下）
- **别名必须在 catalog 里可解析**，否则 `ModelUnavailableError`（#53060 的失败形态）
- **响应头被丢弃**（#26091）→ 实际服务者不可见，必须在代理侧记账

**许可类**

- **omo 的任何字面（代码/prompt）永久不可进本仓库**（§10）
- 抄 MIT/Apache 内容必须带 `LICENSE`/`NOTICE`

**设计类**

- **单一写者铁律**（§8.2）——双写者会静默压配置
- **验证者不能是执行者**，证据不可自述（§5.2）
- **嵌套的受管任务在并发闸门里必须豁免**，否则自死锁（§6.2⑤）
- **已发布的硬超时不可被迟到的完成替换**（§6.2④）
- **不要复活幽灵**：跨重启对账时，子会话不存在就墓碑 + 拆除（§6.2③）
- **最贵的 bug 是静默不一致**，不是崩溃（§6.3）

**协作类（来自 ocrc 的教训）**

- 控制台**不做 controller**（§8.3）
- 收窄产品面：ocrc 曾因"上一代三块"留下第二个产品面而整体删除

---

## 13. 未决项

| # | 未决 | 影响 | 怎么解 |
|---|---|---|---|
| 1 | 代理"半截流"（首 token 之后才失败）的行为 | 决定是否需要 `ttft_timeout_ms` 之外的手段 | 桩服务发一半就断，看 opencode 是否把截断流当成功 |
| 2 | 是否需要 `free-only` 档（策略性隔离） | 决定 3 档还是 4 档 | 使用者确认：有没有"永远不许溢出到付费配额"的活 |
| 3 | 是否需要 `long`（长上下文）档 | 决定第 4 个能力档 | 使用者确认：有没有超长上下文场景 |
| 4 | Bifrost 静态二进制在 EL7 上真能起 | 决定部署路径 | 一次 smoke test（`./bifrost-http -port 8080` 后 `/v1/models` 有响应） |
| 5 | 审查 subagent 的误报率 | 决定 severity 何时升级为门禁、要不要装 OCR | 跑两周统计 |
| 6 | 档位/链的最终形态 | — | 由 §4.7 判据 + #2/#3 决定 |

**已解决**（别重复调查）：opencode 忽略响应模型名（§4.4，实验 + 源码双重佐证）；
omo-slim 台账跨重启不存活（§6.4）；omo 上游拒绝移植（§1.2）。

---

## 14. 引用索引

**omo（`code-yeongyu/oh-my-openagent`）**
- issue #9389（拒绝移植，含维护者原话）/ #10374（暂停移植线）/ #10439（v2 支持=加载+广告）/
  #8485（加载失败，Workaround: None）/ #8295 / #9241 / #6169
- PR #9016 / #9094 / #8768 / #8626 / #8297（全部 CONFLICTING 或 BLOCKED）
- 源码（v4.19.4 `dist/index.js`，5.7 MB / 178k 行，未压缩）：
  `resolveSisyphusPromptFamily`(156511)、`buildDynamicSisyphusPrompt`(153105)、
  `buildParallelDelegationSection`(152010)、`resolveCategoryExecution`(132503)、
  `resolveCategoryConfig`(132331)、`MOMUS_DEFAULT_PROMPT`(158123)、
  `agentSources`(161447)、`createConfigHandler`(163213)
- `LICENSE.md`（= n8n SUL-1.0，逐字）

**opencode（`anomalyco/opencode`，v2 在 `dev`）**
- docs：`/v2/docs/{agents,models,tools,permissions,migrate-v1}`，`models.mdx` §Aliases
- 源码：`packages/core/src/tool/plugin/subagent.ts`、
  `packages/core/src/session/subagent-completion.ts`、
  `packages/core/src/session/runner/model.ts`、`packages/core/src/session/projector.ts`、
  `packages/schema/src/agent.ts`、`packages/ai/src/protocols/openai-chat.ts`
- issue：#38543（★本主题的正主，`not_planned` 关闭）/ #53060（相邻，未修）/ #26091（响应头丢弃，
  评论点名 Bifrost）/ #56124（LiteLLM 工具调用）/ #7602 / #55008 / #48991
- PR #26292（关闭，理由"routing through LiteLLM degrades tool-call quality"）

**omo-slim（`alvinunreal/oh-my-opencode-slim`，MIT，v3.0.5）**
- `docs/background-orchestration.md`（932 行）、`docs/configuration.md`、
  `docs/opencode-v2-compatibility.md`、`src/v2/mirror-conformance.ts`
- 实现：`src/hooks/task-session-manager/**`、`src/utils/background-job-*.ts`、
  `src/utils/background-task-concurrency.ts`、`src/tools/task-{status,revive}.ts`

**OCR（`alibaba/open-code-review`，Apache-2.0，v1.13.1）**
- `internal/gitcmd/version.go`（git ≥ 2.41 门禁）、`internal/config/rules/rule_docs/`、
  `plugins/open-code-review/opencode/open-code-review.ts`（V1/V2 双形态插件）

**Bifrost（`maximhq/bifrost`，Apache-2.0，v2.3.0）**
- `core/schemas/utils.go`（`ServedModel()`）、`docs/docs.json`（OSS/Enterprise tab 划分）、
  `plugins/routing/rules/engine.go`、`docs/providers/routing-rules.mdx`

**本项目的来源**
- `D:\develop\ocrc\docs\research\orchestration-stack-verdict.md`（本仓库已复制一份到
  `docs/research/`）
- ocrc 参照实现：`src/core/remote-instance.ts:331-348`（v2 门禁与引擎 pin）、
  `:496-519`（实例 serve 行，**未设 `OPENCODE_CONFIG_DIR`** → v2 实例与 v1 引擎共用用户配置，
  迁移前必须先解决配置目录隔离）
- 实验材料：`D:\develop\ocrc-exp\`（`stub.mjs` / `stub-log.jsonl` / 隔离 `home/`）

---

## 15. 执行协议（给从零开始的执行 agent）

### 15.1 你该怎么做

**顺序是固定的，不要跳**：

```
① 读 §0（背景/目的/术语）        —— 否则后面全是悬空引用
② 读 §15.2 的四件事，问使用者    —— 不问就会猜错
③ 读 PLAN.md（已重写）           —— 组件与所有权、实施顺序、每步硬门槛都在里面
④ 按 PLAN.md 的步 0→5 推进       —— 每步的"验收标准"是硬门槛，不过不进下一步
```

> **⚠️ 勘误（2026-10-19）**：旧版这里让先做 "PLAN.md 的 Phase 0"（修现有 omo 配置）。
> **Phase 0 已整体删除**——那是 v1+omo 的配置，整套正在被 reeve 替换，修它是给一个
> 正在被拆掉的系统做维护。PLAN.md 已重写为 **步 0→5**，从"把计划落成文档"开始。
> 与 v1 生产配置有关的动作**一概不做**。

**每完成一步**：跑该步的验收标准，**把结果写进 [`docs/PROGRESS.md`](PROGRESS.md)**，
格式 = `步 N / 检查项 / 结果 / 日期`。**没有记录的"完成"不算完成。**

### 15.2 ⚠️ 开工前必须问使用者的四件事（**不要猜**）

这四件事在 [PLAN.md](PLAN.md) §12 也有（那里编号是 1–6），
但**你必须在动手前就问**，否则会在步 2/3/4 猜错方向。

| # | 问题 | 阻塞 | 猜错的后果 |
|---|---|---|---|
| **1** | 有没有"**永远不许溢出到付费配额**"的活？ | **步 4** | 决定 3 档还是 4 档（多一个 `free-only`）；猜错则链的设计整体返工 |
| **2** | 有没有**超长上下文**场景？ | **步 4** | 决定要不要第 4 个能力档 `long` |
| **3** | 审查的 **severity 到哪一档就卡流程**？ | 步 3 | 猜错会导致误报挡路或漏报 |
| **4** | **插件包名与扩展目录**最终确认（当前按 `@bd7pil/reeve` / `extensions/reeve`） | 步 2 | 改名的迁移成本 |

> **⚠️ 勘误（2026-10-19）**：原表把阻塞项写成 "Phase 1/3/4"。PLAN 已重写为**步 0→5**，
> 对应关系是 **Phase 1→步 4（代理层）**、**Phase 3→步 2（记账插件）**、**Phase 4→步 3（审查层）**。
> 另：**部署是否归 ocrc** 与 **4 个原生 provider 的 endpoint** 也是步 4 的阻塞项（PLAN §12 #3/#4）。

**问题 3 的建议答案**（可以直接提给使用者）：**一开始都不卡流程**，
跑两周统计误报率再定——OCR 的规则有 Java 企业栈倾向，直接当门禁可能在自有代码上天天误报。

**问题 1/2 的建议答案**：**先按 3 档做**（`flash` / `pro` / `multimodal`），
把 `free` 当"链的顺序"而不是档位；`long` 档等真遇到超长上下文再加。
**但这只是建议——必须由使用者确认。**

### 15.3 最小必读集（只读这些就能开工）

| 你要做的事 | 必读 | 关键词 |
|---|---|---|
| 开始（任何事之前） | §0、§15、**PLAN.md** | 背景 / 术语 / 组件与所有权 |
| 步 1（写 prompt） | **§5 全节**、§5.5（omo 的反面教材）、§5.6（可借鉴的三段） | 四阶段 / 证据不自述 |
| 步 2（写插件） | **§3.3**（一切设计的起点）、§6 全节、§6.4（可抄的 MIT 实现）、**`research/opencode-v2-plugin-api.md`（施工图，先读）** | 拿不到会话列表 / v2 钩子真名 |
| 步 3（审查） | §7 全节 | 吸收规则，不装工具 |
| 步 4（代理） | **§4.4**（已实测的前提）、§4.7（3 档）、§4.6（坑）、**PLAN §5**（进程/配置/接入） | 别名 / TTFT / 纯透传 / served_model |
| 步 5（控制台） | §8.1（三件套）、§8.2（单一写者铁律）、§8.3（边界） | 同机 / 文件桥 |
| 卡住了 | §12（硬约束与坑清单）、§13（未决项） | — |

> **⚠️ 勘误**：旧表里的 "Phase 0（修配置）" 一行**已删**（Phase 0 整体删除，见 §15.1）。

### 15.4 停下来问人的条件（不要自行决定）

遇到下列任一情况，**停下并问使用者**，不要"合理推测"：

1. **§15.2 的四件事**（它们本来就该问）
2. **任何涉及花钱的决定**——档位链的付费部分、`free-only` 的取舍
3. **任何涉及 EL7 生产环境的写操作**（改配置、装东西）——
   使用者有"生产引擎零测试流量"的规矩，测试一律走隔离栈
4. **发现文档与事实冲突时**——不要按文档硬做，先报冲突
5. **要引入任何外来代码或 prompt 时**——先核对 §10 许可边界，SUL-1.0 的内容永久禁止

### 15.5 硬禁止（跨过就是事故）

| 禁止 | 为什么 | 出处 |
|---|---|---|
| 引入 omo 的任何代码或 prompt 字面 | SUL-1.0，不可再授权、永久、商标无授权 | §10 |
| 插件写 `agents.*.model` | 会与 openchamber 抢配置，**静默压掉预设** | §8.2 / openchamber#3881 |
| 控制台做成 controller（能控制模型侧） | 会造出第二个产品面（ocrc 曾因此整体删除一代功能） | §8.3 |
| 在并发闸门里不豁免嵌套受管任务 | **自死锁** | §6.2⑤ |
| 让"迟到的完成"覆盖已发布的硬超时 | 账目不可信 | §6.2④ |
| 跨重启对账时复活已删除的子会话 | 留下**永远在跑的幽灵** | §6.2③ |
| 接受 subagent 自述的完成证据 | 使用者明确说"agent 会欺上瞒下" | §5.2 |
| 在**首 token 之前**不做回退决定 | 客户端会把截断的流当成功 | §4.4 残留项 |
| 对生产引擎（EL7 :4096）发测试流量 | 使用者的铁律 | §12 |

### 15.6 一句话

**先问四件事，再按 [PLAN.md](PLAN.md) 的步 0→5 一步一步过，每步过验收标准才进下一步；
每一处不确定都标成"问人"而不是猜；跨过 §15.5 任一红线就是事故。**
（**Phase 0 已删除**——见 §15.1 的勘误。）
