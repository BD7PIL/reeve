# 代理层（Bifrost）

**职责**：跨 provider 回退。链头配额耗尽/限流/网络故障时，下一个自动接上。
**这一层不是 REEVE 开发的**——Bifrost 是第三方 Go 静态二进制（Apache-2.0），REEVE 只消费它。

---

## 拓扑

```
被控端（EL7）
  opencode v2 引擎 ──HTTP 回环──▶ Bifrost(127.0.0.1:8080) ──▶ 真实 provider
   只知道 reeve/flash|pro|multimodal        （链与回退全在这里）
```

引擎**只知道三个档位名**；链在代理内部随意变化，对引擎完全透明。
（前提已实测：opencode v2 **不读响应体的 `model` 字段**，始终发调用者请求的名字——
见 [../docs/HANDOFF.md](../docs/HANDOFF.md) §4.4 的实验与源码佐证。）

---

## 进程谁持有 → **ocrc**

- ocrc 的职责就是"把运行时/引擎/应用推上去并连起来"，且**已有版本 pin 的 bin-cache**
  （`~/.ocrc/bin-cache/` 里有 `remote-engine/2.0.27-linux-x64/`、`remote-runtime/24.22.0/`、
  `cli-linux-x64-2.0.27.tgz`）。**Bifrost 不在 GitHub Releases**（只能从 `downloads.getmaxim.ai` 取，
  ~128 MB），正需要这套 pin + 分发机制。
- ocrc 已有唯一启动入口 `buildInstanceServeCommand`。Bifrost 就是它前面多起一个进程。
- **不能由记账插件持有**：插件活在被控端引擎进程里，引擎重启它就没了；
  而且这一层必须与引擎版本解耦（"永不随 v2 API 漂移而腐烂"）。

## 谁配置 → **源真相在本仓库，运行时唯一写者是控制台**

| 角色 | 对 `proxy/config.json` 的权限 |
|---|---|
| **reeve 仓库（本文件）** | **持有源真相**——链只在这里改一次 |
| ocrc | **只推送**（把本文件推到被控端并让 Bifrost 指向它），不生成内容 |
| 控制台（步 5，可选） | **唯一运行时写者**（编辑 UI，写回同一份源真相） |
| 记账插件 | **只读**，绝不碰代理配置 |

**API key 不进仓库**：`keys[].value` 写 `env.<VAR>`，由 ocrc 的启动行注入
（它已在 `renderExports` 里注入 `HTTP_PROXY` / `NODE_EXTRA_CA_CERTS`，加几个变量是同一处改动）。

需要注入的变量（对应 `config.json` 里的 `env.*`）：

```
REEVE_LMUAI_KEY · REEVE_XXYAPI_KEY · REEVE_ZHIPUAI_KEY
REEVE_DEEPSEEK_KEY · REEVE_OPENCODE_KEY · REEVE_ALIBABA_KEY · REEVE_XIAOMI_KEY
BIFROST_SETUP_TOKEN      # config.json 里 governance.setup_token = env.BIFROST_SETUP_TOKEN
```

**另有一个不是 provider key 的凭据**：引擎侧要带 **Bifrost virtual key**（`REEVE_VK`），见下面「引擎侧怎么接」。

---

## 安装（被控端）

```bash
# 1. 取二进制（版本号从 https://getbifrost.ai/latest-release 的 name 字段取）
curl -sL -o bifrost-http \
  https://downloads.getmaxim.ai/bifrost/latest/linux/amd64/bifrost-http
chmod +x bifrost-http

# 2. 起（app-dir 默认是 OS 配置目录 ~/.config/bifrost，这里显式指定）
./bifrost-http -port 8080 -host 127.0.0.1 -app-dir ~/.reeve/bifrost

# 3. 验（要先带 VK —— 见下）
curl -s -H "x-bf-vk: $REEVE_VK" 127.0.0.1:8080/v1/models
```

**静态链接已确认**（不依赖宿主 glibc → EL7 可跑）。
⚠️ 但**二进制不在 GitHub Releases**（以 CI artifact 形式产出）→ **air-gap 分发要单独设计**。

**改 `config.json` 要重启**；热改走 `POST /api/routing/rules`（要 setup token）。

