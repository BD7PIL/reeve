# GATE 交付的回滚手册（Bifrost 退役 → 回 0.1.4 那一代）

> 状态（2026-10-22）：**已发布并两端验收通过**。手动流程见 §2.4。
>
> 发布记录（回滚时按这些号找回来）：
> · reeve：npm `@bd7pil/reeve@0.1.5`（GitHub Actions `Publish plugin` 绿）、扩展 `reeve-0.1.2` 钉 + `reeve-latest` 通道（`reeve-extension.yml` 绿）；
>   公开树单提交 `2df3c18`（CI 绿）；本仓开发历史：`a415709`（面板重做）→ `a415709`..`af57774`（基线/验收包修正）
> · ocrc：`d4069478`（pin 0.1.5）、`8b623577`（暂存穿透链接）、`08b6ebe0`（sync 含 reeve 目录）
> · 对端（demo@192.168.26.101）：组件 `~/.ocrc/components/reeve/package` = 0.1.5、扩展已装并授权、`~/.config/opencode/reeve/fallback.jsonc` 已同步、
>   9router 0.5.104（`requireApiKey=false` + `@reboot` cron）、旧 Bifrost 进程已清、`accept-gate.sh` ①–⑨ 全过
> · 两端 `config-diff`：`reeve/fallback.jsonc` 相同、一次同步写 0 个文件
>
> **0.1.6（已发，两端已升）**：两处修正 —— ① 快照/面板版本号读成 0.1.4 的漂移（`PLUGIN_VERSION` 改为从 package.json 派生 + 漂移测试）；
> ② **GATE 生命周期**：插件实例卸载（工作区被 `location services evicted`）不再关 18080，改为 `detach()`
> （清空闲连接、监听口 unref、活到引擎进程退出）—— 0.1.5 在"起服务的工作区被驱逐"时会永久断掉其它活跃工作区的代理。
> 提交 `40eeea5` + `02037f1`；公开树 `55e4966`（CI 绿）；npm `@bd7pil/reeve@0.1.6`（`Publish plugin` 绿，
> 发布后 registry 有约 3 分钟 tarball 404 复制延迟，重试即好）；ocrc pin `aa0426a4`。
> 两端（开发机 + 对端 `demo@192.168.26.101`）都已升到 0.1.6 并重跑 `accept-gate.sh` ①–⑨ **全过**；
> 对端 `reeve/fallback.jsonc` 与本地相同（config-diff：文件面 0 漂移）。
> 发布被 2026-10-22T02:33Z 起的 npm registry 故障挡住约 70 分钟（先 E503、后 OIDC 交换失败报 ENEEDAUTH），恢复后重跑同一 job 成功。
>
> **0.1.13（已发，两端已升）**：五档位 + GATE 图片路由 + 免费池只留 image 模型。
> 档位 `reeve/flash|standard|pro|manual|multimodal`（全部声明 image）；链 `reasoning`（3 付费 +
> 3 免费）/ `standard`（2 付费 + 3 免费 + deepseek 兜底）/ `free-first`（3 免费 + 3 付费）/
> `manual`（zhipu glm-5.3-flash 单目标）/ `vision`。GATE 检测 `image_url`/Anthropic image/Gemini
> inlineData，把 reasoning 的图片请求**单次**改走 vision，会话模型/composer 不变。免费池
> `require_image=true` + `image_models` 白名单，纯文本 big-pickle/minimax 不再进入。新增 hidden
> `looker` 子代理（reeve/multimodal）读磁盘图片/PDF；粘贴附件由 GATE 路由处理。xxyapi-deepseek/
> nvidia/xiaomi/alibaba-cn 从生产 fallback 移除。
> 回滚：package/provision 回 0.1.12、公开树回 `bf4897b`、ocrc pin 回上一版；将两端
> `opencode.jsonc`/`fallback.jsonc` 恢复 `.ocrc-bak`；0.1.12 的免费池不按 image 过滤，文本免费模型会重新进入。
>
> **0.1.12（已发，两端已升）**：0.1.11 的四档位/链名代码不变，只修装配清单 ——
> `plugin/provision.json` 仍写着 `0.1.10`，导致 `ocrc remote apply --with-components` 装回旧组件。
> 现在 provision 与 package 同为 0.1.12，并在 `plugin/test/unit.mjs` 加了 version/enginePlugin.spec 一致性断言。
>
> **0.1.11（已发，两端已升）**：四档位 + 策略链名。插件新增 `reeve/coding`；档位变为
> `reeve/flash`（free-first）/ `reeve/coding`（coding）/ `reeve/pro`（reasoning）/ `reeve/multimodal`（vision）。
> 链从历史编号 `tier1`/`tier2a` 改成 `reasoning`/`coding`，`multimodal`→`vision`，`default`→`fallback`。
> agent 分配按成本：planner/advisor/critic→`reeve/pro`；foreman/executor/reviewer→`reeve/coding`；
> scout/librarian→`reeve/flash`。顶层默认模型改为 `reeve/coding`，不再默认最强推理。
> 引擎配置里删掉了 8 个 agent 的直连 model 覆盖（否则会绕过 GATE）；`fallback.jsonc` 的 `agents` 段仍保留，
> 但 GATE 的 session→agent 桥没有生产调用方，实际路由按档位模型走 `chain_for_model`。
> 回滚：把 `plugin/package.json` 回到 0.1.10、公开树回 `d3bf225`、ocrc pin 回 `0b860562`，并把两端
> `opencode.jsonc` 的 `model`/`agents` 与 `fallback.jsonc` 恢复到旧版（`~/.config/opencode/reeve/fallback.jsonc.ocrc-bak`）。
>
> **0.1.10（已发，两端已升）**：真宿主保存测试抓到的两处 —— ① 面板"已生效"误报：已应用判定读快照的 `gate` 段，
> 而该段只随 60s 统计刷新，GATE 已换链、面板还说"未生效"；插件改为独立的 2s gate 状态刷新（仅签名变化时写盘；
> 复用者走环回 `/gate/version`）。② 安全保存测试本身：`scripts/host-audit.mjs --save` 备份 `fallback.jsonc` →
> 面板加临时链 → 保存 → 断言 GATE `chain_targets` 真变了 → 删链恢复，`finally` 回写备份并校验 sha256。
> 开发机 3001 与对端 4610 各跑一次：`applied/restored/gateDropped` 全 true，前后 sha256 同为 `a134a388…`，
> GATE 里临时链消失。对端那次还暴露出脚本会连到同一 Edge 里另一个 app 页的 OOPIF（把临时链写到开发机配置上，
> 已从干净副本恢复）—— 两处 target 选择都按 `appHost` 过滤后才对。
> 提交 `1a1852b` + `d3bf225`；npm `@bd7pil/reeve@0.1.10`；扩展仍 0.1.4；ocrc pin `0b860562`；报告
> `preview/host-audit/3001.json`、`4610.json`。两端在 0.1.10 上重跑 `accept-gate.sh` ①–⑨ **全过**
> （2026-10-22，开发机与对端同一份脚本）。
>
> **0.1.9（已发，两端已升）**：两处修正 —— ① OpenRouter/NVIDIA 的 `base_url` 已带 `/v1` 但 provider 没写
> `path`，GATE 打到 `/v1/v1/...` 404；用户配置与打包默认都补 `"path": "/chat/completions"`。
> ② 面板扩展 0.1.4：宿主侧栏 306px 下 `@free` 行标题被挤成一字一行 → ≤360px 隐藏次要 meta，审计加 40 号专项。
> 提交 `4036c72`；公开树 `b09a008`（v0.1.9，CI 绿）；npm `@bd7pil/reeve@0.1.9`；扩展 `reeve-0.1.4`/`reeve-latest`；
> ocrc pin `e2c8867d`。对端 apply + down/up → 组件 0.1.9/扩展 0.1.4，`accept-gate.sh` ①–⑨ 全过；开发机同版本。
> 真宿主图 `preview/host-audit/dev-3001.png` 与 `peer-4610.png` 经 multimodal **均 PASS**（对端 306px 修复后）。
> **OpenRouter key 现状**：只在对端 `~/.local/share/opencode/auth.json`（18 个 `:free` 模型被发现；
> `openrouter/recursive/flint-v1.0:free` 经 GATE 直调 200，台账 `key=auth:openrouter`）；开发机 auth.json 仍无该 key，
> 开发机免费车道只有 OpenCode 一档 —— 要在开发机启用，把 key 写进 `~/.local/share/opencode/auth.json`（或
> `opencode auth login`），GATE 会在 `/v1/models` 或重启时重读 auth。
> 0.1.9 发布后 tarball 也有约 9 分钟复制延迟（同 0.1.8）。
>
> **0.1.8（本次交付，已发，两端已升）**：GATE 原生免费车道（链里 `@free`，请求时展开）+ **9router 退役** +
> 面板 0.1.3（免费车道卡 + 39 项 UI 断言门）。0.1.8 只补一条分类：zen 对未知模型返回 400 +
> `Model is unavailable.`，按模型错误换候选（0.1.7 会把它当调用方的错、直接 400）。
> 免费车道语义见 `docs/FREE-LANE.md`。发布记录：
> · reeve 本仓：`4f57587`（0.1.7 主体）、`30872b6`（CI Chrome 沙箱/产物）、`26aa8e9`（0.1.8 分类）
> · 公开树：`47e55cb`（v0.1.7）、`f4d0855`（v0.1.8）；npm `@bd7pil/reeve@0.1.7`（run 39733303421）、
>   `@bd7pil/reeve@0.1.8`（run 39734669467）均 `Publish plugin` 绿；扩展 `reeve-0.1.3` + `reeve-latest`（run 39733326573）
> · ocrc：pin `0.1.7` → `90f9d4bc`、`0.1.8` → `6242da8b`（均已推送）
> · 开发机：引擎 0.1.8（`opencode2 service restart`）、`accept-gate.sh` ①–⑨ 全过、`accept-lifecycle.mjs` 全过、
>   真宿主 `scripts/host-audit.mjs` PASS（报告 `preview/host-audit/3001.json`：1834 字、console 0、无溢出、宿主 token 在位）；
>   9router 已 `npm rm -g`（数据目录保留）
> · 对端（demo@192.168.26.101）：组件 0.1.8（`remote apply --with-components` + `down`/`up`）、`sync-config` 已对齐、
>   `accept-gate.sh` ①–⑨ 全过、`accept-lifecycle.mjs` 全过、扩展 0.1.3、9router 已卸载（`~/.9router` 数据保留）。
>   真宿主：经 ocrc 转发 `http://127.0.0.1:4610/`、用 store 里的 uiPassword 登录（不打印）后
>   `host-audit.mjs` **PASS**（报告 `preview/host-audit/4610.json`：1770 字、console 0、无溢出、宿主 token 在位）；
>   9222 的 Chrome 会话失效不影响这条路径。
> · 回滚边界：
> · **只想关掉免费**：`fallback.jsonc` 里 `free.enabled=false`（`@free` 展开为空，链直接走付费），或把 `free.max=0`；不用回滚代码。
> · **想回到 9router 时代**：把 `9router` provider 与 `9router/oc/<model>` 候选加回配置；两台机器重装
>   `npm i -g 9router@0.5.104`、恢复 `requireApiKey=false`、自启（Windows 启动文件夹 VBS / EL7 `@reboot` cron 指向
>   `setup-9router.mjs ensure` —— 该脚本已从仓库删除，从 0.1.6 的 tag 取回）；然后 `ocrc remote config-diff` 对齐。
> · **代码回滚**：本仓 `git reset --hard 26aa8e9^`（回 0.1.7 主体）；公开树 `scripts/publish-repo.sh <ref>`；
>   扩展回 `reeve-0.1.2`；ocrc pin 回 `aa0426a4`。
> · 新增的验收：`accept-gate.sh` ①–⑨（免费车道/关闭/死候选）、`accept-lifecycle.mjs`（驱逐后 GATE 仍在）、
>   `audit.mjs --fixture` 39 项（CI 作业 `ui-audit`）、`host-audit.mjs`（真宿主断言）、每日 `upstream-models.yml` 契约哨兵。

