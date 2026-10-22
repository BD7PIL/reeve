# 探针：v2 的 provider HTTP 钩子到底能做什么

一次性实验用的小插件（不是 REEVE 的组成部分）。它回答一个问题：
**opencode v2 的插件能不能看到并**替换**引擎发出去的 provider 请求？**

## 怎么用

```bash
# 1) 拷成一个插件目录，加进实例配置（部署脚本会重写配置，所以要在它之后加）
mkdir -p /tmp/probe-http && cp index.js package.json /tmp/probe-http/
#    opencode.json 的 plugins 里追加 { "package": "/tmp/probe-http" }
# 2) 跑一轮真实调用
opencode service stop; opencode run "Reply with exactly: OK"
# 3) 读事实（探针把每条钩子事件写进这个文件）
cat /tmp/reeve-http-hook-probe4.jsonl
# 4) 线上真相在代理侧：Bifrost 的 logs 表（routing_rule_name / provider / model / fallback_index）
```

## 实测结论（2026-10-19，EL7 staging，v2.0.27）

| 钩子 | 载荷 | 可写字段 | 实测 |
|---|---|---|---|
| `http.request` | `{sessionID, agent, model, kind, request: Request}` | **`request`**（整体替换） | ✅ **有效**：把 body 里的 `model` 从 `reeve/pro` 改成 `reeve/flash`，Bifrost 日志确认这条落到 flash 链并 hop=0 success |
| `http.response` | 同上 + `response: Response` | `response` | 未改（只读了 `status`） |
| `retry` | `{sessionID, agent, model, error, attempt, decision}` | **`decision`**（`{retry:false}` / `{retry:true,delay}`） | 可写（写回读得到）；未验"引擎是否照办" |
| `model.request` | `{sessionID, agent, model, kind, baseURL?, headers}` | `baseURL` / `headers`（按类型定义） | 未测 |

`kind` 的取值：`primary` / `title` / `compaction` / `generate` —— 可以只对主调用动手。

## 两个坑

1. **`model` 是只读的**：往里写 `model.id` 不生效（线上没变），而且**会漏进会话状态**（实测 CLI 的标签从 `pro` 变成了 `flash`）。
2. 钩子的契约是"改传入对象"，**不是**返回值（`packages/plugin/src/promise/registration.ts`：`callback: (input) => Promise<void> | void`）。