**一键脚本**（EL7 staging 实测用过的，幂等）：`scripts/el7-deploy-staging.sh`
（env → 派生 config → 起 Bifrost → 建/换 VK → 写进 600 权限的 env 文件）。
配套 `scripts/el7-restart-bifrost.sh`（改完 config 重启并等它就绪）。

### ⚠️ 上机实测踩到的五处（都已写进 `config.json`）

| # | 坑 | 正确做法 |
|---|---|---|
| 1 | **`base_url` 带 `/v1` 会拼成 `/v1/v1/chat/completions`**——Bifrost 总在 base_url 之后追加路径 | base_url 只写到**主机（+必要前缀）**，路径交给 `request_path_overrides` |
| 2 | ⚠️ **流式用的是另一个键 `chat_completion_stream`**。只设 `chat_completion` 时：curl 非流式正常，**opencode 一跑就 405** | **两个键都写**（opencode 永远走流式） |
| 3 | **provider id 撞 Bifrost 内置名会静默失效**：叫 `deepseek` → `failed to get config for provider deepseek: not found` | 改名（本仓库用 `deepseek-api`） |
| 4 | **保留期的键是 `client`，不是 `client_config`**：写错不报错，DB 里仍是默认 365 天 | 用 `client: { "log_retention_days": 30 }` |
| 5 | **推理默认要求 virtual key**：无 `x-bf-vk` 回 401；新建的 VK 默认**一个 provider 都不允许**（403） | 建 VK → `PUT .../virtual-keys/<id>` `{"allow_all_providers":true}` → 引擎侧当 apiKey 用 |

### ⚠️ 两处运行期资源问题（实测审计）

| # | 问题 | 处置 |
|---|---|---|
| 1 | **`logs.db` 只增不减**——每个 LLM 请求都落一行（含 provider / served 模型 / 状态码）。配额耗尽那阵子一天几百上千行，久了盘会涨 | ✅ 配置 **`client.log_retention_days`**（**默认 365 天**，最小 1 天）。建议 30 |
| 2 | **`/api/routing/rules` 与 `/api/governance/*` 需要 setup token**——否则 401 `dashboard auth is not configured` | ⚠️ `governance.setup_token` 写 **`env.BIFROST_SETUP_TOKEN`**，请求头 **`X-Bifrost-Setup-Token`**。**实测踩到** |

**进程开销**：Go 静态二进制 134 MB，常驻内存约 50–200 MB（未精确测）。
它是**独立进程**，不占 opencode 引擎的内存——这正是把它拿出来的好处之一。

**日志查询开销**：`scripts/served-model.sh` 对 `logs` 表做聚合。
表大时（几十万行）建议加索引或缩小 `--days`。**目前没建索引，如实记录。**

⚠️ **别用 sqlite3 CLI 去读 `logs.db`**：Bifrost 的库用了**部分索引**（`CREATE INDEX ... WHERE ...`），
需要 SQLite >= 3.8；**EL7 自带 3.7.17 直接报 `malformed database schema`**（实测）。
`served-model.sh` 因此优先找支持 `node:sqlite` 的 node（ocrc 运行时自带 Node 24），
都没有才退到 `/api/logs`（那条路要 setup token）。

---

## opencode 侧怎么接

**必须用原生复数 `providers` + `package`/`settings`**（实测：遗留单数 `provider` + `npm`/`options`
形态下 **`modelID` 会被静默忽略**，线上名退化成 models 的 key，Bifrost 的 CEL 就匹配不上）。

```jsonc
// $HOME/.config/opencode/opencode.json
{
  "providers": {
    "reeve": {
      "name": "REEVE Router",
      "package": "@ai-sdk/openai-compatible",
      "settings": { "baseURL": "http://127.0.0.1:8080/v1", "apiKey": "{env:REEVE_VK}" },
      "models": {
        "flash":      { "modelID": "reeve/flash" },
        "pro":        { "modelID": "reeve/pro" },
        "multimodal": { "modelID": "reeve/multimodal" }
      }
    }
  }
}
```

> **`apiKey` 放的是 Bifrost 的 virtual key（`REEVE_VK`），不是任何 provider 的 key。**
> 这样 provider 真 key 只存在于 Bifrost 的 env 里，引擎侧哪怕被拿到也换不出上游凭据。
> 建 VK 的步骤见上面的"坑 #5"；VK 的明文只在**创建/轮换**时返回一次，所以要落进 600 权限的 env 文件。

