# REEVE

**在 opencode v2 上自有的多智能体编排层。**

REEVE 管三件事，这三件事合起来就是它的名字：

| 干什么 | reeve 的历史含义 |
|---|---|
| 把活派给不同的专家 agent | 派工 |
| 自持子任务台账，知道谁在跑、谁死了 | 管账 |
| 不接受 subagent 自述，亲自拿产物验收 | 验活 |

（shire reeve → sheriff：监督并管账的地方官。）

## 为什么需要它

被控端从 **opencode v1 + `oh-my-openagent`(omo)** 迁往 **openchamber + opencode v2**，
而 **omo 在 v2 上加载即失败，且上游明确拒绝移植**（issue #9389，维护者原话：
*"We are not taking the full port into this repo… the full omo experience is shipped as OmO Native."*）。
omo 在 v2 上拿到的全部支持是"加载 + 每次启动弹一个指向 OmO Native 的广告"（PR #10439，4 个文件）。

于是**不 fork**，改为把四件事拆成四层，各用各的许可：

```
代理层   跨 provider 回退        Bifrost（Apache-2.0）      与引擎版本无关，永不腐烂
编排层   调度纪律 / 四阶段流程    prompt + agent 定义（自写）  机制 v2 原生给足，这层是文本
记账层   台账 / 静默死亡 / 并发    本仓库的 opencode plugin     v2 只缺这八条
审查层   代码 diff 独立审查       吸收 OCR 的规则（Apache-2.0） 不装工具，抄 rubric
```

## 读什么

> **本项目的读者是从零开始的执行 agent。** 开工前先读 **[docs/PLAN.md](docs/PLAN.md)**
> ——它给出组件与所有权、实施顺序（步 0→5）、每步的硬门槛。
> **[docs/HANDOFF.md](docs/HANDOFF.md) §15（执行协议）** 给出最小必读集、必须问使用者的四件事、不许跨过的红线。
> **写代码前必读** **[docs/research/opencode-v2-plugin-api.md](docs/research/opencode-v2-plugin-api.md)**
> ——v2.0.32 插件 API 的实测施工图；**HANDOFF §6.1 的旧挂载点写法已被它取代**。

| 想干什么 | 读 |
|---|---|
| **开工（先读这个）** | **[docs/PLAN.md](docs/PLAN.md)**（组件与所有权 / 步 0→5 / 硬门槛） |
| 写插件前 | **[docs/research/opencode-v2-plugin-api.md](docs/research/opencode-v2-plugin-api.md)**（v2 API 实测施工图） |
| 理解全貌与所有决策依据 | [docs/HANDOFF.md](docs/HANDOFF.md)（16 节；**注意标了"勘误"的段落**） |
| 看做到哪了 | [docs/PROGRESS.md](docs/PROGRESS.md)（每步验收记录） |
| 查一手证据 | [docs/research/orchestration-stack-verdict.md](docs/research/orchestration-stack-verdict.md)（归档，**若干条已被取代**） |
| 引入外来内容前 | [NOTICE.md](NOTICE.md)（许可边界） |

## 状态（2026-10-19 晚）

**步 0–6 全部产出完成，并已在 EL7 上跑完整轮实机验收**（隔离 `HOME` 的 staging；生产 v1 引擎全程未动）。

