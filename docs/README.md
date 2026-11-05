# pure 文档索引

> 对齐时点：2026-11-05（v4.2.1）。纪律：文档描述与实现冲突时，**以代码为准**；活文档要求文头带状态行 + commit 锚。已归档文档在 [`archive/`](archive/)，只作历史考据，**不得作为当前开发或更新的依据**（归档原因见 [archive/README.md](archive/README.md)）。

## 活跃蓝图（按需读，开发前对口径）

| 文档 | 状态 | 一句话 |
|---|---|---|
| [decision-boundary-2026-11.md](decision-boundary-2026-11.md) | 铁律权威（v4.2.0 起） | 四分归属判据（模型决策/系统手脚/物理不变量/契约）+ 准入铁律 |
| [framework-reform-2026-11.md](framework-reform-2026-11.md) | 当前框架权威 | 薄 harness 审计与四期规划：四期已落（2026-11-01）；提示词/形态判定/终态验收（≈4k tk）的唯一准确口径 |
| [conversational-intelligence-upgrade.md](conversational-intelligence-upgrade.md) | 主线蓝图（1–4 期落；5–8 期候选，开工前需按决策边界重裁） | 对话智能八期：调度与止损分寸是后续候选 |
| [interjection-inline-sideline.md](interjection-inline-sideline.md) | 插话当前权威（有尾刀） | 三值 inline/sideline/new_task 二分制；P2 fold 退役待执行（insertionMessaging.ts 内有下一刀标注） |
| [network-intelligence-2026-10.md](network-intelligence-2026-10.md) | 期 1–3 落，期 4 余主体 | 路由脑接管 runRouted/镜像链/兜底链顺序 + 统一真话模板；GitHub 加速默认智能 auto 已落（v3.5.4） |
| [network-layer-design-2026-11.md](network-layer-design-2026-11.md) | 设计稿（未开工，2026-11-04 拍板） | 单一 NetworkPort + 代理资源化：代理只提供健康/成本，路由按目标类与实测证据决策；含 P0–P3 分期与七项已定决策 |
| [remote-office-bridge-design.md](remote-office-bridge-design.md) | S1/S2 落，S3 未开工 | 会话=事件日志 + 单主宿主；S3 daemon 化是活蓝图 |
| [persona-core-upgrade.md](persona-core-upgrade.md) | 刀 1–9 落（双语未做） | 人格系统行为权威：Character Core → 做事/说话双投影 |
| [presentation-capability-library.md](presentation-capability-library.md) | 刀 1–6 全落（刀 5 真机复验待用户） | 表现形式库：语义卡注册表 + presentation_guide 发现工具，模型自主决策用哪种视觉形式交付 |
| [pure-vs-industry-2026-11.md](pure-vs-industry-2026-11.md) | 现役对照评估（2026-11-05） | pure 4.2.2 与业界 agent 水位对照：七项差异化优势 + 八项差距（按严重度）+ 行动含义 |
| [presentation-pack-blueprint-2026-11.md](presentation-pack-blueprint-2026-11.md) | 设计稿（未开工，2026-11-05 裁定可行分期） | 表现形式包化：一期文本形态包（扫描装载+create 技能，零沙箱）+ 二期沙箱渲染器（挂账等真需求） |

## 活参考（宪法 / 行为规格 / 操作手册）

| 文档 | 一句话 |
|---|---|
| [pure-positioning-2026-11.md](pure-positioning-2026-11.md) | **定位表述权威**：一句话定义、三条原则、三层结构、不做清单与走偏信号（2026-11-05 定稿） |
| [multi-agent-self-evolving-architecture.md](multi-agent-self-evolving-architecture.md) | 多 agent × 自进化北极星（防缠三原则），上游宪法 |
| [session-persistence-and-transcript.md](session-persistence-and-transcript.md) | 会话持久化与界面转录架构（V3 快照 + 事件日志） |
| [auto-continue-design.md](auto-continue-design.md) | 长任务自动续跑行为规格 |
| [channel-gateway-design.md](channel-gateway-design.md) | 通道网关总体架构（未落部分见文内状态行） |
| [cn-im-channels.md](cn-im-channels.md) | 飞书/钉钉/QQ 已落，企微仍是设计稿 |
| [channel-setup.md](channel-setup.md) | 通道对接操作手册 |

## 分析与改进计划

> 注记（2026-11-05）：10 月及以前的对比评估文档已清理（git history 可考），现役对比评估为活跃蓝图区的 [pure-vs-industry-2026-11.md](pure-vs-industry-2026-11.md)；旧档中仍有效的未落项：瓶颈视图无 UI 消费者、父回合 checkpoint 未实现、CLI 插话输入路未接（cliHarness.ts:542）。

| 文档 | 一句话 |
|---|---|
| [two-legs-plan-2026-11.md](two-legs-plan-2026-11.md) | 双腿定位（能力供给 × 模型代际）差距判定与 W1–W5 施工计划；含可复现基线（2026-11-03） |
| [pure-positioning-audit-2026-11.md](pure-positioning-audit-2026-11.md) | 定位审计（外部视角五维差距扫描，2026-11-04） | 大部分 Phase 建议已是完成时；净增量「模型主导自进化」与 11-03 定调同向，作 P3 候选参考而非施工单 |

## 其他

- [screenshots/](screenshots/) — README 用图（UI 截图、架构对比 SVG）。

## 仓库根目录

根目录只保留：`README.md` / `README_zh.md` / `CHANGELOG.md` / `AGENTS.md` / `SIGNING.md`。历史进度日志已封账归档（`archive/改进进度记录.md`，止于 v3.4.2）；此后的进度实践 = 各设计文档内嵌 ✅ 落地标注 + CHANGELOG。