> **⚠️ 两种语法不通用（实测踩过）**：
> - **opencode 侧**（上面这个）用 **`{env:VAR}`**。
>   写成 `"env.BIFROST_KEY"` **不报配置错**——它会把**字面串当密钥发出去**，
>   服务端回 `Invalid token`。**静默失败。**
> - **Bifrost 侧**（`config.json` 里的 `keys[].value`）用 **`env.VAR`**——那是 Bifrost 自己的语法。
>
> **判据**：`opencode debug config` 里 `apiKey` 应显示成 `***`；显示成 `env.XXX` 原文就是写错了。


→ agent 写 `model: reeve/flash`；**ref 与发给端点的线上名都是 `reeve/flash`**；
CEL 写 `model == "reeve/flash"` 直接命中，**零映射层**。
（实测记录见 [../docs/research/opencode-v2-plugin-api.md](../docs/research/opencode-v2-plugin-api.md) §10.1 / §14.6。）

> ⚠️ **验档位要验"委派"，不能看 `opencode run --agent <subagent>`**：
> 实测（v2.0.27）顶层会话用的是 **config 里的默认 `model`**，subagent 自己的档位**只在被委派时生效**。
> 证据：`--agent scout` 跑出来是 `scout · pro`；而 foreman 真委派 scout 时，子会话的 8 次调用全在 `reeve/flash`。

---

## 三条边界（照做，别踩）

1. **只做 OpenAI 兼容端点之间的纯透传，不做任何格式翻译。**
   反向证据：opencode 官方关闭的 PR **#26292** 明说 *"routing through LiteLLM degrades
   tool-call quality"*，实锤是 issue **#56124**（Bedrock 工具调用参数翻译出错）。
2. **半截流**：首 token 之后才失败的，客户端会当成 HTTP 200 + 一个错误事件。
   回退必须在**首 token 之前**决定 → `ttft_timeout_ms`。
   ✅ **层级已实测确定 = target 级**（运行时迁移 `add_ttft_timeout_ms_column_to_routing_targets`；
   rule 级不报错只是因为未知字段被宽容忽略）。
3. **opencode 永远看不到"谁真的服务了这次请求"**（响应模型名不捕获、响应头也被丢弃 #26091）
   → 配额归因必须在代理侧记。
   ⚠️ **本构建（v2.3.0）里 `served_model` 列恒为 NULL** —— 真正有值的是
   `provider` / `model` / `selected_key_name` / `fallback_index` / `routing_rule_name`（见下）。

---

## 归因：这 196 次 quota 错误分别是哪个 provider 撞的

Bifrost 把每次请求落进 `logs` 表（默认 SQLite `logs.db`，在 app-dir 下）。
**注意列名与本仓库早先的假设不同**（2026-10-19 用 `pragma table_info(logs)` 实测 v2.3.0）：

| 早先以为 | 实际 |
|---|---|
| `served_model` 列有值 | ❌ **恒为 NULL**；实际服务的模型在 **`model`** 列 |
| `is_fallback` | ❌ 不存在；用 **`fallback_index`**（0 = 配置里的链头） |
| `status_code` | ❌ 不存在；用 **`status`**（`success`/`error`） |
| `requested_model` | ❌ 不存在；档位在 **`routing_rule_name`**（值就是 `reeve/pro`） |
| — | ✅ 另有 `provider` / `selected_key_name`（哪把 key）/ `latency` / `error_details` |

⚠️ **别把 `fallback_index=0` 读成"链头成功"**：实测 Bifrost 会把**连续失败的 key 从链头挪走**——
坏 key 期间先看到 `hop=0 xiaomi error / hop=1 zhipuai success`，
之后同一档位直接 `hop=0 zhipuai success`（xiaomi 已被移出轮转）。
**归因要看 `provider` 列，不要假设 hop 0 = 配置里的头。**

另有两处可查：

- 响应体 `extra_fields.routing_info.*`（含 `provider` / `model` / `key` / `is_fallback` /
  `primary_provider` / `requested_provider` …）
- 响应头 `x-bifrost-routing-info-{provider,model,key,requested-provider,requested-model,is-fallback,primary-provider,primary-model,alias-model-id,alias-model-name,alias-model-family,server-side-fallback-model}` 与 `x-bifrost-fallback-index`

