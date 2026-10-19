# REEVE 完整开发方案

## 一、目标

**REEVE = opencode v2 上的自有编排层**，管三件事：**派工**（把活派给专家 agent）、
**管账**（自持子任务台账，知道谁在跑谁死了）、**验活**（不接受 subagent 自述，亲自拿产物验收）。

不是 omo 的 fork，是重新拥有这三件事。**本体 = 2 件必需 + 1 件可选**：

| 件 | 形态 | 必需 | 进程归属 |
|---|---|---|---|
| **编排内容** | markdown（agent 定义 + prompt） | ✅ | 无进程（引擎加载） |
| **记账插件** | opencode v2 plugin（`@bd7pil/reeve`） | ✅ | 引擎进程内 |
| **控制台** | openchamber extension | ⭕ | openchamber 实例的 `service` |
| 代理层 | Bifrost（**第三方二进制**，不是我们开发） | 独立件 | **ocrc 持有** |
| 审查层 | `reviewer` agent + `skills/`（**不单独成件**，落在编排内容里） | ✅ | 无进程 |

**单一写者铁律**：配置（档位表/链/agent 名单）只有控制台写、插件只读；台账只有插件写、控制台只读。
**插件绝不写 `agents.*.model`**（反例：openchamber#3881 面板保存 agent 静默压掉预设）。

---

## 二、现状（已完成）

| 步 | 状态 | 产出 |
|---|---|---|
| **步 0** | ✅ | `docs/PLAN.md` 重写；`docs/research/opencode-v2-plugin-api.md` 新建；`HANDOFF.md` 勘误 11 处；`PROGRESS.md`；README |
| **步 1.0** | ✅ | 实测确定 agent 落点与配置杠杆（结论见 §四） |
| **步 1.1** | ✅ | [agents/](D:\develop\reeve\agents) 8 个定义落盘，隔离栈验证加载通过（15 个 agent 无报错） |
| 步 1.2 | ⏳ | 命名空间改名 + 行为验收 |

---

## 三、命名契约（本轮改定）

**档位命名空间 = `reeve/`**（不再是 `router/`）。

**为什么**：软件上 Bifrost 是第三方、独立；但**集成上它不独立**——进程由 ocrc 持有、
配置源真相在 reeve 仓库、控制台是唯一运行时写者、插件只读。别名是**我们的命名空间**，
应当带自己的品牌；而且这样 agent 定义对实现中立——**以后换掉 Bifrost，`reeve/flash` 不用改**。

**机制（已核实，v2.0.32）**：用原生 `modelID` 别名，让 **ref 与线上名一致**：

```jsonc
"provider": { "reeve": { "models": {
  "flash":      { "modelID": "reeve/flash" },
  "pro":        { "modelID": "reeve/pro" },
  "multimodal": { "modelID": "reeve/multimodal" }
}}}
```
证据：`packages/schema/src/config/provider.ts` 的 `Model.modelID`；
`packages/core/src/model-resolver.ts:234` 的 `module.model(resolved.modelID ?? resolved.id, ...)`；
`packages/core/test/model-resolver.test.ts:263` 断言其语义；v1 迁移 `migrateModel()` 把线上名映射到 `modelID`。
（**文档没写这个字段**——我先前"不需要原生 Aliases"的判断是错的，已更正。）

→ agent 写 `model: reeve/flash`；Bifrost 的 CEL 写 `model == "reeve/flash"`；**零映射层**。

**改名范围**：`agents/*.md`（8）、`docs/PLAN.md`、`docs/PROGRESS.md`、施工图、HANDOFF 的**前瞻规格**段
（§0.4 术语表 / §4.6 CEL 示例 / §4.7）。
**不改**：HANDOFF §4.4 与 verdict §2.6/§8.3 的**实验记录**——那里 `router/flash` 是当时真实用的模型 id，
改了就是伪造记录。

---

## 四、已实测的 v2 契约（施工图 [opencode-v2-plugin-api.md](D:\develop\reeve\docs\research\opencode-v2-plugin-api.md)）

写代码时**一律以此为准**，不要照 HANDOFF §6.1 的旧写法。

