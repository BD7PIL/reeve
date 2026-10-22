# 探针：引擎运行时里，一个"纯插件"能做什么

一次性实验用的小插件（不是 REEVE 的组成部分）。它验三件事，都是"插件自己拉起代理"的前提：

1. **spawn 长命子进程**、判活（`process.kill(pid, 0)`）、收掉（`SIGTERM`）
2. **fetch**（取件 128 MB 二进制、调代理的 `/api/version` 与治理 API）
3. **读引擎环境**（若要注入 VK 之类；自持形态其实不需要）

## 怎么用

```bash
mkdir -p /tmp/probe-runtime && cp index.js package.json /tmp/probe-runtime/
#   实例配置的 plugins 里追加 { "package": "/tmp/probe-runtime" }
opencode service stop; opencode run "Reply with exactly: OK"
cat /tmp/reeve-runtime-probe.jsonl
```

## 实测结论（2026-10-19，EL7 staging，引擎 v2.0.27）

```
{"spawn":"ok","pid":117229,"hasUnref":true}   ← 能起；child.unref 存在
{"aliveAfter600ms":true} {"killed":true}      ← 能判活、能收掉
{"fetch":200,"body":"\"v2.3.0\"\n"}           ← fetch 打得到回环上的代理
{"runtime":{"bun":true,"node":"v26.3.0"},...} ← 运行时是 Bun（node 兼容面 v26）
```

→ **所以"纯插件自己拉起代理"是成立的**：不需要任何外部脚本，也不需要 ocrc。