## 1. 这次交付改了什么（回滚的边界）

| 仓库 | 提交（main，自旧到新） | 内容 |
| --- | --- | --- |
| reeve | `1b7027d` | GATE 核心（插件内代理层：路由/回退/执行/台账/目录）+ 21 项离线验收 |
| reeve | `21d9ae7` | 开发机接线 + `scripts/accept-gate.sh` + `scripts/setup-9router.mjs`（无窗口常驻） |
| reeve | `a46c1ce` | **Bifrost 退役**：删 `src/proxy.js` / `src/chain.js` / `default-chain.json` / `proxy/` / 归因脚本 + 静态守门 |
| reeve | `15f7c8b` | 面板改 GATE 配置（`fallback.jsonc`）+ 复用探针 `probeGate` + 预览 harness |
| reeve | `c386bc1` | 版本 0.1.5 + CHANGELOG |
| reeve | `eb1a37e` | 测试字面过公开树门禁（与运行无关） |
| ocrc | `08b6ebe0` | `INSTANCE_SYNC_ENTRIES += 'reeve'`（`~/.config/opencode/reeve/` 进 sync） |

**分界线**：`c93e75c` 是 0.1.4（Bifrost 那代）的最后一笔。回到它 = 回到旧世界。

## 2. 回滚步骤（按"影响面从小到大"排）

