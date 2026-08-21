# 长任务自动续跑（Auto-Continue）设计文档

> 状态：已定稿并实现（v1.9.14+）。设计决策：默认关闭；所有权限模式生效（confirm 模式下权限确认点即中止点）。

## 1. 背景与目标

长程任务断点审计（第 5 项）确认：引擎本身没有"计划未完继续跑"的逻辑，阶段推进兜底明确写"回复「继续」开始下一阶段"。只要用户不回复，任务永远停在阶段边界——这是"没有持续执行下去"的总根源。

**目标**：在用户首条指令后，复杂计划任务可以自主跑完多个阶段，消除"每阶段边界必须人工回复"的结构性断点。

**边界**：只作用于复杂计划任务（`activeComplexPlan` + 聊天计划卡）；不改变普通对话；默认关闭，关闭时行为与现状完全一致。

## 2. 配置开关

- `PureConfig.autoContinue: boolean`（默认 **false**）
- `PureConfig.autoContinueMaxRounds: number`（默认 **8**）
- `configVersion` 12 → 13
- Settings → General 新增「长任务自动续跑」开关（`#cfg-auto-continue`），复用 `#cfg-streaming-render` 的 apply/collect 模式。
- 开关下方暴露「单条消息最大续跑轮数」（`#cfg-auto-continue-rounds`，1–20，默认 8，仅开关开启时显示）——`autoContinueMaxRounds` 不再是隐藏字段。
- 关闭时：与现状完全一致（每阶段边界照旧"回复继续"），零回归。

## 3. 触发条件（每轮结束后同时满足才排程下一轮）

1. 本回合是复杂计划任务（`planCard` 存在）；
2. 回合干净收尾：`Completed` 且非 interrupted、`gen === this.generation`、无 pause、无 review 决策挂起；
3. 末句不是问句（`turnAsksForInput` 为 false）——模型在提问时绝不自动续；
4. 本轮有真实进展：至少一个**成功**工具（`hasToolSuccess`），或计划位置前移（plan/todo 编号变大）——停滞检测兜底；
5. 未到终态：计划未 `completed`（`activeComplexPlan` 仍在）、交付门禁未失败（`needsDeliveryGate && !qualityPassed` 为 false）；
6. 无待批准权限提示：权限确认期间 `streaming` 保持 true（for-await 在等工具调用），触发检查天然不会误触发。

## 4. 中止语义

- **共用同一个中止面**：自动轮与人工轮共用 `this.abortController` + `cancel()`。Stop 按钮/Escape 随时掐掉正在跑的自动轮；gap 期间中止则清除排程。
- **惰性 token 排程**：不在 setTimeout 里直接调 `send('继续')`。`AutoContinueScheduler` 用自增 token 管理生命周期——每次 `cancel()` 使旧 token 失效并清掉定时器；触发时复查 token 仍有效。
- **排程发生在 send() 收尾**：`Completed` case 只记录 `pendingAutoContinue` 信号；`send()` 的 finally（`setStreaming(false)`、持久化完成、`releaseSupersededTurn()` 之后）才真正排程。这样：
  - gap 期间 `streaming === false`，触发检查不会误判；
  - 若持久化耗时超过定时器，也不会在 streaming 仍为 true 时触发；
  - 被新 send 取代（`ownsTurn === false`）时不再排程——链由新回合接管。
- **人永远赢**，以下事件一律清除排程（`autoContinue.cancel()` 全量重置轮数预算）：
  - 用户在任一 composer 输入（main.ts input 监听 → `chat.cancelAutoContinue()`）；
  - 用户发送新消息（send() 入口 `!isAuto` 时 cancel）；
  - Stop / Escape（`chat.cancel()`）；
  - 切换会话 / 新建对话 / `clear()`；
  - 配置被改回关闭（触发时复查 `loadConfig()`，关闭则不续）。