| 项 | 结论 |
|---|---|
| 插件入口 | `export default { id, setup(ctx) }`，`setup` 返回 cleanup；**具名导出不被加载** |
| 拦工具 | `ctx.tool.hook("execute.before"\|"execute.after", cb)`——**不是** v1 的 `tool.execute.before`；`before` 可改 `input`、可返回 `Tool.Error` 阻断 |
| 注册工具 | `ctx.tool.transform(e => e.add({ name, description, input, output, options, execute }))`；**必须带 `options.namespace`**，否则模型看不见 |
| 会话域 | `Pick` 含 `create/get/remove/switchAgent/switchModel/prompt/generate/command/compact/synthetic/interrupt/update/move/wait/context`——**无 `list`/`children`/`status`/`todo`** |
| 中断 | `ctx.session.interrupt({ sessionID, resume: false })` |
| 事件 | `ctx.event.subscribe()`；认 `session.execution.started/succeeded/failed/interrupted`；**`session.idle` 仍发但已 deprecated** |
| 存储 | `ctx.storage` 的 `get/set/remove/scan`，宿主自动加 `plugin.<id>.` 前缀 |
| subagent 输出 | **结构化** `{ sessionID, status: "completed"\|"running", output }` |
| agent 定义 | 配置 `agents` 键 **或** markdown（`agent/` 与 `agents/` 两个目录都被扫）；**markdown 正文即 `system`** |
| permissions | 与默认规则集**合并**（不是替换）；默认含 `*.env → ask`、`browser → deny` |
| 配置目录杠杆 | **`HOME`**；`OPENCODE_CONFIG_DIR` ❌、`XDG_CONFIG_HOME` ❌（Windows 实测；**EL7 待验**） |
| 后台 service | 常驻并**钉住环境**；改环境后必须 `service stop`，且 **stop 后首次调用返回空**，要预热 |

---

## 五、分步实施

### 步 1 — 编排层（文本，零代码）

**1a 改名**：按 §三 把 `router/` 改成 `reeve/`（agents + 前瞻规格文档）。
**1b 行为验收**：需要真实模型。

**产出**：`agents/*.md` 8 个（已落盘，改名后即完成）

**验收**
| 检查 | 标准 |
|---|---|
| 加载 | `debug agents` 列出 8 个，ref 为 `reeve/pro` / `reeve/flash`，无 schema 报错 |
| 线上名 | 桩日志里 `requestModel` 是 **`reeve/flash`**（不是 `flash`、不是 `reeve/router/flash`） |
| grill 先于动手 | 给模糊需求 → 先提问，不直接改文件 |
| 文档是接口 | 给多步任务 → 先出自包含文档，再派活 |
| 权限闸门 | `critic` / `advisor` 尝试 edit/shell 被拒 |
| 验收独立性 | subagent 自称完成 → `foreman` **自己**读产物，不引用其结论 |
| 多轮评审 | 有明显缺陷的计划被驳 **≥2 轮**，每轮维度不同 |
| 无 omo 字面 | 全仓 grep 无神祇名与 omo prompt 片段 |

⚠️ **1b 需要真实模型**——涉及花钱（§15.4 #2）。**待你定：用免费档在隔离栈跑，还是你在 EL7 上跑。**

### 步 2 — 记账插件 `@bd7pil/reeve`（唯一代码阶段）

**前置**：步 1。**施工图**：§四 那张表。

**五处挂载点**
| # | 挂载点 | 形态 |
|---|---|---|
| ① | 拦 `subagent`（**并发闸门，子会话创建之前**） | `ctx.tool.hook("execute.before", cb)` |
| ② | 落台账 | `ctx.tool.hook("execute.after", cb)` → 解析结构化 `sessionID` |
| ③ | 认终态 | `ctx.event.subscribe()` 认 `session.execution.*` → 标终态、撤计时器 |
| ④ | 墙钟 | 一次性定时器 → 到期先武装宽限 → **恰好一次** `ctx.session.interrupt({sessionID, resume:false})` |
| ⑤ | 落盘 + 对账 | `ctx.storage` |

**注册工具**：`reeve_task_status`（只读，**必须带 `options.namespace: "reeve"`**）。

**四条核心设计**
- **静默死亡**：`session.idle` 只是**候选**；转录判 `absent` **且**静默超宽限（`STOP_CONFIRMATION_GRACE_MS = 5_000`）才落 `stopped`。否则**每个正常完成的子任务都会被误报成死亡**。无法证明为终态的一律保持 `running` + `statusUncertain`，排一次重试（默认 3 次）。
- **并发**：**模型上限 > provider 上限 > 默认上限**，`0`/缺省 = 无限。**嵌套受管任务必须豁免**（否则**自死锁**）；调度器按目录进程级共享，插件重载后保留槽位与排队票。
- **墙钟**：只监督 `background === true`；只对新 `generation` 重新武装；忙碌/活动**都不续期**。**已发布的硬超时不可被迟到的完成替换。**
- **跨重启对账**（**唯一没有参照实现可抄的一块**）：**惰性**——父会话**下一次活动时**才扫。从父转录重建在飞任务 → 逐个探活 → 判定表：