### 2.1 只回一台机器（最快，先做这个）

```bash
# ① 引擎配置改回 0.1.4 + proxy 键（在 ~/.config/opencode/opencode.jsonc）
#    plugins 里那一条改回：
#      { "package": "@bd7pil/reeve@0.1.4", "options": { "proxy": { "port": 18080 } } }
#    并删掉 "gate" 键（0.1.4 没有这一段）
# ② 重启引擎让插件换回 0.1.4
opencode2 service restart          # Windows
# EL7：对应实例的 serve 进程重启（见 ocrc 实例的启动行）
# ③ 验证：18080 上是 Bifrost 而不是 GATE
curl -s http://127.0.0.1:18080/gate/version   # 回滚成功时：不是 reeve-gate 的 JSON
curl -s http://127.0.0.1:18080/api/version    # 回滚成功时：Bifrost 的版本面
```

Bifrost 可执行体**没有删**（还躺在 `~/.reeve/proxy/`，config 与链基座也在），旧代码会直接复用它，
不会重新下载。`~/.config/opencode/reeve/fallback.jsonc` 可以留着（0.1.4 不读它）；
`~/.reeve/chain.json`（如果有）也没被动过。

### 2.2 回整个仓库（本地开发树）

```bash
cd reeve && git reset --hard c93e75c      # 0.1.4 那代
npm --prefix plugin test                  # 旧世界自己的门禁
cd ocrc  && git revert 08b6ebe0            # sync 条目（不 revert 也无害，只是多同步一个目录）
```

