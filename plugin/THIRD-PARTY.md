# 第三方内容声明（`@bd7pil/reeve` 包内）

本包**不全是自写内容**：有两处外来内容按各自许可**随包分发**，许可原文在 `licenses/`。
（仓库根还有一份 `NOTICE.md`，记录的是"引入前/引入后"的完整台账；那份**不随包发布**，
所以包内消费者需要的完整清单放在本文件里。）

## 1. `oh-my-opencode-slim` — MIT

- 上游：https://github.com/alvinunreal/oh-my-opencode-slim （tag **v3.0.5**）
- 许可原文：`licenses/oh-my-opencode-slim.LICENSE`（MIT，`Copyright (c) 2025`）
- 引入方式：**参照算法、按 opencode v2 的插件 API 重写实现**（不逐字照抄——上游是 v1 插件，
  钩子名不同，照抄一个都不会触发）。被参照的是：终态判定门与静默宽限、墙钟监督器、
  准入队列（含"嵌套受管任务豁免"）、惰性重启对账、按目录的进程级共享。

## 2. `alibaba/open-code-review` — Apache-2.0

- 上游：https://github.com/alibaba/open-code-review
- tag **v1.13.8**，commit `4236c871fe8130aa840a2a1c0922f469e87e0416`
- 许可原文：`licenses/open-code-review.LICENSE`（Apache-2.0，`Copyright 2026 Alibaba`）
- 上游 NOTICE：已核实 v1.13.8 根目录没有 `NOTICE` / `NOTICE.md`（只有 `LICENSE`），
  Apache-2.0 §4(d) 无额外 NOTICE 需要转抄。
- 引入方式：**规则文档原样副本**，位于 `skills/review/`，共 **64 份**。
  逐份 sha256 见 `skills/review/UPSTREAM.sha256`——它同时是发布门禁的依据
  （`scripts/check-plugin-pack.mjs` 断言包内清单与哈希逐份对上）。

| # | 文件 |
|---|---|
| 1 | `arkts.md` |
| 2 | `astro.md` |
| 3 | `bicep.md` |
| 4 | `build_gradle.md` |
| 5 | `c.md` |
| 6 | `capnp.md` |
| 7 | `cargo_toml.md` |
| 8 | `clojure.md` |
| 9 | `composer_json.md` |
| 10 | `cpp.md` |
| 11 | `csharp.md` |
| 12 | `default.md` |
| 13 | `ejs_liquid_njk.md` |
| 14 | `elm.md` |
| 15 | `erb.md` |
| 16 | `freemarker.md` |
| 17 | `fsharp.md` |
| 18 | `github_config.md` |
| 19 | `github_workflows.md` |
| 20 | `go.md` |
| 21 | `graphql.md` |
| 22 | `haml_slim.md` |
| 23 | `handlebars_mustache.md` |
| 24 | `haskell.md` |
| 25 | `java.md` |
| 26 | `jinja.md` |
| 27 | `json.md` |
| 28 | `jsonnet.md` |
| 29 | `julia.md` |
| 30 | `kotlin.md` |
| 31 | `mapper_dao_xml.md` |
| 32 | `matlab.md` |
| 33 | `nim.md` |
| 34 | `nix.md` |
| 35 | `nushell.md` |
| 36 | `objc.md` |
| 37 | `ocaml.md` |
| 38 | `package_json.md` |
| 39 | `php.md` |
| 40 | `po.md` |
| 41 | `pom_xml.md` |
| 42 | `pot.md` |
| 43 | `powershell.md` |
| 44 | `prisma.md` |
| 45 | `properties.md` |
| 46 | `protobuf.md` |
| 47 | `pug.md` |
| 48 | `python.md` |
| 49 | `r.md` |
| 50 | `rego.md` |
| 51 | `rust.md` |
| 52 | `scala.md` |
| 53 | `shader.md` |
| 54 | `solidity.md` |
| 55 | `starlark.md` |
| 56 | `swift.md` |
| 57 | `terraform.md` |
| 58 | `thrift.md` |
| 59 | `ts_js_tsx_jsx.md` |
| 60 | `verilog.md` |
| 61 | `vhdl.md` |
| 62 | `vyper.md` |
| 63 | `yaml.md` |
| 64 | `zig.md` |

**自写的**（不属于上游内容）：

- `skills/review/SKILL.md` —— 五维使用说明、映射表、输出契约、多轮与误报过滤、门禁策略；
  只从上游 `internal/model/review.go` 取了 `Category` / `Severity` 枚举。
- `skills/review/review-map.json` —— 扩展名 → 规则的选择表（**REEVE 自定**，不是上游内部映射）。
- `skills/review/UPSTREAM.sha256` —— 64 份的哈希清单。

## 未引入

`oh-my-openagent`（**SUL-1.0**：不可再授权）的任何代码或 prompt 字面——永久禁止。
