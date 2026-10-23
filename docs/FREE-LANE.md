# 免费车道（`@free`）

> 状态（2026-10-22，reeve 0.1.13）：GATE 原生实现；9router 已退役。
> 一句话：链里写 `@free`，GATE 在**请求时**把它展开成"当前可发现、未冷却、有键"的免费候选；
> 列表变了自动跟随，文件里不写死候选。免费池只保留 image-capable 模型。

## 1. 配置（`~/.config/opencode/reeve/fallback.jsonc`）

```jsonc
"policy": { "max_fallback_attempts": 6 },
"free": {
  "enabled": true,
  "max": 3,                        // 免费尝试次数（面板可改）
  "providers": ["opencode", "openrouter"],
  "refresh_seconds": 300,          // 发现源 TTL
  "failure_threshold": 3,          // 同一免费模型连续失败几次进冷却
  "failure_cooldown_seconds": 600,
  "prefer": ["glm-5.3-flash-free", "mimo-v2.6-flash-free", "deepseek-v4.1-flash-free"],
  "deny": [],
  "require_image": true,           // 只选多模态免费模型（按 models.dev modalities 动态过滤）
  "modality_url": "https://models.dev/api.json",
  "modality_ttl_seconds": 21600,   // 模态元数据 6h 缓存；失败保留上一份好数据
  "static": {}
}
```

链：

```jsonc
"standard": { "targets": ["zhipuai-coding-plan/glm-5.3-flash", "lmuai/glm-5.3-flash", "@free", "deepseek/deepseek-flash"] }
"free-first": { "targets": ["@free", "zhipuai-coding-plan/glm-5.3-flash", "lmuai/glm-5.3-flash", "deepseek/deepseek-flash"] }
```

**预算规则（硬）**：`@free` 最多占 `max_fallback_attempts - 1` 跳。
`max=3` 且 `max_fallback_attempts=6` 时，standard 实际是 2 付费 + 3 免费 + 1 付费兜底；
free-first 是 3 免费 + 3 付费。面板的「免费尝试次数」下面会直接显示这条关系。

**免费池只留 image-capable**：`require_image=true` 时，`discover` 从 `free.modality_url`
（默认 `https://models.dev/api.json`）读 `modalities.input`，只保留含 `image` 的模型；纯文本的
`big-pickle`/`minimax` 不进池。元数据按 `modality_ttl_seconds`（默认 6h）缓存，拉取失败保留上一份
好数据；从未成功拿到元数据时直接走付费，**绝不猜/退回纯文本免费模型**。OpenCode Zen 的 `/models`
本身只有 id，没有 modalities，所以必须用 models.dev 或 OpenRouter 的 `architecture.input_modalities`。

免费车道挂在 `free-first` 和 `standard`/`vision` 的尾部，默认给 `reeve/flash`（scout /
librarian）和 `reeve/standard`（executor / reviewer）用；`reeve/pro`（planner / advisor /
critic）走 `reasoning` 付费强推理。不要让所有
agent 都落到 `@free`，免费池里多是 flash 档，规划/评审质量会掉；也不要把所有 agent 都钉到
最强推理，成本和延迟都没必要。

## 2. 发现源

| provider | 来源 | 过滤 | 说明 |
| --- | --- | --- | --- |
| `opencode` | `https://opencode.ai/zen/v1/models`（公开） | `-free` 后缀或 `big-pickle`，排除 `deepseek-v4-flash-free` | 透传车道（我们的客户端身份） |
| `openrouter` | `https://openrouter.ai/api/v1/models`（公开） | `:free` 后缀 | 需要 `auth.json` 的 `openrouter` key |
| `nvidia` | 无公开"免费"标记 | `free.static.nvidia` 白名单 | 免费是账号额度；没有 key 时不参与 |

- 每个 provider 的发现规则独立：某个源挂了只影响它自己（保留上一份好列表并记错误），
  请求照常顺位到其它免费候选或付费。
- 列表形状漂移由 CI 的 `scripts/check-upstream-models.mjs` 每日检查（漂移开 issue）。
- 自定义：`free.sources.<id> = { url, filter }`，filter 取 `opencode-free` / `openrouter-free` / `all`；
  非标准 provider 也可以给 `free.static.<id>` 白名单。

