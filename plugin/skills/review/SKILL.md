---
name: review
description: 代码审查的规则与输出契约。在审查代码 diff 时使用：五维 rubric（正确性 / 安全 / 性能 / 可维护性 / 测试覆盖）、按扩展名从 64 份语言与格式规则里选对应的一份、结构化输出契约（severity 与 category 必填，外加 path、行号、existing_code 锚点片段、suggestion_code）、多轮评审时撤掉计划的做法、以及最后一轮的误报过滤。不用于审查实施计划（那是 critic 的活）。
description_en: Code review rules and output contract. Use when reviewing a code diff: five-axis rubric (correctness, security, performance, maintainability, test coverage), selecting one of 64 per-language/format rule docs by file extension, structured output where severity and category are mandatory alongside path, line range, existing_code anchor and suggestion_code, dropping the plan in later rounds, and a final false-positive pass. Not for reviewing implementation plans (that is critic's job).
license: Apache-2.0
metadata:
  source: alibaba/open-code-review
  source-tag: v1.13.8
  source-commit: 4236c871fe8130aa840a2a1c0922f469e87e0416
---

# 审查层 —— 规则与输出契约

> **给 `reviewer` agent 用。** 审查对象是**代码 diff**（不是计划——那是 `critic` 的活）。
>
> **来源**：规则文档抄自 [`alibaba/open-code-review`](https://github.com/alibaba/open-code-review)
> （**Apache-2.0**，`Copyright 2026 Alibaba`，tag `v1.13.8`，commit `4236c87`）。
> 64 份原样副本，逐份 sha256 见 `UPSTREAM.sha256`，许可原文见 `licenses/open-code-review.LICENSE`。
> **我们只吸收规则与契约，不装 OCR 工具**。
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

## 2. 按扩展名取规则

**任何语言都先读 `default.md` 的五维总纲**，再按下表取被审文件对应的那一份。
表外格式（`.sh`、`Dockerfile`、`Makefile`、`.html` 等上游未覆盖的）**只用 `default.md`**，不要硬套别的语言的规则。

<!-- BEGIN review-map -->
### 语言

| 规则文件 | 适用 |
|---|---|
| `arkts.md` | `*.ets` |
| `astro.md` | `*.astro` |
| `c.md` | `*.c` `*.h` |
| `clojure.md` | `*.clj` `*.cljs` `*.cljc` `*.edn` |
| `cpp.md` | `*.cpp` `*.cc` `*.cxx` `*.hpp` `*.hh` `*.hxx` |
| `csharp.md` | `*.cs` `*.csx` |
| `elm.md` | `*.elm` |
| `fsharp.md` | `*.fs` `*.fsx` `*.fsi` |
| `go.md` | `*.go` |
| `graphql.md` | `*.graphql` `*.gql` |
| `haskell.md` | `*.hs` `*.lhs` |
| `java.md` | `*.java` |
| `jsonnet.md` | `*.jsonnet` `*.libsonnet` |
| `julia.md` | `*.jl` |
| `kotlin.md` | `*.kt` `*.kts` |
| `matlab.md` | **按需读取**（.m is ambiguous with Objective-C; select it only for MATLAB-style projects.） |
| `nim.md` | `*.nim` |
| `nushell.md` | `*.nu` |
| `objc.md` | `*.m` `*.mm` |
| `ocaml.md` | `*.ml` `*.mli` |
| `php.md` | `*.php` |
| `powershell.md` | `*.ps1` `*.psm1` `*.psd1` |
| `python.md` | `*.py` `*.pyi` |
| `r.md` | `*.r` `*.rmd` |
| `rego.md` | `*.rego` |
| `rust.md` | `*.rs` |
| `scala.md` | `*.scala` `*.sc` |
| `shader.md` | `*.glsl` `*.hlsl` `*.frag` `*.vert` `*.comp` `*.shader` |
| `solidity.md` | `*.sol` |
| `starlark.md` | `*.bzl` `*.star` `BUILD` `BUILD.bazel` `WORKSPACE` `WORKSPACE.bazel` |
| `swift.md` | `*.swift` |
| `ts_js_tsx_jsx.md` | `*.ts` `*.tsx` `*.js` `*.jsx` `*.mjs` `*.cjs` `*.mts` `*.cts` |
| `verilog.md` | `*.v` `*.sv` `*.svh` `*.vh` |
| `vhdl.md` | `*.vhd` `*.vhdl` |
| `vyper.md` | `*.vy` |
| `zig.md` | `*.zig` |

### 配置与构建

| 规则文件 | 适用 |
|---|---|
| `build_gradle.md` | `build.gradle` `build.gradle.kts` `settings.gradle` `settings.gradle.kts` `gradle.properties` |
| `cargo_toml.md` | `Cargo.toml` |
| `composer_json.md` | `composer.json` |
| `github_config.md` | `.github/**/*.yml` `.github/**/*.yaml` |
| `github_workflows.md` | `.github/workflows/**` |
| `json.md` | `*.json` `*.jsonc` |
| `mapper_dao_xml.md` | `*Mapper.xml` `*Dao.xml` |
| `package_json.md` | `package.json` |
| `po.md` | `*.po` |
| `pom_xml.md` | `pom.xml` |
| `pot.md` | `*.pot` |
| `properties.md` | `*.properties` |
| `yaml.md` | `*.yml` `*.yaml` |

### 模板

| 规则文件 | 适用 |
|---|---|
| `ejs_liquid_njk.md` | `*.ejs` `*.liquid` `*.njk` |
| `erb.md` | `*.erb` |
| `freemarker.md` | `*.ftl` `*.ftlh` |
| `haml_slim.md` | `*.haml` `*.slim` |
| `handlebars_mustache.md` | `*.hbs` `*.handlebars` `*.mustache` |
| `jinja.md` | `*.jinja` `*.jinja2` `*.j2` |
| `pug.md` | `*.pug` `*.jade` |

### 基础设施与 IDL

| 规则文件 | 适用 |
|---|---|
| `bicep.md` | `*.bicep` |
| `capnp.md` | `*.capnp` |
| `nix.md` | `*.nix` |
| `prisma.md` | `*.prisma` |
| `protobuf.md` | `*.proto` |
| `terraform.md` | `*.tf` `*.tfvars` `*.tofu` |
| `thrift.md` | `*.thrift` |

### 兜底

- `default.md` — 任何表外文件（上游未覆盖的格式，如 `.sh`、`Dockerfile`、`Makefile`、`.html`）。
<!-- END review-map -->

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
（它的价值在滑动窗口行号锚定与 token 预算管理，这些要装工具本体才有）。

---

## 7. 我们会失去什么（如实）

本目录是**规则快照**，不是 OCR 工具。即使 64 份已全量，仍然失去：

- **行号锚定的滑动窗口算法**（OCR 的 diff 定位器）
- **按元数据的语义分组**
- **token 预算管理**

规则覆盖这一项已经补齐：64 份随包分发，扩展名可判定的由 §2 的表选择，
框架/上下文相关的（如 `matlab.md` 与 Objective-C 共用的 `.m`）按需 Read。
失去的是**引擎级自动挂载**——由 §2 的静态表等价替代（表不读文件内容，
所以 `.m`、`.h` 这类歧义扩展名要靠上下文判断）。

---

## 8. 来源与许可

- 上游：`alibaba/open-code-review`（Apache-2.0，`Copyright 2026 Alibaba`）
- tag **v1.13.8**，commit `4236c871fe8130aa840a2a1c0922f469e87e0416`
- 本目录下除 `SKILL.md` / `review-map.json` / `UPSTREAM.sha256` 之外的所有 `.md`
  是上游 `internal/config/rules/rule_docs/` 的**原样副本**；逐份 sha256 见 `UPSTREAM.sha256`。
- `review-map.json` 的 glob 是 **REEVE 自定的选择规则**，不是上游的内部映射。
- 许可原文：`licenses/open-code-review.LICENSE`
- 结构化输出契约的枚举取自上游 `internal/model/review.go`
  （`Category`：bug / security / performance / maintainability / test / style / documentation / other；
  `Severity`：critical / high / medium / low）

**未引入**：OCR 的 Go 代码、它的 CLI 二进制、它的 npm 包装器。
**未引入** `oh-my-openagent`(omo) 的任何代码或 prompt 字面（SUL-1.0，永久禁止）。
