# 归档文档（archive/）

> 本目录收存已收官、被取代或已断流的文档，**只作历史考据，不得作为当前开发或更新的依据**。任何与现状冲突的陈述一律以代码与 [docs/ 活文档](../README.md) 为准。
> 归档时点：2026-11-02（v4.0.2）。各代快照口径：2026-08 文档组自称 v1.9.2；《技术深度版》文章钉死 v2.2.5（2026-09-16）；改进进度记录止于 v3.4.2（2026-10-29）；当前 v4.0.2。

## 为什么归档（按组）

### 2026-08 参考实现规范组（v1.9.2 同代）

`Adapter Layer 设计文档` / `Agent-Event-Loop Engine 设计文档` / `Coding Agent 设计文档` / `Harness 设计文档` / `pure Spec` / `三层依赖关系总结`

早期 Phase 参考实现规范。分层思想已被实现吸收，但细节多处与现状矛盾，照它们动工会重复造轮子：Adapter「待实现」清单错位（ShellToolAdapter/SandboxToolAdapter 实际另有落点、WASMSQLiteStore 从未存在）；三层依赖的 monaco/xterm 依赖清单从未落地；Harness §3.2 压缩契约与 pure Spec §3.3 现行契约互相打架。canonical 类型契约已正式归 `src/shared/types.ts`（代码即契约，原 "per pure Spec §4" 注释指针已改）。

`system-prompt.md`

曾是 L0 system prompt 的人读镜像，2026-09-10 起同步已断——仍在教产品已刻意反转的行为（"ask before doing" vs 现行「按权限模式行事，不自行加码确认」），且缺人格三件、envFacts 位置过时。`src/shared/promptLayers.ts` 是运行时唯一事实源（镜像职责已解除）。

### 设计收官组（文头自证全落，历史信息已入 CHANGELOG / 后继蓝图）

`capability-self-extension-design`（13.1–13.4 全落）、`step6-closing-mvp`（T1–T4 全落）、`team-observability-design`（T1–T4 落；唯一遗留「瓶颈视图接 UI」应另立项，不该靠本文尾部状态行续命）、`self-evolution-welding-plan`（P0–P3 全落）、`subagent-pause-resume-design`（一二期落，三期明标可不做）、`channel-projection-design`（投影管线全落）、`long-text-attachments`（粘贴转 chip 全落）、`persona-core-audit`（审计结论已回灌蓝图正文）。

### 被取代组（取代链）

- **插话链**：`dynamic-insertion-design`（v1 七类）→ `insertion-redesign-v2`（v2 九类+holdGate，已随刀 B 整件退役）→ 现役 [interjection-inline-sideline](../interjection-inline-sideline.md)（三值二分制）
- **提示词/框架链**：`system-prompt-comparison` + `system-prompt-layer-audit`（调研输入）→ `system-prompt-layer-improvement-plan`（计划）→ `framework-reform-2026-10`（施工权威让位；注意其刀 4/刀 5 在实码中未执行，勿据此以为已删）→ 现役 [framework-reform-2026-11](../framework-reform-2026-11.md)
- **多 agent 链**：`multi-agent-design`（2026-08 草稿）→ 现役 [multi-agent-self-evolving-architecture](../multi-agent-self-evolving-architecture.md)（北极星宪法）
- **网络链**：`网络自愈出口 设计文档`（自称「设计定稿待实施」，实为最高重复施工风险的一份——修路方案〔socks 桥/DoH 拨号/代理收编〕已被 [network-intelligence-2026-10](../network-intelligence-2026-10.md) 路由脑立场反转否决，两者无继承关系）
- **执行效率**：`execution-efficiency-upgrade`（其自身附-5 交叉评审推翻正文约半数刀，单读正文会得出已作废结论）
- **复杂任务**：`complex-task-execution-redesign`（期 1/2/4 落；期 3 控制行解耦需单独立项，已被框架改革口径吸收）
- **进化早期**：`自我进化系统设计`（被北极星 + welding-plan 接替）、`改进路线图（最小步骤版）`（执行完毕的计划书）、`改进进度记录`（官方执行日志正式封账，止于 v3.4.2/2026-10-29；此后进度实践 = 各设计文档内嵌 ✅ 落地标注 + CHANGELOG）

### 历史分析 / 文章组

`差距分析：pure 与主流 Agent（截至 2026-08）`（被 [docs/ 截至 2026-10 版](../差距分析：pure%20与主流%20Agent（截至%202026-10）.md) 接续）、`从零构建一个沉浸式通用 AI Agent` ×2（对外文章，口径快照：47 天 54 版 / v2.2.5）、`model-config-variants.html`（2026-08 多模型配置 UI 设计稿）。
