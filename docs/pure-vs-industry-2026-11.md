# pure 4.2.2 与业界 agent 应用对照（2026-11-05）

> 状态：现役对照评估（取代一切 2026-10 及以前的差距分析，均已清理）。
> 口径：对照轴沿用 [pure-positioning-2026-11](pure-positioning-2026-11.md) 三层结构（能力层/模型层/机制层）与差异化表述；业界事实来自 2026-11-05 两路独立调研（编码 agent 格局 / 模型原生编排+harness 水位），关键条目带来源与日期。
> 取数纪律：各评测榜单 agent 脚手架与子集不同，分数不可直接横比；单源未证实的传闻不采信。

## 一、业界水位速览（2026-10~11 事实）

- **编排已下沉为模型能力**：Kimi 三代走完 100→300 子代理/4000 步并把编排写进权重（K2.5 2026-01 → K2.6 2026-04 PARL 强化学习编排器 → K3.1 Pro 2026-10-24，Terminal-Bench 4.0 65.7% 开源 SOTA）；GPT-6 Astra（2026-09-03）原生 sub-agent 工具、computer use 原生 API、24h+ 自主，system prompt 改写为 "harness-blind"；Claude Code dynamic workflows 让模型自己写 TypeScript 编排脚本（journal 记账+断点续跑）。
- **harness 没有消失，而是换位置**：Terminal-Bench 4.0 官方榜（2026-10-21）同一模型换 harness 差 7~12 分（Opus 5.5 裸 79.3 / +Fable 91.2）；Anthropic 官方结论「长任务进展靠 harness 演化而非换更强模型」「Ops 超过 intelligence」。harness 价值收窄到三类：平台通道（云/IM/多端）、验证与回放（verify/patch/replay）、环境与工具面（terminal/cloud/device）。裸 agent loop 一层价值趋零——模型自带了。
- **插话/队列成为标配交互**：Claude Code 消息优先级队列+Monitor+Remote Control 手机接管；Cursor queue+steer（coordinator 运行中连续插话不打断）；Codex CLI 语音 steer。「人类随时插话的监督者」是共同叙事，但没有一家把打断做成完整的判定语义协议。
- **上下文续航=缓存经济学**：Claude Code idle compaction 明确围绕 1 小时 prompt cache 窗口设计，subagent 间缓存共享、后台命令 3 分钟自动转后台保缓存热度；OpenAI 把 compaction 下放进 Agents API。METR 长任务公开榜最高 17h25m，内部已见 ~200h。
- **生态收敛三件套**：SKILL.md（跨 Claude Code/Codex/Cursor/Antigravity 通用）+ MCP + AGENTS.md（60,000+ 开源项目）。扩展机制层面互通后，差异化只剩 harness 行为本身。
- **头部产品格局**：Claude Code 2.1.318（agent teams/dynamic workflows/auto mode/沙箱双轨/iOS/Slack）；Codex 云持久环境+Agents API+Ultrafast 8x+GPT-6.1 Sol（1/5 价）；Cursor Projects（coordinator-worker 项目制）+手机 Voice calls 锁屏接 agent 电话；Cognition 吞 Windsurf 后做会话指挥中心（Devin Desktop 8 会话并排/Spaces 父子分组/ACP 协议/Wiki）；Copilot Fusion 按任务自动路由模型+Agent Merge 托管 PR 全程（agents 已发起 ~40% PR）；OpenClaw 39.4 万星靠渠道 20+ 与模型/harness 可插拔取胜；Cline 11M 用户押透明 harness+多 provider。

## 二、pure 的优点（经对照成立的差异化）

