# 动态信息插入与任务重评估设计

> 状态：第一版已实现（v2.1.0-beta）。本文只描述当前运行时代码已经具备的行为，不把未来规划写成已完成能力。

## 1. 目标

用户在 Pure 正在执行任务时，可能继续输入新的信息。系统必须避免两种错误：

- 把完全无关的新请求硬塞进当前任务，导致上下文混乱。
- 把会改变目标或约束的反馈当成普通新任务，继续沿用已经不合适的策略。

当前入口是 GUI 的 `ChatController.interject()`，协调逻辑位于无 DOM 的 `DynamicInsertionCoordinator`，便于独立测试。

## 2. 当前决策模型

```text
用户插入信息
    ↓
DynamicInsertionCoordinator.decide()
    ↓
┌──────────────────┬─────────────────────┐
│ 无关请求         │ 相关信息            │
│ unrelated        │                     │
│                  │                     │
│ 进入 pendingTasks│ supplement           │
│                  │ constraint-change    │
│                  │ goal-change          │
│                  │ stop                 │
└──────────────────┴─────────────────────┘
```

### 2.1 `unrelated`

分类器认为新消息与当前任务无关时：

- 不中止当前执行。
- 写入 `pendingTasks`。
- 显示“已排队”状态。
- 当前任务结束且没有自动续跑等待后，再作为独立任务发送。

### 2.2 `supplement`

相关但没有明显改变目标或硬约束的补充信息：

- 保存为 `relatedInsert`。
- 中止当前回合。
- 当前回合收尾后重新发送，并让模型结合原任务、已有历史和新信息继续处理。

### 2.3 `constraint-change`

包含必须、不能、兼容、支持、增加/移除等约束变化信号时：

- 中止当前回合。
- 保留插入内容。
- 下一个回合显示“正在重新评估并规划”。
- 通过现有计划/上下文继续让模型重新判断执行方向。

### 2.4 `goal-change`

包含改成、推翻、从头重来、换方案、重新来等目标或策略变化信号时：

- 中止当前回合。
- 保留插入内容。
- 下一个回合显示“正在重新评估并规划”。
- 模型可以保留可复用结果，也可以推翻原方向重新规划；当前代码不会强行复用旧计划。

### 2.5 `stop`

明确的停止、取消或中止请求：

- 不调用分类器。
- 立即中止当前回合。
- 不重新发送插入内容。

## 3. 分类策略

第一步使用 `Planner.classifyInsertion()` 判断是否与当前任务相关：

- 相关：改变、细化、约束、修正或直接扩展当前任务。
- 无关：独立问题、不同功能或不同任务。

分类失败时，当前底层分类器默认按“相关”处理，避免丢失用户输入；但当协调器没有可用 LLM 时，采用保守的启发式策略，无法识别为相关变化的消息会进入队列。

相关消息的细分类别目前由 `DynamicInsertionCoordinator` 的轻量规则完成。它不会假装拥有完整的自然语言意图理解；真正的计划是否保留、修改或重建，由重新进入的模型回合结合上下文决定。

## 4. 与现有执行循环的关系

```text
interject()
    ├─ decide()
    ├─ unrelated → pendingTasks
    ├─ related/stop → abortController.abort()
    └─ 当前 send() 收尾
          └─ dispatchDeferred()
                ├─ relatedInsert → send(new requirement)
                └─ pendingTasks → send(as a fresh task)
```

当前实现使用同一个 `AbortController` 结束正在运行的回合。它不会并行启动第二个写任务，因此不会让两个回合同时修改工作区。

## 5. 用户可见反馈

当前插入反馈包括：

- 无关请求：`已排队`。
- 普通相关补充：`已并入这条补充要求，正在重新评估…`。
- 目标/约束变化：`检测到目标或约束变化，正在重新评估并规划…`。
- 停止请求：`已收到停止请求，正在结束当前任务。`

这些状态表示调度动作已经发生，不代表模型已经完成重新规划。重新规划完成仍需要后续模型回合和真实工具验证。

## 6. 当前边界

以下能力尚未完整实现，不应在产品说明中描述为已完成：

1. 尚未对旧计划和新计划做结构化 diff。
2. 尚未把“保留哪些步骤、废弃哪些步骤、从哪一步重新开始”以专门卡片呈现。
3. 尚未让协调器独立调用 Planner 生成候选新计划并进行自动比较。
4. 尚未根据插入内容自动切换单 Agent / 多 Agent；是否委派仍由父模型通过现有子 Agent 工具决定。
5. 尚未为所有状态建立完整的持久化事件协议；当前插入本身通过会话消息和现有转录机制保留。

## 7. 实现文件与验证

| 文件 | 责任 |
|---|---|
| `src/coding-agent/DynamicInsertionCoordinator.ts` | 分类结果到调度决策的纯逻辑转换 |
| `src/coding-agent/Planner.ts` | 相关/无关插入的 LLM 分类 |
| `src/ui/chat.ts` | 中止当前回合、排队、延迟重新发送、状态提示 |
| `src/coding-agent/__tests__/DynamicInsertionCoordinator.test.ts` | 无关、目标变化、停止请求测试 |
| `src/coding-agent/__tests__/Planner.test.ts` | 分类器解析、失败回退测试 |

验证命令：

```bash
bun test src/coding-agent/__tests__/DynamicInsertionCoordinator.test.ts
bun test src/coding-agent/__tests__/Planner.test.ts
bun run typecheck
```
