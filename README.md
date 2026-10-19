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

## 状态（2026-10-19）

- 设计已定案，**尚未写任何代码**
- **步 0 完成**：计划已落成文档（PLAN 重写 / v2 插件 API 施工图新建 / HANDOFF 勘误 6 处）
- **两处关键未知已实测解决**：
  1. opencode v2 忽略响应体的模型名 → 代理可用虚拟别名（verdict §2.6 / §8.3）
  2. **v2 插件 API 的真实形态**（钩子真名、工具注册、namespace 陷阱、`session.idle` 仍存在）
     ——见 [施工图](docs/research/opencode-v2-plugin-api.md)
- **Phase 0（修 v1+omo 配置）已整体删除**——那是正在被 reeve 替换的系统的配置，修它是白做
- **步 1（编排层）可开工**，但前置是 §2 的配置目录隔离（归 ocrc）

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