1. **插话交互的系统化程度业界最深**。业界的"打断"停在消息队列语义（排队/转向/优先级）；pure 是完整协议层：三值判定（inline 并入/sideline 押后/new_task 另起）→ 原话直投父引擎 → 真暂停原位续跑 → 收执 receipt 凡处置必写 → stop_branch 停支工具（v4.2.1，何时停归模型/怎么停归工具）→ 复核没结论 passthrough 不代裁（v4.2.0）。从判定、执行、停支到账目，打断是一等公民子系统而非队列特性。
2. **模型中立+失效自愈是可验证的实物，不是口号**。9+ provider 接入、按阶段模型路由、模型代际知识 manifest+端点 /models 自探测、模型失效处方链（识别「模型没了」→ 记处方 → 下回合 envFacts 送达 → 模型自己改模型库接续，v4.2.0 反转后宿主零代裁）。对照：Claude Code/Codex 绑定自家模型；Cursor Composer 自研；Cline 多 provider 但无失效自愈闭环。定位文档给模型层定的 KPI——「新模型上线到可用的小时数」——pure 有机制答案。
3. **中文 IM 渠道免公网直达是空白区占位**。飞书/钉钉/QQ/WebChat 出站 WebSocket 长连，无需公网 IP 与回调 URL，带配对门与会话仪表盘。OpenClaw 渠道最多（20+）但依赖 Gateway 部署；模型厂商集体不做中文渠道。定位文档「押中模型厂商不做的空白」在此成立。
4. **「对话窗口即交付界面」的呈现深度独一档**。chart DSL 十族图表、SVG/Mermaid/PlantUML/Leaflet 地图、html 围栏卡落盘 asset:// iframe 渲染、表现形式库七刀（机械触发/授权语义/注册化/组合式自定义/校验真话回流/投影降级三投影器）。对照：Cursor 有 Mermaid 缩放与内置 browser；Claude Code 未发现富渲染证据。且「人类观感是呈现第一设计准则」是成文准则不是风格偏好。
5. **决策边界铁律是独有的工程宪法，且已兑现**。四分归属（模型决策/系统手脚/物理不变量/契约）+准入铁律「新机制只准答怎么做成、不准答何时做」，prompt 六刀+运行时四刀（v4.2.0）+stop_branch（v4.2.1）+流超时三刀（v4.2.2，超时现场注入让模型自己裁决怎么继续）持续按判据施工。业界 harness 方法论（Lilian Weng 2026-07、Anthropic long-running harness 设计）讲架构分层，无一家有成文的「系统不许替模型决策」判据与判例库。
6. **零成本启动面**。无任何 key 即可用：免费搜索后端链（DuckDuckGo/Wikipedia/Sogou/cn.bing/360/百度+Bing→Google→Jina 兜底）+公共 API 结构化查询+本地 WASM 语义检索（无网络时关键词兜底）。业界无对标——头部产品全部要求订阅或 API key。
7. **机制层三类幸存价值全有实物**。harness 价值收窄后的三类——验证与回放（VERIFY 证据循环/15 fixture 回归门/发布 sanity 读数进 release body/replay 回放）、环境与工具面（全盘文件/命令/headless Chrome/视觉回环/大文件 append 分段）、失败事实注入（失败阶梯 retry→reflect→degrade→stop+死路识别+失败记忆全账+流超时现场注入）——pure 在三类上均有机械实现。

## 三、pure 的差距（按严重度排序）

