# 第三方内容声明（`@bd7pil/reeve` 包内）

本包**不全是自写内容**：有两处外来内容按各自许可**随包分发**，许可原文在 `licenses/`。
（仓库根还有一份 `NOTICE.md`，记录的是"引入前/引入后"的完整台账；这份文件只讲**包内**这两处。）

## 1. `oh-my-opencode-slim` — MIT

- 上游：https://github.com/alvinunreal/oh-my-opencode-slim （tag **v3.0.5**）
- 许可原文：`licenses/oh-my-opencode-slim.LICENSE`（MIT，`Copyright (c) 2025`）
- 引入方式：**参照算法、按 opencode v2 的插件 API 重写实现**（不逐字照抄——上游是 v1 插件，
  钩子名不同，照抄一个都不会触发）。被参照的是：终态判定门与静默宽限、墙钟监督器、
  准入队列（含"嵌套受管任务豁免"）、惰性重启对账、按目录的进程级共享。

## 2. `alibaba/open-code-review` — Apache-2.0

- 上游：https://github.com/alibaba/open-code-review （tag **v1.13.1**）
- 许可原文：`licenses/open-code-review.LICENSE`（Apache-2.0，`Copyright 2026 Alibaba`）
- 引入方式：**规则文档原样副本**，位于 `skills/review/`：
  `default.md`、`ts_js_tsx_jsx.md`、`python.md`、`go.md`、`yaml.md`、`json.md`、`package_json.md`。
  `skills/review/SKILL.md`（使用说明、rubric 选择表、输出契约、误报过滤）是**自写**的，
  只从上游 `internal/model/review.go` 取了 `Category` / `Severity` 枚举。

## 未引入

`oh-my-openagent`（**SUL-1.0**：不可再授权）的任何代码或 prompt 字面——永久禁止。