## 3. 展开顺序与冷却

- 顺序：`prefer` 里命中的（full ref 或裸模型名）按书写顺序排最前 → 其余按 `providers` 顺序与目录顺序。
- `deny` 里的永不展开（full ref 或裸模型名都行）。
- 冷却：**按模型全局**（不是按 session）——连续 `failure_threshold` 次失败后冷却
  `failure_cooldown_seconds`；成功清零。会话级冷却（`policy.cooldown_seconds`）仍然生效。
- **全部免费候选都在冷却 / 没 key / 没有发现源 → 本次直接走付费**，不硬撞限流。
- 动态链（含 `@free`）不使用按索引的会话粘性指针：每次请求按当前列表重新展开，靠按 ref 的冷却跳过坏模型。

## 4. 面板

链 tab 的「免费车道」卡：启用开关、免费尝试次数（含预算提示）、参与发现的 provider（含 key/发现状态）、
偏好顺序（置顶 / 排除 / 固定一个模型）、NVIDIA 白名单、发现与冷却参数、**当前展开**（运行时只读）。
链编辑器里 `@free` 显示为「免费车道（自动）· 最多 N 个」一行。

所有编辑走同一套保存（只重写被改的节、保留注释）；保存后等 GATE 热更（≤5s）才显示「已生效」——
「已生效」比较的是**链的完整目标集（chain_targets）+ 策略 + free 节**，不再只比链名。

## 5. 加更多免费模型

1. **OpenCode 免费档**：什么都不用配。往 `prefer` 里加 ID（或面板里"固定一个模型"）即可，例如
   `deepseek-v4.1-flash-free`、`glm-5.3-flash-free`、`minimax-m3.1-flash-free`、`nemotron-3.5-*-free`。
   目录里不一定全列（上游 passthrough），所以 `prefer` 支持裸模型名。
2. **OpenRouter 免费模型**：把 key 放进 `auth.json` 的 `openrouter`（两台机器各一份；对端用
   `ocrc remote sync-auth` 或手工写入），并在 provider 块里保持 `auth: ["openrouter"]`。
   之后 `:free` 模型自动进发现列表。
   **provider 块必须写 `"path": "/chat/completions"`**：`base_url` 是 `https://openrouter.ai/api/v1`
   （已带 `/v1`），GATE 的默认 path 也是 `/v1/chat/completions`，漏写就打到 `/api/v1/v1/...`（404；0.1.9 修）。
3. **NVIDIA**：key 放 `auth.json` 的 `nvidia`，把想用的模型写进 `free.static.nvidia`；
   同样要写 `"path": "/chat/completions"`（base 是 `https://integrate.api.nvidia.com/v1`）。
4. **其它 keyed provider（如 Gemini/Groq）**：加一个 OpenAI 兼容的 provider 块（`base_url` + `auth`），
   再给它一个 `free.sources` 或 `free.static` 条目；免费额度用完后由 GATE 的错误分类顺位切付费。

## 6. 排查

| 现象 | 先看 |
| --- | --- |
| 免费候选一个都没有 | 链里有没有 `@free`；`free.enabled`；`/gate/free` 的 providers（ready/models/error） |
| 一直被跳过 | 是否在全局冷却（`/gate/free` 的 cooling）；key 是否就绪 |
| 401 | 该 provider 的 `auth.json` 条目（openrouter/nvidia），或 `opencode` 的 `key:"public"` 被改坏 |
| 429/额度 | 正常：会进冷却并顺位；调大 `failure_cooldown_seconds` 或减少 `max` |
| 发现 404 / 形状错 | `free.sources` 的 URL/filter；每日哨兵 workflow 的 issue |
| 改了配置没生效 | 保存后的徽标：生效中/没生效；GATE 是否在跑（`/gate/version`） |

## 7. 验证

- 离线：`node plugin/test/free.mjs`（15 项：发现/TTL/展开/预算/冷却/热更/并发/无键/空目录）。
- 真机：`bash scripts/accept-gate.sh`（①/② 免费车道；④ 关闭免费→付费；④b 死免费候选→付费）。
- 生命周期：`node scripts/accept-lifecycle.mjs`（工作区驱逐后 GATE 仍在）。
