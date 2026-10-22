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
> **0.1.6（待发）**：两处修正 —— ① 快照/面板版本号读成 0.1.4 的漂移（`PLUGIN_VERSION` 改为从 package.json 派生 + 漂移测试）；
> ② **GATE 生命周期**：插件实例卸载（工作区被 `location services evicted`）不再关 18080，改为 `detach()`
> （清空闲连接、监听口 unref、活到引擎进程退出）—— 0.1.5 在"起服务的工作区被驱逐"时会永久断掉其它活跃工作区的代理。
> 提交 `40eeea5` + 生命周期修正、标签 `v0.1.6`、CI 绿；npm registry 自 2026-10-22T02:33Z 起 `Package publishing` 部分故障
> （先 E503、后 OIDC 交换失败报 ENEEDAUTH），三次发布均失败。恢复后：
> `gh run rerun 39710645018 -R BD7PIL/reeve --failed`，再 `npm view @bd7pil/reeve@0.1.6 version` 确认。
> 在它发出之前：ocrc pin 与两台机器**都留在 0.1.5**（不会自动漂移）。

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