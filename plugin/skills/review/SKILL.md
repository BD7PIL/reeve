---
name: review
description: >
  代码审查的规则与输出契约。在审查代码 diff 时使用：五维 rubric（正确性 / 安全 / 性能 / 可维护性 /
  测试覆盖）、按语言选规则文档、结构化输出契约（severity 与 category 必填，外加 path、行号、
  existing_code 锚点片段、suggestion_code）、多轮评审时撤掉计划的做法、以及最后一轮的误报过滤。
  不用于审查实施计划（那是 critic 的活）。
description_en: >
  Code review rules and output contract: five-axis rubric (correctness, security, performance, maintainability, test coverage), per-language rule docs, structured output (severity, category, path, line, existing_code anchor, suggestion_code), dropping the plan during review rounds, and a final false-positive pass. Not for reviewing implementation plans (that is critic's job).
license: Apache-2.0
metadata:
  source: alibaba/open-code-review
  source-tag: v1.13.1
  rubrics: default.md ts_js_tsx_jsx.md python.md go.md yaml.md json.md package_json.md
---

# 审查层 —— 规则与输出契约

> **给 `reviewer` agent 用。** 审查对象是**代码 diff**（不是计划——那是 `critic` 的活）。
>
> **来源**：规则文档抄自 [`alibaba/open-code-review`](https://github.com/alibaba/open-code-review)
> （**Apache-2.0**，`Copyright 2026 Alibaba`，tag `v1.13.1`），见 `licenses/open-code-review.LICENSE`。
> **我们只吸收规则与契约，不装 OCR 工具**（理由见 [../../docs/PLAN.md](../../docs/PLAN.md) §6）。
>
> **为什么本文件叫 `SKILL.md`**：opencode v2 的 skill 发现规则是
> `scan("{*.md,**/SKILL.md}")`，且要求目录里有 **`SKILL.md`** 或 **`<目录名>.md`**。
> 叫 `README.md` 的话**不会被当成 skill**（只能靠 `read` 硬读文件）——实测踩过。

---

## 1. 五个维度（`default.md` 是总纲）

| 维度 | 要问的问题 |
|---|---|
| **正确性** | 逻辑对吗？边界条件漏了吗？异常处理了吗？并发下线程安全吗？ |
| **安全** | 有注入/XSS 之类的漏洞吗？敏感信息处理对吗？权限校验完整吗？ |
| **性能** | 有 N+1、无谓循环之类的问题吗？资源正确释放了吗？ |
| **可维护性** | 代码清楚吗？命名表达了意图吗？遵循项目既有的风格与架构模式吗？ |
| **测试覆盖** | 关键逻辑路径有测试吗？边界条件覆盖了吗？ |

## 2. 按语言取用

| 文件 | 用于 |
|---|---|
| `default.md` | **总纲，任何语言都先读它** |
| `ts_js_tsx_jsx.md` | TypeScript / JavaScript / TSX / JSX（REEVE 自己的代码） |
| `python.md` | Python |
| `go.md` | Go |
| `yaml.md` / `json.md` / `package_json.md` | 配置文件 |

**不在表里**：认不出语言就只用 `default.md` 的五维，**不要硬套别的语言的规则**。

## 3. 输出契约（每条评论**必填**）

| 字段 | 取值 / 说明 |
|---|---|
| `severity` | `critical` \| `high` \| `medium` \| `low` |
| `category` | `bug` \| `security` \| `performance` \| `maintainability` \| `test` \| `style` \| `documentation` \| `other` |
| `path` | 文件路径 |
| 行号 | 起始与结束 |
| `existing_code` | **锚点片段**（原文，用于定位） |
| `suggestion_code` | 建议改成什么 |

**必填字段是硬要求**——**说不出行号和锚点片段的结论，就不要写**。
这是"证据而非自述"的一部分：必填字段迫使评审给出**可定位**的结论。

**行号对不上怎么办**：**诚实标"未锚定"**，不要硬凑一个数字。
（OCR 的做法是标 `0` 表示 unanchored；我们照此。）

## 4. 多轮：后续轮要**撤掉计划**

后续轮次把**已经确认的发现**作为 `{{confirmed_comments}}` 注入，
**并且不再提供"计划"**。

> 原文理由（转述）：*计划在明显的问题被找到之后，会变成一个覆盖上限* ——
> 它会让人围着计划打转，而不再去找计划没覆盖到的地方。

**每一轮聚焦不同的维度**（正确性 / 安全 / 性能 / 可维护性 / 测试覆盖），
不要在轮内混着谈。

## 5. 误报过滤

最后单跑一轮**专门删掉"可以被证明是错的"评论**。
这一轮的任务不是找新问题，是**杀掉**已有的误报。
**并记录你删了什么、为什么删**——这本身就是"证据而非自述"的一部分。

## 6. 门禁策略

**一开始都不卡流程**（`critical` / `high` 也只报告、不阻塞）。

理由：这套规则有**Java 企业栈的指纹**（MyBatis / Maven / FreeMarker / NPE / 线程安全），
在自有代码上直接当门禁很可能天天误报。**跑两周统计误报率**，再决定把哪些 severity 升级成门禁。

**升级路径**：若评审实测**噪声大或定位不准**，**再**把 OCR 当第二道门禁装上
（那时才值得解决它 `git >= 2.41` 的硬门禁——被控端 EL7 自带 1.8.3）。

---

## 7. 我们会失去什么（如实）

不装 OCR 工具意味着失去：**行号锚定的滑动窗口算法**、按元数据的**语义分组**、
**token 预算管理**、以及 54 份规则文档的**自动匹配**（改用本目录让 agent 自己取用）。

这些在"每天数千 PR"的量级才成为必需；在"orchestrator 审一次改动"的量级可以接受。

---

## 8. 来源与许可

- 上游：`alibaba/open-code-review`（Apache-2.0，`Copyright 2026 Alibaba`），tag **v1.13.1**
- 本目录下其余 `.md` 是**上游 `internal/config/rules/rule_docs/` 的原样副本**
- 许可原文：[`licenses/open-code-review.LICENSE`](../../licenses/open-code-review.LICENSE)
- 结构化输出契约的枚举取自上游 `internal/model/review.go`
  （`Category`：bug / security / performance / maintainability / test / style / documentation / other；
  `Severity`：critical / high / medium / low）

**未引入**：OCR 的 Go 代码、它的 CLI 二进制、它的 npm 包装器。
**未引入** `oh-my-openagent`(omo) 的任何代码或 prompt 字面（SUL-1.0，永久禁止）。