- **自动轮标记**：自动轮调用 `send('继续', [], '🔁 自动续跑 N/M：继续处理计划 X', true)`——模型侧收到干净的"继续"（continuation 分支会构建完整续跑提示），界面侧用户气泡显示 🔁 标记并带轮数可视提示（`N/M`，N 为已触发的自动轮序号，M 为 `autoContinueMaxRounds`）；`isAuto` 参数保证不重置轮数预算。
- **计划卡实时徽标**：链运行期间计划卡头部显示「自动续跑中 N/M」徽标（`plan-progress-auto-continue`，脉冲圆点 + 文案），由 `chat.ts` 通过 `PlanCardHandle.setAutoContinue` / `clearAutoContinue` 驱动：`fireAutoContinue()` 开跑时点亮，`send()` 收尾排程下一轮时推进为 `(roundCount+1)/M`，链结束（终态 / 触顶 / 停滞 / 配置关闭）或用户接管（Stop / 输入 / 新发送）时熄灭。`updatePlanCard` 原位重建卡片时保留徽标状态，续跑轮不会把指示器冲掉。

## 5. 循环保护

- **轮数上限**：`autoContinueMaxRounds`（默认 8），触顶即停。
- **停滞检测**：无成功工具且计划位置未前移的回合不排程——模型原地打转时链自然终止。
- **终态不续**：计划完成 / 交付门禁失败 / 等待态（pause）均不排程。
- **权限确认点即中止点**：confirm 模式下权限提示挂起时 `streaming` 保持 true，链不会在提示期间触发；用户批准后回合继续，回合正常结束后再评估是否续跑。用户拒绝 → 工具失败 → `hasToolSuccess` 为 false → 链停止。
- **请求解析**：`schedule()` 在同一轮多次调用只会保留最后一次（token bump）。

## 6. 实现落点

| 文件 | 改动 |
| --- | --- |
| `src/ui/autoContinue.ts` | 新增：`AutoContinueSignals` 类型 + `AutoContinueScheduler` 纯逻辑（排程/取消/停滞检测/轮数预算）+ `roundCount` getter（供界面显示轮数） |
| `src/ui/plan.ts` | `PlanCardHandle` 新增 `setAutoContinue` / `clearAutoContinue` / `autoContinueState` / `autoContinueEl`；创建时渲染隐藏徽标，`updatePlanCard` 保留并重放状态 |
| `src/ui/config.ts` | `autoContinue` / `autoContinueMaxRounds` 字段、defaults()、configVersion 13 |
| `src/ui/settings.ts` | `#cfg-auto-continue` / `#cfg-auto-continue-rounds` 的 autosave 选择器、apply、collect、可见性切换 |
| `index.html` | General 页新增开关行 + 轮数上限输入行 |
| `src/shared/i18n.ts` | `general.autoContinue` / `general.autoContinue.hint` / `general.autoContinueRounds` / `general.autoContinueRounds.hint`（中/英） |
| `src/ui/chat.ts` | send() 入口 `isAuto` 参数 + 中止语义；Completed case 记录信号；finally 排程；`cancel()`/`clear()`/`setSessionId()` 清理；`cancelAutoContinue()` 公开方法；`fireAutoContinue()` 气泡带 `N/M` 轮数 |
| `src/ui/main.ts` | 两个 composer 的 input 监听挂 `chat.cancelAutoContinue()` |
| `src/ui/__tests__/autoContinue.test.ts` | 单测：触发/中止/触顶/停滞/confirm 语义 |

## 7. 验证

- 单测覆盖：正常链、轮数触顶、停滞停止、cancel 失效旧 token、提问不续、终态不续。
- 浏览器回归：`verify:plan-restore` 冒烟（确认关闭时零回归）。
- 手动：开启开关跑一个多阶段构建任务，观察自动续跑与 Stop 中止。

## 8. 风险与权衡

- **token 多轮消耗**：默认关 + 轮数上限缓解。
- **transcript 噪音**：每轮一条带 🔁 标记的"继续"用户消息，可接受；模型侧始终是干净的 continuation 提示。
- **confirm 模式**：不自动批准任何权限——确认点是硬中止点，用户批准后才继续；这是刻意保留的安全选择。