| 探测结果 | 处置 |
|---|---|
| 子会话不存在（`NotFoundError`） | 墓碑 + 拆除（**不复活成幽灵**） |
| 有终态 outcome | 落真实终态（`interrupted`→`stopped`，`failed`→`error`，`succeeded`→`completed`） |
| 存在但空闲/无输出 | 停止候选 → 宽限后 `stopped, unreconciled` |
| 其他错误 | fail-open，保持登记 |

不主动重新派发（会重复副作用）；恢复是 best-effort，别名与终态结果**不恢复**。

**可抄的 MIT 参照**（`oh-my-opencode-slim` v3.0.5，**磁盘上没有，先取下来**，带其 `LICENSE`）：
`src/hooks/task-session-manager/{event-router,index,idle-reconciliation,runtime-status-reconciliation}.ts`、
`src/utils/background-job-{terminal-gate,board,supervisor,persistence}.ts`、
`src/utils/background-task-concurrency.ts`、`src/admission-runtime.ts`、`src/tools/task-{status,revive}.ts`、
`docs/background-orchestration.md`（932 行，先读）。
**它的负面事实**：台账不落盘（进程内 `Map`）→ 跨重启那块必须自己设计。

**体量**：约 500 行。**最贵的 bug 不是崩溃，是静默不一致。**
**落点**：`plugin/`、`licenses/oh-my-opencode-slim.LICENSE`

**验收**
| 检查 | 标准 |
|---|---|
| 在飞可查 | `reeve_task_status` 返回 running 列表 |
| 静默死亡 | kill 子会话 → 父 agent 收到"已停止且无终态结果" |
| **无假警报** | **正常完成的子任务不产生任何误报**（回归测试） |
| 墙钟 | 卡死的到期被中断且通知父 agent |
| 并发 | 超限**排队而非失败**；**嵌套任务不自死锁** |
| 超时不可逆 | 迟到的"完成"不能覆盖已发布的超时 |
| 跨重启 | 重启后**如实标未知**；已删除的子会话 → 墓碑 + 拆除，不留幽灵 |
| 零冲突 | 插件加载后面板 Agents 页保存无冲突、无静默覆盖 |

**开工前必须先实测的两个未决项**：惰性对账挂 `ctx.session.hook("context")` 还是 `"prompt"`；
`options.namespace` 之外是否还需别的开关才进模型工具表。

### 步 3 — 审查层（文本，零代码）

**决定：不装 OCR 工具，把能力吸收进 `reviewer` subagent。**
理由：① OCR 要 `git >= 2.41`，EL7 自带 1.8.3；② npm 包装器联网自更新；
③ 规则有 Java 企业栈倾向；④ 它只审 diff 不审计划；⑤"多轮多角度"是 prompt 的事。

**吸收四样**（Apache-2.0，带 `LICENSE`/`NOTICE`）：
规则文档（`internal/config/rules/rule_docs/` 的 markdown rubric，五维：正确性/安全/性能/可维护性/测试覆盖）→ `skills/review/`；
结构化输出契约（`severity`/`category` **必填** + `path`/行号/`existing_code` 锚点片段/`suggestion_code`）；
多轮注入 `{{confirmed_comments}}` **且撤掉计划**；一轮专门的误报过滤。

**门禁**：一开始**都不卡流程**，跑两周统计误报率再定。**升级路径**：噪声大再装 OCR 当第二道门禁。
**落点**：`agents/reviewer.md`（已有）、`skills/review/*.md`、`licenses/open-code-review.LICENSE`、更新 `NOTICE.md`

**验收**：故意塞一个有 bug 的 diff → 被抓到、**带行号**、输出合结构化契约。

### 步 4 — 代理层（配置 + ocrc 改动）

**拓扑**：`引擎 ──HTTP 回环──▶ Bifrost(127.0.0.1:8080) ──▶ 真实 provider`

