# REEVE 收尾计划（**无停点**）

## 零、这份计划的硬性质

**没有"等你批准 / 等你给信息"的停点。** 上一轮我犯的错是把"自己设的谨慎"当成"需要授权"——
你早就批准了计划、还给了 ssh。这一版里：

- 所有**决定**我取默认值，写进 `docs/PROGRESS.md` 并标 `【默认，可改】`——事后你一句话我就改。
- 所有**动作**我自己做（含 EL7 上机）。**不再回来问。**

### 我自行取的默认值（都可事后一句话推翻）

| # | 决定 | 我取的默认 | 理由 |
|---|---|---|---|
| 1 | 档位数量 | **3 档**（`reeve/flash` / `pro` / `multimodal`） | 已按此实现；`free` 当链序而非档位 |
| 2 | `limits.default` | **8** | 你实测峰值 88，无上限是失控风险；8 是保守起点 |
| 3 | 台账 `retentionDays` | **30** | 只清已落终态的记录，在飞的不动 |
| 4 | Bifrost `log_retention_days` | **30** | `logs.db` 只增不减 |
| 5 | 审查 severity 门禁 | **都不卡流程** | 规则有 Java 企业栈指纹，先跑两周看误报率 |
| 6 | 部署路径 | **先做 EL7 staging**（隔离 HOME），**不动生产**；ocrc 集成留作后续 | 隔离杠杆是 `HOME`（两端已实测）；改 ocrc 是另一个仓库的活 |
| 7 | Bifrost `setup_token` | **本机随机生成一个**，只写进 staging 的 env，不落仓库 | `/api/routing/rules` 需要它，否则 403 |

---

## 一、步 4 上机（EL7，staging，不碰生产）

**为什么用 staging**：`~/.config/opencode` 是 v1 生产引擎**正在用**的目录。
PLAN §2 说了隔离杠杆是 `HOME`，而改 ocrc 的启动行不归本仓库。
→ 我起一个**独立 HOME** 的 staging 实例，全链验证，**生产一行不动**。

### 步骤

| # | 做什么 | 验收 |
|---|---|---|
| 1 | 在 EL7 建 `~/.reeve-staging/`（隔离 HOME），把 Bifrost 二进制从 `~/.reeve-smoke/` 移进去 | 目录就位 |
| 2 | scp 传 reeve 资产：`agents/` `skills/` `plugin/` `proxy/config.json` | 文件数对得上 |
| 3 | 从 EL7 **已有的** `~/.local/share/opencode/auth.json` 读 key（**不打印、不落盘到仓库**），注入 Bifrost 的 `env.*` | Bifrost 起来且 provider 可用 |
| 4 | 起 Bifrost（**端口 18080**，app-dir = staging），设 `log_retention_days=30` + `setup_token` | `/v1/models` 返回 200 |
| 5 | 写 staging 的 `opencode.json`：`providers.reeve`（原生复数 + `package`/`settings` + **`{env:VAR}`** + `modelID`）+ `plugins` + 8 个 agent + skill | `debug config` 里出现 `document` 源 |
| 6 | 用 staging HOME 起 v2 引擎，跑一次真实调用 | Bifrost 侧收到 **`reeve/flash`** |
| 7 | **验回退**：把链头 provider 的 key 临时换成坏的 → 第二个自动接上、请求成功 | 请求成功且 `is_fallback` 为真 |
| 8 | **验归因**：查 Bifrost `logs.db` 的 `served_model` / provider | `scripts/served-model.sh` 答得出"谁真的服务了" |
| 9 | **验视觉档**：发一次带图的调用，看是否只有它走 `reeve/multimodal` | 档位分流正确 |
| 10 | 收工：停 staging 引擎与 Bifrost，**生产 :4096 全程不动** | 生产进程仍在 |

### 验收表（步 4）

| 检查项 | 标准 |
|---|---|
| 回退可靠 | 坏 key 链头 → 第二个接上且请求成功 |
| 别名稳定 | 同一会话多轮，Bifrost 始终收到 `reeve/<档位>` |
| 视觉别名 | 只有视觉调用走 `reeve/multimodal` |
| 半截流 | ✅ **已验**：opencode 不把截断流当成功，会重试 |
| 归因可查 | `served-model.sh` 能答"这 196 次 quota 错误分别是哪个 provider 撞的" |

---

## 二、步 5 控制台（openchamber extension）

**参照**：ocrc 的 `extensions/ocrc-omo-view`（已验证可行：`listProjects` → `listSessions` + `onSessions`，
`parentId` 建树，声明式注册）。

**产出** `extensions/reeve/`：
- `package.json` —— `openchamber` 块贡献 `panel`（`id: reeve`）+ `actions`
- `panel/index.html` + `src/` —— 挂载 Panel
- **只读**：读会话树 + 读插件写的台账 JSON（**同机文件桥**）
- **不做 controller**（控制面在模型侧）

**验证**：EL7 上有 openchamber 2.3.3 实例 → 把扩展装上去，看面板是否识别、能否渲染。

---

## 三、「零冲突」验收（唯一挂着的验收项）

两层验：

1. **机制层（我能独立完成）**：插件**不写** `agents.*.model`。
   - 代码层：grep 全仓确认插件代码里没有任何 `agents`/`model` 的写路径
   - 运行时：记录 `opencode.json` 的 mtime + hash，加载插件跑一轮，再比对——**必须完全不变**
2. **面板层（若 EL7 的 openchamber 能装扩展）**：在面板 Agents 页保存一次，比对配置有无被静默覆盖。

---

## 四、收尾配置

- `limits.default=8` 写进部署配置
- `retentionDays=30` 写进插件 options
- Bifrost `log_retention_days=30` + 随机 `setup_token`
- 把上述写进 `proxy/README.md` 与 `plugin/README.md` 的部署示例

---

## 五、收尾文档与提交

- `docs/PROGRESS.md` 补齐步 4/步 5 的验收记录与证据
- `docs/PLAN.md` §11 未决项全部标结（或标"为什么仍开放"）
- `docs/PLAN.md` §12 待确认项 → 改成"**已取默认值**（列出），可事后改"
- 打第二个 commit

---

## 六、明确不做

- **不碰** EL7 生产引擎（:4096）与 `~/.config/opencode`（v1 在用）
- **不改** ocrc 仓库（隔离杠杆的改动归它，我不越界）
- 不引入 omo 的任何代码或 prompt 字面（SUL-1.0）
- 控制台不做 controller；插件不写 `agents.*.model`
- 不在 EL7 上留常驻进程（staging 跑完即停；要常驻你说一声）

---

## 七、做完之后的状态

**全部验收项都有实测结论**，除了：
- 面板层「零冲突」——若 EL7 的 openchamber 装不上扩展，我会如实标"机制层已验、面板层未验"，**不假装通过**
- 步 5 的渲染效果——同上

**如果哪一步在 EL7 上真的做不下去**（例如权限、端口、网络），我会**换等价做法继续**（本地 staging / 换端口），
把卡点与替代方案写进 PROGRESS，**而不是停下来等你**。