### 2.3 回已发布的 npm 包（发布之后才用得上）

```bash
npm i -g @bd7pil/reeve@0.1.4               # 需要全局装的话
# 或只在引擎配置里把 spec 钉回 0.1.4（插件缓存里 0.1.4 还在：~/.cache/opencode/npm/@bd7pil/reeve@0.1.4）
```
ocrc 侧：`ops/components.json` 的 `reeve.spec` 改回 `@bd7pil/reeve@0.1.4`；`provision.json` 的
`artifacts.bifrost`（旧版本里那份）随之自然生效——即"对端会重新装 Bifrost 工件"。

### 2.4 对端（EL7）

对端**在升级之前**本来就是旧世界（0.1.4 + Bifrost + 它的 `~/.reeve/proxy/bifrost-http` 都在），
所以"回滚对端"= **别升级**。若已经升级：

```bash
# 面板侧（开发机）跑 ocrc 的实例配置回推 + 对端重启，或按 2.1 的两步在对端做一遍
ocrc remote sync-config --target <user@host>
ocrc remote up --target <user@host>        # 或对应实例的重启命令
```
对端的 GATE 台账 `~/.reeve/gate.jsonl` 无需清理（新代码不读它就不影响；留着是审计线索）。

## 3. 回滚后怎么证明"真的回去了"

1. `curl :18080/api/version` 有 Bifrost 的应答，`/gate/version` 没有 GATE 的 JSON；
2. 引擎里挑一个 `reeve/<档位>` 跑一句（例：`opencode2 run -m reeve/flash "只回复：ok"`）—— 回滚成功时走旧链路；
3. `bash scripts/accept-gate.sh` **会红**（③ GATE 版本面读不到）——这是**预期的**：那条脚本断言的是新世界；
4. 新世界的产物清点：进程表无 `bifrost-http`、`~/.reeve/gate.jsonl` 不再增长。

## 4. 已知的不可逆项（回滚前先知道）

- **静态守门**（`plugin/test/guard.mjs`）会拦住"把 Bifrost 代码抄回来"——回滚走 `git reset`，不是手抄；
- **9router 的登录自启**（Windows 启动文件夹 VBS / EL7 的 unit）**与 reeve 无关**，回滚不用动它；
  不想让它常驻就删掉那个 VBS / `systemctl --user disable`；
- 开发机上 `~/.config/opencode/opencode.jsonc` 若已被 sync 推到对端，**两边一起改**才一致
  （`ocrc remote config-diff` 可以看漂移）。