**进程谁持有 → ocrc**（它已有版本 pin 的 bin-cache，而 Bifrost 不在 GitHub Releases，正需要这套；
它也有唯一启动入口 `buildInstanceServeCommand`）。**不能由插件持有**。

**谁配置 → 源真相在 reeve 仓库 `proxy/config.json`**；ocrc **只推送**；控制台是唯一运行时写者；插件只读。
API key 走 `env.<VAR>`，由 ocrc 启动行注入。

**接入两端**
- **opencode 侧**：自定义 OpenAI 兼容 provider，`baseURL` → Bifrost，按 §三 用 `modelID`
- **Bifrost 侧**：`providers` 全写成 OpenAI 兼容自定义 provider；`governance.routing_rules` 三条，
  `cel_expression: model == "reeve/<档>"`，`targets[0]` + `fallbacks[]`（`"provider/model"`；`"provider/"` = 同模型换 provider），`weight` 合计为 1
- **坑**：CEL 变量是 `model`（**不是 `request.model`**，官方示例是错的）；改 `config.json` **要重启**，热改走 `POST /api/routing/rules`

**三条边界**
1. **只做 OpenAI 兼容端点之间的纯透传，不做格式翻译**（PR #26292 反向证据 + #56124 实锤）。代价：4 个原生 provider 要改写——**其 endpoint 是缺的输入**
2. **半截流**：回退必须在**首 token 之前**决定 → `ttft_timeout_ms`（官方文档层级自相矛盾，**实测定**）
3. **opencode 永远看不到"谁真的服务了这次请求"** → 归因必须在代理侧记（`served_model` 落 `logs.db` + `/api/logs`）

**落点**：`proxy/{config.json,README.md}`、`scripts/served-model.sh`

**验收**：坏 key 链头 → 第二个接上且请求成功 / 同一会话多轮 Bifrost 始终收到 `reeve/<档>` /
**半截流不被当成成功** / 能回答"这 196 次 quota 错误分别是哪个 provider 撞的"

### 步 5 — 控制台（可选）

openchamber extension，`extensions/reeve`，`panel.id = reeve`。**只读可视化 + 配置编辑器，不做 controller**。
参照 ocrc 的 `extensions/ocrc-omo-view`（`listProjects` → `listSessions` + `onSessions`，`parentId` 建树；
声明式注册）。**桥是同机文件桥**（插件写台账 JSON，extension service 读）。
**为什么必须与插件分开**：可视化要会话树（只有 extension 拿得到）；记账要引擎工具管线（只有插件拿得到）。

**验收**：面板能看到子任务状态与台账；保存配置后插件正确读到；**无任何双写冲突**。

---

## 六、前置与阻塞

| # | 事项 | 阻塞 | 归属 |
|---|---|---|---|
| 1 | **许可门禁**：仓库过不了 `NOTICE.md` 自己规定的提交门禁（HANDOFF 12 处品牌名 + 3 处 omo prompt 逐字引用；归档 8 + 4 处） | **commit** | **待你裁决**（三方案见 PROGRESS 阻塞项 #1） |
| 2 | **4 个原生 provider 的 OpenAI 兼容 endpoint**（`xiaomi`/`deepseek`/`zhipuai-coding-plan`/`alibaba-cn`） | 步 4 | 待你给 |
| 3 | **配置目录隔离的杠杆**：Windows 上是 `HOME`；`OPENCODE_CONFIG_DIR` 已证伪 | **EL7 部署** | ocrc（**EL7 上先验证**） |
| 4 | **行为验收用哪个模型**（涉及花钱） | 步 1b / 步 2 | 待你定 |
| 5 | 部署是否归 ocrc（它刚被裁到只剩一条路） | 步 4 | 待你定 |
| 6 | 3 档还是 4–5 档（`free-only` / `long`） | 步 4 | 待你定（建议先 3 档） |

**EL7 权限**：默认**我不碰 EL7**；开发与验证全在开发机隔离栈（`D:\develop\ocrc-exp`，`opencode v2.0.32` 已跑通）。

---

## 七、明确不做

修 v1+omo 配置（Phase 0 已整体删除）· 引入 omo 任何代码或 prompt 字面（SUL-1.0 永久禁止）·
控制台做成 controller · 插件写 `agents.*.model` · 并发闸门不豁免嵌套受管任务（自死锁）·
让迟到的完成覆盖已发布的硬超时 · 跨重启复活已删除的子会话 · 对生产引擎发测试流量