现成的查询脚本：[`../scripts/served-model.sh`](../scripts/served-model.sh)
（核心是 `../scripts/served-model.mjs`，走 `node:sqlite`；退路是 `/api/logs` + setup token）。

**输出长这样**（EL7 staging 的真实数据）：

```
--- 档位 → 谁真的服务了 ---
  tier              provider             served_model         key_name         status   n
  reeve/pro         zhipuai-coding-plan  glm-5.3              zhipuai-primary  success  9
  reeve/flash       xiaomi               mimo-v2.6-flash      xiaomi-primary   success  8
  reeve/flash       zhipuai-coding-plan  glm-5.3-flash        zhipuai-primary  success  4   ← 坏 key 时回退接上的
  reeve/multimodal  zhipuai-coding-plan  glm-5.3-flash        zhipuai-primary  success  3
```

---

## endpoint 与模型 id 的来源（已解决，含复现方法）

原先缺的 4 个 provider 的 OpenAI 兼容 endpoint **不需要使用者提供**——
本机的 **models.dev 目录**里就有，而且它们全部标着 `npm=@ai-sdk/openai-compatible`。

**复现命令**：

```bash
node -e '
const c=JSON.parse(require("fs").readFileSync(process.env.HOME+"/.cache/opencode/models.json","utf8"));
for(const id of ["opencode","zhipuai-coding-plan","deepseek","xiaomi","alibaba-cn"]){
  const p=c[id]; if(p) console.log(id, "->", p.api);
}'
```

**取到的 baseURL**（目录里给的是**完整** endpoint；**写进 Bifrost 的 config.json 时要拆开**：

> ⚠️ 目录给的 `https://host/api/xxx/v4` 是**完整** endpoint。Bifrost 会在 `base_url` 之后
> **再追加** `request_path_overrides` 里那个路径（默认 `/v1/chat/completions`），
> 所以 `base_url` 里**不能带 `/v1`**，路径一律由 override 明确写出（见 config.json 的注释）。

| provider | config.json 里的 `base_url` | `request_path_overrides.chat_completion[_stream]` |
|---|---|---|
| `opencode` | `https://opencode.ai/zen` | `/v1/chat/completions` |
| `zhipuai-coding-plan` | `https://open.bigmodel.cn` | `/api/coding/paas/v4/chat/completions` |
| `deepseek-api` | `https://api.deepseek.com` | `/v1/chat/completions` |
| `xiaomi` | `https://api.xiaomimimo.com` | `/v1/chat/completions` |
| `alibaba-cn` | `https://dashscope.aliyuncs.com` | `/compatible-mode/v1/chat/completions` |
| `lmuai`（自定义） | `https://api.lmuai.com` | `/v1/chat/completions` |
| `xxyapi-deepseek`（自定义） | `https://www.xxyapi.com` | `/v1/chat/completions` |

（`lmuai` / `xxyapi-deepseek` 的 endpoint 来自使用者的 `D:\develop\OpenCodeConfig`；
其余来自 models.dev 目录。）

**链上用到的 model id 都在目录里核对过存在**：

```
✓ opencode/mimo-v2.6-flash-free      ✓ zhipuai-coding-plan/glm-5.3
✓ zhipuai-coding-plan/glm-5.3-flash  ✓ deepseek/deepseek-flash
✓ xiaomi/mimo-v2.6-flash             ✓ alibaba-cn/qwen3.6-plus
（自定义两个 provider 的 model id 来自使用者配置，目录里没有）
```

> ⚠️ **目录是缓存的快照**（`~/.cache/opencode/models.json`，2026-10-05）。
> 上机前建议重跑一次上面的命令核对；model id 会随上游变动。

> **EL7 上的实测可用性**（2026-10-19）：`zhipuai-coding-plan` / `lmuai` / `xiaomi` ✅ 可用且支持流式；
> `xxyapi-deepseek` 503、`deepseek-api` 余额为 0、`alibaba-cn` key 无效。
> **provider 的可用性是账号侧的事，与链序无关** —— 上机先用
> `scripts/el7-deploy-staging.sh` 旁的直连测试（或直接 `curl` 点名 provider/model）核对一遍。

---

## 许可

Bifrost：**Apache-2.0**（第三方，非本仓库代码）。
本仓库不 vendor 它的任何源码或二进制。
