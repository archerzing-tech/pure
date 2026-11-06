# Prompt 体系蓝图：缓存地基 + 记忆分面 + 静态面瘦身（2026-11）

状态：P1 已落地（2026-11-06,三刀),P2/P3 待施工。
输入：三源对比（pure / opencode v2.2.5 / Claude Code）、真机账本（promptTokens≈18.8k、
cacheHitTokens=0、routeMs 3003×2 撞满 3s 线）、PromptAssembler / Harness / adapter 定点取证。

## 0. 一句话诊断

pure 的静态面绝对量与两家同量级，真正差距是**没有人在守「前缀稳定」这条线**：
system 尾区有三层每回合漂移的内容（时间行、检索记忆、adaptive_context），导致
18.8k 每轮全量 prefill——「重」的体感一半来自这里，「慢」（free 池 prefill 3-6s）
的全部来自这里。

**施工前取证对诊断的修正（2026-11-06）**：GUI/CLI 均已走 `firstTurn ? run :
continueTurn` 分流,Harness §2.1 冻结链完整(continueTurn 复用 run() 首轮冻结的
sessionSystemPrompt)——「每回合打穿」不成立;真实缺口=①首回合冻结的时间行
失真(第 10 回合看到的是首回合日期,timeContext「每回合现算现注入」的设计意图
从未落地)②记忆/策略块住 system 首回合前缀,检索漂移决定跨会话前缀互不一致
③真机 cacheHit=0 是 free 池多实例轮换的 provider 物理(cache_write_tokens=0
实证),pure 侧观测链(include_usage→Rust 透传→usage.ts cached_tokens)全通。

## 1. 三个缓存打穿点（取证）

| # | 打穿点 | 位置 | 频率 |
|---|---|---|---|
| 1 | environment 时间行（formatTimeContextLine） | system 尾区 fragment（chat.ts:728/730，进 fragment 表 chat.ts:992） | 只进首回合(冻结链);跨会话前缀互不一致 |
| 2 | `<session_memory>` / `<adaptive_context>` | system 尾区（composeMemoryPrompt 产出,Harness.run 首轮冻结） | 只进首回合;检索漂移让每个会话的前缀都不一样 |
| 3 | 观测面 | OpenAI 协议路线靠 provider 自动前缀缓存；Anthropic 路线已有 cache_control（DeepSeekAnthropicAdapter） | 解析链已通,无需施工 |

## 2. 设计原则（铁律）

**凡随回合变的，一律不进 system；凡会话内稳定的，一律进 system 前缀。**

对齐两家实践：opencode 把 env 作第二 system part、AGENTS.md 变更走历史内追加
system 消息（不回写旧前缀）、指令序按缓存稳定排序；Claude Code 静态前缀刻意
稳定、动态内容全走 user turn 内的 system-reminder 注入、记忆只留一行索引常驻。

不违背既有定调：
- 「判据常驻决策点」红线：人格「怎么说」判据整并后仍**常驻 system**（不条件
  在场、机械注入），砍的是三份之间的重复，不是在场性。
- 「原则不能条件在场」：envFacts/记忆搬家后仍每回合机械注入，变的只是位置
  （system 尾区 → 消息尾部注入件）。
- 「方式方法走机制」：工具 description 里的方法论长文移到执行层机制，方向不变。

## 3. 目标消息形状

```
[system]        静态核心：原则 + 人格（整并后一份）+ 工具规则 + 输出风格 + 长尾协议
                ——会话内零变化；跨会话也几乎零变化（缓存带最宽）
[tools]         工具清单（MCP 会话内稳定；Anthropic 路线已有 cache_control 打点）
[messages …]    历史（追加式，天然增量）
[user turn N]   动态注入件打包在消息尾部：
                <task_context>（envFacts：时间行/运行时/网络/账本/observations）
                <session_memory>（本轮检索结果 k≤12，随当轮 userPrompt）
                + 用户输入
```

## 4. 刀单（六刀）

### 刀1 消息形状重组（缓存地基，治「慢」的主体）【已落地 2026-11-06】

- environment fragment 收窄为会话稳定事实（语言/城市,config 派生）；时间行与
  netNote（blockedHosts 熔断注）从 system 摘除，并入 buildEnvFacts 的
  `<task_context>`（GUI chat.ts 与 CLI cliRepl.ts 两面同步）。净收益：system
  跨会话稳定 + 时间每回合新鲜（修掉「首回合日期用到会话结束」的隐性失真）。
- composeMemoryPrompt 的产出从「拼回 system 模板」改为二元组
  `{systemPrompt, injection}`：systemPrompt=挖掉空围栏后的纯静态面；
  injection=`<session_memory>`/`<adaptive_context>` 块，随**首轮** user 消息
  进历史，后续回合靠历史看到记忆、不再重复注入（检索仍首轮一次,逐回合重检索
  挂 P3 重新裁定归因语义）。
