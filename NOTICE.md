# Third-party notices

REEVE 计划引入两处外来内容。**两者都必须在被引入时带上其原始许可文本**，
且只允许引入下面这两类——**`oh-my-openagent` 的任何代码或 prompt 字面永久不可引入**（SUL-1.0）。

## 1. `oh-my-opencode-slim` — MIT

- 上游：https://github.com/alvinunreal/oh-my-opencode-slim
- 许可：MIT（`LICENSE`，标准文本，`Copyright (c) 2025`；`src/**` 下无 per-file 版权头）
- **计划引入**：记账层的实现参照——终态判定门（含 5 秒静默宽限）、墙钟监督器、
  准入队列（含"嵌套受管任务豁免"）、惰性重启对账（`rehydrateHistoricalRunningTasks`）
- **行动**：引入时把上游 `LICENSE` 原文复制到 `licenses/oh-my-opencode-slim.LICENSE`

### ✅ 已引入（2026-10-19）

`licenses/oh-my-opencode-slim.LICENSE` 已复制（取自上游 tag **v3.0.5**，1056 bytes）。

**被参照的具体文件清单**（上游 v3.0.5；已拉取到**仓库外**的参照区（不随本仓库发布），
**未 vendor 进本仓库**）：

| 上游路径 | 用途 |
|---|---|
| `LICENSE` | 许可原文（已复制进 `licenses/`） |
| `docs/background-orchestration.md` | 背景编排设计说明（932 行） |
| `src/hooks/task-session-manager/{event-router,index,idle-reconciliation,runtime-status-reconciliation}.ts` | 事件路由与对账 |
| `src/utils/background-job-{terminal-gate,board,supervisor,persistence}.ts` | 终态门 / 状态板 / 墙钟 / 持久化 |
| `src/utils/background-task-concurrency.ts`、`src/admission-runtime.ts` | 准入队列与进程级共享 |
| `src/tools/task-{status,revive}.ts` | 工具面 |

**本仓库如何使用**：**参照算法、重写实现**。REEVE 的 `plugin/src/` 是按 opencode **v2** 的
插件 API 重写的（上游是 **v1** 插件，用 `'tool.execute.before'` /
`'experimental.chat.messages.transform'` 等 v1 钩子名，直接照抄**一个钩子都不会触发**）。
REEVE 的实现参照了：终态判定门与静默宽限、墙钟监督器的一次性定时器与生成守卫、
准入队列的档位解析与嵌套豁免、按目录进程级共享。

**未引入**：上游的 orchestrator prompt 与 agent 阵容（那正是本项目要自己拥有的东西）。

## 2. `alibaba/open-code-review` — Apache-2.0

- 上游：https://github.com/alibaba/open-code-review
- 许可：Apache-2.0（`Copyright 2026 Alibaba`）
- **计划引入**：审查层的**规则文档**（`internal/config/rules/rule_docs/` 下的 markdown rubric，
  如 `go.md` / `python.md` / `default.md`）+ 结构化输出契约（severity/category 枚举）
- **行动**：引入时复制上游 `LICENSE` 到 `licenses/open-code-review.LICENSE`，
  并在本文件列出被引入的具体文件清单

### ✅ 已引入（2026-10-19）

`licenses/open-code-review.LICENSE` 已复制（Apache-2.0，11356 bytes，取自 tag **v1.13.1**）。

**被引入的具体文件清单**（原样副本，放在 `skills/review/`）：

| 上游路径（`internal/config/rules/rule_docs/`） | 本仓库 |
|---|---|
| `default.md` | `skills/review/default.md`（五维总纲） |
| `ts_js_tsx_jsx.md` | `skills/review/ts_js_tsx_jsx.md` |
| `python.md` | `skills/review/python.md` |
| `go.md` | `skills/review/go.md` |
| `yaml.md` | `skills/review/yaml.md` |
| `json.md` | `skills/review/json.md` |
| `package_json.md` | `skills/review/package_json.md` |

**自行撰写的**：`skills/review/SKILL.md`（五维的使用说明、rubric 选择表、输出契约、
多轮与误报过滤的做法、门禁策略）——**枚举取自**上游 `internal/model/review.go`
（`Category` / `Severity`），其余为自写。

**未引入**：OCR 的 Go 代码、CLI 二进制、npm 包装器。**不装工具，只吸收规则。**

## 3. `oh-my-openagent` — SUL-1.0 —— **禁止引入**

- 上游：https://github.com/code-yeongyu/oh-my-openagent
- 许可：SUL-1.0（= n8n 的 Sustainable Use License，逐字）
- **non-sublicensable、永久、无 Change Date**；商标无授权
- **只允许借思路，不允许抄字面**（代码与 prompt 文本均不可）

---

## 提交门禁（2026-10-19 修订）

**禁止**（SUL-1.0 的红线）：

```bash
# omo 的代码或 prompt 字面 —— 命中即事故
grep -rnE "APPROVAL BIAS|BLOCKER-finder|PERFECTIONIST|NOT AN IMPLEMENTER|OVER-DELEGATION|Force multiple revision cycles|80% clear" --include='*.md' --include='*.ts' --include='*.js' .
```

**允许**（不构成"引入"）：

1. **品牌名作为事实标识**——`Sisyphus` / `Momus` / `Atlas` / `Prometheus` / `Metis` 在
   **迁移叙事与实测数据**里出现（"现有配置里叫 X 的那个 agent""会话数统计"）。
   理由：这些是**标识符**，不是受保护的内容；抹掉它们会让文档不可用
   （无法指认"哪个配置项对应哪个角色"）。**但不得用于命名我们自己的东西**（见 HANDOFF §9）。
2. **对 omo 设计的转述**——用中文概括它的立场与行为，**不抄原文**。
3. **归档证据文档** `docs/research/orchestration-stack-verdict.md`——它是**当时调查的一手记录**，
   已加"不要按它施工"的横幅；其中的 omo prompt 引用**已改为转述**，需要原始字面时按它的引用索引去上游源码核对。

**理由**：SUL-1.0 约束的是**代码与 prompt 字面的再分发**，不是"不许提到这个名字"。
把品牌名一并禁掉会与"必须讲清迁移前因"的文档目标冲突，而且**会掩盖真正的风险**——
真正的风险是**逐字内容**，那条已经用上面第一条 grep 卡死。
