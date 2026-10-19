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
REEVE_DEEPSEEK_KEY · REEVE_OPENCODE_KEY · REEVE_ALIBABA_KEY
```

---

## 安装（被控端）

```bash
# 1. 取二进制（版本号从 https://getbifrost.ai/latest-release 的 name 字段取）
curl -sL -o bifrost-http \
  https://downloads.getmaxim.ai/bifrost/latest/linux/amd64/bifrost-http
chmod +x bifrost-http

# 2. 起（app-dir 默认是 OS 配置目录 ~/.config/bifrost，这里显式指定）
./bifrost-http -port 8080 -host 127.0.0.1 -app-dir ~/.reeve/bifrost

# 3. 验
curl -s 127.0.0.1:8080/v1/models
```

**静态链接已确认**（不依赖宿主 glibc → EL7 可跑）。
⚠️ 但**二进制不在 GitHub Releases**（以 CI artifact 形式产出）→ **air-gap 分发要单独设计**。

**改 `config.json` 要重启**；热改走 `POST /api/routing/rules`。

### ⚠️ 两处运行期资源问题（实测审计）

| # | 问题 | 处置 |
|---|---|---|
| 1 | **`logs.db` 只增不减**——每个 LLM 请求都落一行（含 served_model / provider / 状态码）。配额耗尽那阵子一天几百上千行，久了盘会涨 | ✅ 配置 **`client_config.log_retention_days`**（二进制里确认存在，**最小 1 天**）。建议先设 30 |
| 2 | **`/api/routing/rules` 需要 setup token**——否则回 **403** `dashboard auth is not configured`。热改路由要先解决这个 | ⚠️ 在 `config.json` 里设 `setup_token`（或 `BIFROST_SETUP_TOKEN` 环境变量）。**实测踩到** |

**进程开销**：Go 静态二进制 134 MB，常驻内存约 50–200 MB（未精确测）。
它是**独立进程**，不占 opencode 引擎的内存——这正是把它拿出来的好处之一。

**日志查询开销**：`scripts/served-model.sh` 的 SQLite 查询对 `logs` 表做全表聚合。
表大时（几十万行）建议加索引或缩小 `--days`。**目前没建索引，如实记录。**

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
      "settings": { "baseURL": "http://127.0.0.1:8080/v1", "apiKey": "{env:BIFROST_KEY}" },
      "models": {
        "flash":      { "modelID": "reeve/flash" },
        "pro":        { "modelID": "reeve/pro" },
        "multimodal": { "modelID": "reeve/multimodal" }
      }
    }
  }
}
```

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

---

## 三条边界（照做，别踩）

1. **只做 OpenAI 兼容端点之间的纯透传，不做任何格式翻译。**
   反向证据：opencode 官方关闭的 PR **#26292** 明说 *"routing through LiteLLM degrades
   tool-call quality"*，实锤是 issue **#56124**（Bedrock 工具调用参数翻译出错）。
2. **半截流**：首 token 之后才失败的，客户端会当成 HTTP 200 + 一个错误事件。
   回退必须在**首 token 之前**决定 → `ttft_timeout_ms`。
   ⚠️ 官方文档对它的层级**自相矛盾**（changelog + Helm schema + DB migration 说 target 级，
   两份 MDX 说 rule 级）→ **上机时两种都试**。
3. **opencode 永远看不到"谁真的服务了这次请求"**（响应模型名不捕获、响应头也被丢弃 #26091）
   → 配额归因必须在代理侧记（`served_model` 落 `logs.db` 的 `logs` 表）。

---

## 归因：这 196 次 quota 错误分别是哪个 provider 撞的

Bifrost 把**实际服务的模型**落成 `logs` 表的 `served_model` 列（默认 SQLite `logs.db`，
在 app-dir 下）。另有两处可查：

- 响应体 `extra_fields.routing_info.*`（含 `provider` / `model` / `key` / `is_fallback` /
  `primary_provider` / `requested_provider` …）
- 响应头 `x-bifrost-routing-info-{provider,model,key,requested-provider,requested-model,is-fallback,primary-provider,primary-model,alias-model-id,alias-model-name,alias-model-family,server-side-fallback-model}` 与 `x-bifrost-fallback-index`

现成的查询脚本：[`../scripts/served-model.sh`](../scripts/served-model.sh)。

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

**取到的 baseURL**：

| provider | baseURL |
|---|---|
| `opencode` | `https://opencode.ai/zen/v1` |
| `zhipuai-coding-plan` | `https://open.bigmodel.cn/api/coding/paas/v4` |
| `deepseek` | `https://api.deepseek.com/v1`（目录里写的是 `https://api.deepseek.com`） |
| `xiaomi` | `https://api.xiaomimimo.com/v1` |
| `alibaba-cn` | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| `lmuai`（自定义） | `https://api.lmuai.com/v1`（来自 `D:\develop\OpenCodeConfig`） |
| `xxyapi-deepseek`（自定义） | `https://www.xxyapi.com/v1`（同上） |

**链上用到的 model id 都在目录里核对过存在**：

```
✓ opencode/mimo-v2.6-flash-free      ✓ zhipuai-coding-plan/glm-5.3
✓ zhipuai-coding-plan/glm-5.3-flash  ✓ deepseek/deepseek-flash
✓ xiaomi/mimo-v2.6-flash             ✓ alibaba-cn/qwen3.6-plus
（自定义两个 provider 的 model id 来自使用者配置，目录里没有）
```

> ⚠️ **目录是缓存的快照**（`~/.cache/opencode/models.json`，2026-10-05）。
> 上机前建议重跑一次上面的命令核对；model id 会随上游变动。

---

## 许可

Bifrost：**Apache-2.0**（第三方，非本仓库代码）。
本仓库不 vendor 它的任何源码或二进制。