- Harness run()（539 区）与 continueTurn 恢复路径（checkpoint 后首次 compose）
  拼接 injection 进 user 消息；sessionSystemPrompt 退化为纯静态。
  P0 棘轮 currentMemoryInjection 归因语义不变（记录首轮候选条目 ids）。
- 顺手修复：composeMemoryPrompt「选中为零」分支漏挖空围栏标签的既有 bug。

### 刀2 缓存打点与观测闭环【取证翻案:解析链已通,观测行挂 P2】

- 取证确认:Rust 请求体已带 `stream_options.include_usage`（GLM 判例）、SSE
  usage 帧原样透传、usage.ts 已解析 `cached_tokens`;openrouter 回合 1 实测
  返回 `prompt_tokens_details.cached_tokens=0`（字段存在,冷启动正常）。
  **无 Rust/TS 改动需要做**。
- free 池（nemotron:free）多实例轮换,`cache_write_tokens=0`——命中率为 0
  是 provider 物理,不可作为缓存验收面。
- 余项（挂 P2）：GUI 预算行三态加「缓存命中」位（校验真话回流判例）。

### 刀3 人格三件套整并（治「重」的主体）

character_expression（3k）+ human_tone（2k）+ output_style（2.9k）→ 一份
「怎么说」判据 ≤3k 字符。三份都在回答「怎么说」，判据互相覆盖；整并按判据
去重，红线条目（谄媚/陪伴话术负向清单、拟人语气、人类观感第一）一条不砍。
character_core（1.5k，「怎么做事」立场）保留不动。省 ≈2-3k tok。

### 刀4 core12 复核 + 工具 description 方法论搬家

- switch_package_source（1475）/ diagnose_network（1116）/ sys_info（989）退
  deferred（非每回合必需；discover_tools 已有激活通道）。省 ≈1-2k tok。
- execute_command 等塞在 description 里的方法论长文（「vehicle FIRST…token
  discipline」）移到执行层机械注入（检查器/注入件）——description 回到
  「是什么+何时用」1-3 句纪律（对齐两家实践）。

### 刀5 记忆进出分面

- 写入面不动（异步、不占临界路径；error_pattern/偏好/教训通道保持）。
- 读取面保持检索式（k=12 按当轮 query，优于全量注入与索引常驻），只挪位置
  （system → 消息尾部，刀1 承接）。
- 收益：记忆写入/检索漂移不再打穿前缀——这是「记忆系统」与「缓存系统」
  互相成自然的结合点，不是两个独立补丁。

### 刀6 长尾协议索引化（低优先）

insertion_protocol（482）+ ledger_protocol（726）常驻改按需（插话发生时经
注入件送达）。省 ≈700 tok。风险：在场性红线——插话判定是引擎机械链，不依赖
模型先读协议则可索引化；施工前先验证判定链不消费这两段。

## 5. 分期与验收

| 期 | 刀 | 验收判据 |
|---|---|---|
| P1 治慢【已落地】 | 刀1+刀2 | 双门禁绿（tsc + 5135 测试）；契约断言：system 不含时间/熔断/记忆锚、同会话两回合 system 逐字节同、注入块只在首轮 user 消息出现。**缓存命中验收换面：GLM/DeepSeek 付费端点同会话第 2 回合 cacheHitTokens>0（有 cacheHitPerM 价目的端），free 池只作尽力而为档不验收** |
| P2 治重 | 刀3+刀4+观测行 | 静态面 promptTokens（hello 首回合）≤14k；人格红线用例全绿；GUI 预算行三态加缓存命中位 |
| P3 收尾 | 刀5 余项+刀6 | 逐回合记忆重检索（需先裁定 P0 棘轮归因语义）;插话行为真机复验不回归 |

判例对齐：
- 测试形态=全量 bun test + tsc 双门禁；消息形状属发送链契约，契约测试同步改。
- 部署验证=特征串锚（ASCII 优先）+ Info.plist；缓存行为真机复验看
  cacheHitTokens 逐轮增量，不跟体感锚。
- 老会话兼容：存档消息数组形状不变（改的是 system 与注入件拼装，不动历史）。

## 6. 影响面（施工时逐刀复核）

PromptAssembler（composeMemoryPrompt 产出形态）、Harness（539/722 两处）、
chat.ts（fragment 表 992、send 链注入件拼装）、buildEnvFacts（吞并 environment
四件事）、adapter（Anthropic 打点验证）、promptObservability（观测行）、
promptLayers/character（三件套整并）、toolDefs（core12+description 瘦身）、
契约测试（发送链形状断言）。