| 步 | 产出 | 实机验收 |
|---|---|---|
| 0 | 计划 / 施工图 / HANDOFF 勘误 | — |
| 1 | `agents/*.md` 8 个 agent（7 个 subagent 标 `hidden`） | ✅ 权限闸门、验收独立性、多轮评审；**前台只可见 `foreman`** |
| 2 | `plugin/` 记账层（**115** 项测试） | ✅ 并发排队 / 墙钟中断 / 跨重启对账 / 台账落账与读回 / **名册补进 `subagent` 工具描述** / **代理自持（纯插件形态）** |
| 3 | `skills/review/` 审查层 | ✅ 真 diff 抓到、带行号、结构化输出 |
| 4 | `proxy/` Bifrost 链 + 部署脚本 + **收敛脚本** | ✅ 档位分流 / 回退 / 视觉档 / 归因（**12 处配置级问题按实测修正**） |
| 5 | `extensions/reeve/` 只读控制台 | ✅ 真装进 openchamber 2.3.3、真渲染、台账经宿主文件桥读到 |
| 6 | `config/` 引擎样板 + 前台可见性 + 同步语义 | ✅ 见 [PROGRESS.md](docs/PROGRESS.md) §6（含四组 Bifrost 同步实验） |
| 6.6 | **纯插件形态**：代理归插件自持 + **配置瘦身** | ✅ 取件/拉起/复用/守护全在插件里；**配置只剩「两行端点 + 一行插件」**；EL7 全新机器模拟实测（无脚本、无 VK、无 ocrc） |

**四处关键未知已实测解决**：opencode v2 忽略响应体的模型名（→ 代理可用虚拟别名，但**引擎侧永远看不到真服务模型**）；
v2 插件 API 的真实形态（钩子真名、**`codemode:false` 才是工具可见性开关**、存储键是 `plugin:<hex(id)>:` …）；
**agent 可见性的三个开关**（`mode` / `hidden` / `disabled`）与 openchamber 的两条直达路径（composer 选 primary、`@` 提及列非 primary 且非 hidden）；
**v2 的 provider 传输层钩子能替换请求**（`http.request`/`retry`，见 PROGRESS §6.5）。

**仍开放的一项**（如实标着，不冒充通过）：
**审查 subagent 的误报率** —— 按默认"severity 都不卡流程"跑两周再统计。

> 「零冲突」两层都已验：**机制层**（插件无 `agents`/`model` 写路径；引擎配置 mtime/hash
> 在 6+ 轮会话后不变）+ **面板层**（在 EL7 的 openchamber 的 Agents 页真保存一次：
> 只新增一个 user 作用域 agent md，`opencode.jsonc` / `opencode.managed.json` / staging 配置
> **逐字节未变**；缺项目上下文时是 400 + 界面报错，不是静默）。见 [PROGRESS.md](docs/PROGRESS.md) §5.5。

**下一步的活（都在别的仓库）**：
1. 配置目录隔离（杠杆 = **`HOME`**，两端已实测）落进 ocrc 的实例启动行；
2. **Bifrost 的取件/启动/守护**已在 ocrc 工作区写好并实测（[PROGRESS.md](docs/PROGRESS.md) §6.4），**待你提交**；
3. 引擎侧的 `REEVE_VK` 注入（setup token → VK 建/轮换 → 注入 serve 行）是 §6.4 记的下一片。

> 上机踩到的坑（**各自都是静默失败**：配置合法、能加载、只是必然出错）与逐条证据：
> [docs/PROGRESS.md](docs/PROGRESS.md) §4.4（12 条）+ §5.3。

## 命名派生

```
品牌        REEVE
机器标识    reeve
npm 包      @bd7pil/reeve          插件
扩展目录    extensions/reeve        panel.id = reeve
台账        ~/.reeve/ledger.json
配置        ~/.config/opencode/reeve.jsonc（用户级）/ .opencode/reeve.jsonc（项目级）
发布资产    reeve.zip
tag         reeve-<ver> / reeve-latest
```

## 许可

本仓库自写的代码自行决定。**但有两处外来内容必须随行声明**：

- 抄自 **`oh-my-opencode-slim`（MIT）** 的记账实现 → 带上其 `LICENSE`
- 抄自 **`alibaba/open-code-review`（Apache-2.0）** 的规则文档 → 带上其 `NOTICE`/`LICENSE`

**绝不可引入 `oh-my-openagent` 的任何代码或 prompt 字面**——它是 SUL-1.0，不可再授权、永久。
详见 [docs/HANDOFF.md](docs/HANDOFF.md) §10。