1. **模型原生编排的代际风险（最大）**。编排正在从 harness 下沉为模型能力：Kimi 把编排写进权重、GPT-6 Astra 原生 sub-agent+「harness-blind」、Anthropic dynamic workflows 模型自己写编排脚本。pure 的编排仍是宿主结构化形状——委派工具、branches 账本、stop_branch。stop_branch 已把「何时停」交还模型，但「开不开、开几个、怎么分工」的裁决面仍由宿主委派语义持有。定位文档 §6.2 风险三已预判（「宿主硬编排会从资产变负资产，对策=只管资源/隔离/权限/账目/回收，裁决权交模型」）——方向已定，编排面整体尚未走到「模型自主开 agent」形状，需要方向性跟进而非修补。
2. **缓存经济学缺动态闭环**（2026-11-05 代码调研修正：静态层已系统化，原文「无系统设计」表述有误）。pure 的静态结构层已系统——稳定前缀/变动尾纪律有注释+判例+测试钉住（「非可视请求的系统提示词是可视请求的前缀」）、system prompt 会话级冻结、conventions/envFacts 下沉 user turn（2026-10-27 P2，注释直书保缓存前缀动机）、anthropic 协议显式 cache_control 断点、GUI 闲时 soft 预压缩（85% 触发 shed 到 70%）。真实缺口在动态经济层：cacheHit/Miss 只落盘展示零决策消费（实测判例：GLM 端点连续全 miss+TTFT 12.1s vs DeepSeek 74% 命中+4.3s，无机制承接）、CLI 无闲时预压缩、无 cache-TTL 时间维度、父↔子代理 prompt 零共享、L2 压缩一压全窗 miss。对国内中转与长会话场景，这是直接的成本与延迟差距。
3. **harness 价值无公开量化**。官方榜已把 harness 当一等公民维度（模型+harness 成对发布，同模型换 harness 差 7~12 分）；pure evals 是自建 15 fixture——诚实但只对自己说话，没有「同一模型 pure vs 裸 loop」的对照读数，无法量化 pure harness 的增益，也无法在换代期证明「pure 让新模型更快可用」。定位 KPI「评测区分度」只有内部件。
4. **多端与远程面缺位**。Cursor 手机 Voice calls 锁屏接 agent 电话、Claude iOS+Remote Control 远程接管本机会话、Codex 云任务手机接续、OpenClaw 全端原生 app。pure 有 WebChat 会话仪表盘+IM 渠道，但无原生手机端、无远程接管、无语音输入。「从手机看着家里/办公室的 agent 干活」这条共同叙事 pure 只覆盖了一半（看得见，接不管）。
5. **长任务水位无实测锚**。METR 公开 17h25m/内部 ~200h、Opus 5.5 宣称 >4 天自主——pure 无对应的长任务实测读数；流超时三刀（v4.2.2）修的是「单次请求级」续航，回合间续航（预算跨度、压缩调度、checkpoint 频率）没有水位数据。
6. **生态标准的双向兼容不完整**（2026-11-05 代码调研修正：AGENTS.md 自动读取已存在，原文「未作为读取源」表述有误）。SKILL.md 通用格式 pure 已兼容（npx skills 生态+自装自验）✓；MCP ✓；AGENTS.md 三层自动读取已实现（2026-08-29 起，app/global/workspace 按 heading 覆盖合并，GUI/CLI 双面接线，并已为保缓存前缀做 user-turn 下沉）。真实缺口收窄为：渠道面 prompt 组装有 conventions 入参但调用方未传（飞书/钉钉/WebChat 实际不注入）、不支持 CLAUDE.md 等别名文件、仅扫根目录不做子目录递归——社区互认面差最后一段线。
7. **沙箱缺位是有意取舍，但需定期重申**。业界「分类器自动批+沙箱」双轨推进；pure 按 2026-09-17 决策不做安全加固、沿「设置即用户意志+语义放行」路线。这不是疏漏而是定位（不做清单在案），但企业/共享设备场景会被此挡住——pure 不做企业，故记为「已知的边界」而非「欠账」。
8. **自进化闭环的归因回滚段仍是短板**（pure 自己在定位文档承认的）：记忆/技能/路由四类经验都有「写下→检索到」，「指标改善→可归因可回滚」只有 eval:baseline 一个粗锚。业界对照：Anthropic managed agents 的 Patch 幂等回放、Claude Code journal+rerun 断点续跑都已是产品化形态。

## 四、行动含义（按定位文档预演的方向，供排期参考，不做即期施工单）

- **编排收缩职责**（对应差距 1）：继续沿「宿主只管资源/隔离/权限/账目/回收」收缩——下一刀方向是委派触发与分工裁决交还模型（模型自主开支），宿主只保留账本与停支。开工前过四分归属表。
- **缓存窗口对齐**（对应差距 2）：压缩与注入时机对齐 prompt cache 窗口是纯机制工程，符合「运行时不能薄」——可立项，不需要模型参与裁决。
- **harness 自证**（对应差距 3）：建「同一模型 pure vs 裸 loop」内部对照档（复用 eval:baseline 骨架），先自证再谈公开榜。
- **惯例兼容收口**（对应差距 6）：AGENTS.md 自动读取已存在，原行动作废；余下=渠道面 conventions 接线 + CLAUDE.md 别名 fallback（同层 AGENTS.md 优先），小刀两件。

## 五、取数口径说明

- 评测分数来自不同榜单与脚手架（tbench.ai 官方 / swebench.com 官方 / vals.ai / benchlm），不可直接横比；本文件只引用「同模型换 harness 的分差」与「趋势」两类可比事实。
- 「Claude Opus 5.5 mini-SWE-agent 97%」为 vals.ai 口径（2026-09-01），与官方 swebench.com 的 83.2%（2026-10-27）口径不同。
- Kimi K3.1 Pro 独立官方发布页未直接核到（经 K3.1 报道与 Elo 页转述）；Gemini 4 Carbon 未见 Google 官方页（仅媒体转述）；「Cursor 归入 SpaceX」单源未采信。
- 中文生态（扣子/智谱/通义）2026-10~11 无单点新品事件检出，对照取其平台形态而非版本事件。
- 完整事实清单（含全部 URL 与日期）见 2026-11-05 调研底稿（本会话 transcript 可考）。
