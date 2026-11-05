# pure 文档索引

> 对齐时点：2026-11-03（v4.1.2）。纪律：文档描述与实现冲突时，**以代码为准**；活文档要求文头带状态行 + commit 锚。已归档文档在 [`archive/`](archive/)，只作历史考据，**不得作为当前开发或更新的依据**（归档原因见 [archive/README.md](archive/README.md)）。

## 活跃蓝图（按需读，开发前对口径）

| 文档 | 状态 | 一句话 |
|---|---|---|
| [framework-reform-2026-11.md](framework-reform-2026-11.md) | 当前框架权威 | 薄 harness 审计与四期规划：四期已落（2026-11-01）；提示词/形态判定/终态验收（≈4k tk）的唯一准确口径 |
| [conversational-intelligence-upgrade.md](conversational-intelligence-upgrade.md) | 主线蓝图（1–4 期落，5 期半落，6–8 待定） | 对话智能八期：调度与止损分寸是后续候选 |
| [interjection-inline-sideline.md](interjection-inline-sideline.md) | 插话当前权威（有尾刀） | 三值 inline/sideline/new_task 二分制；P2 fold 退役待执行（insertionMessaging.ts 内有下一刀标注） |
| [network-intelligence-2026-10.md](network-intelligence-2026-10.md) | 期 1–3 落，期 4 余主体 | 路由脑接管 runRouted/镜像链/兜底链顺序 + 统一真话模板 |
| [network-layer-design-2026-11.md](network-layer-design-2026-11.md) | 设计稿（未开工，2026-11-04 拍板） | 单一 NetworkPort + 代理资源化：代理只提供健康/成本，路由按目标类与实测证据决策；含 P0–P3 分期与七项已定决策 |
| [remote-office-bridge-design.md](remote-office-bridge-design.md) | S1/S2 落，S3 未开工 | 会话=事件日志 + 单主宿主；S3 daemon 化是活蓝图 |
| [persona-core-upgrade.md](persona-core-upgrade.md) | 刀 1–9 落（双语未做） | 人格系统行为权威：Character Core → 做事/说话双投影 |
| [presentation-capability-library.md](presentation-capability-library.md) | MVP 刀落（后续刀未排期） | 表现形式库：语义卡注册表 + presentation_guide 发现工具，模型自主决策用哪种视觉形式交付 |

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

| 文档 | 一句话 |
|---|---|
| [差距分析：pure 与主流 Agent（截至 2026-10）](差距分析：pure%20与主流%20Agent（截至%202026-10）.md) | 对标差距清单（含 2026-11-02 对齐补记）与明确不追清单 |
| [two-legs-plan-2026-11.md](two-legs-plan-2026-11.md) | 双腿定位（能力供给 × 模型代际）差距判定与 W1–W5 施工计划；含可复现基线（2026-11-03） |
| [pure-positioning-audit-2026-11.md](pure-positioning-audit-2026-11.md) | 定位审计（外部视角五维差距扫描，2026-11-04） | 大部分 Phase 建议已是完成时；净增量「模型主导自进化」与 11-03 定调同向，作 P3 候选参考而非施工单 |

## 其他

- [screenshots/](screenshots/) — README 用图（UI 截图、架构对比 SVG）。

## 仓库根目录

根目录只保留：`README.md` / `README_zh.md` / `CHANGELOG.md` / `AGENTS.md` / `SIGNING.md`。历史进度日志已封账归档（`archive/改进进度记录.md`，止于 v3.4.2）；此后的进度实践 = 各设计文档内嵌 ✅ 落地标注 + CHANGELOG。
