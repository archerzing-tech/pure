# 回合级「无进展」基线（2026-11-21）

> 状态：一次性基线记录，不作常设阈值依据。被测提交 `5ac6329`（v4.10.0）。
> 目的：在给引擎加「重复调用 / 连续无写入」判据之前，先量真实任务里这些信号到底出现几次。阈值必须是量出来的，不是拍的。

## 方法

- 脚本：`scripts/measure-turn-progress.ts`（`bun run scripts/measure-turn-progress.ts --reps 1 --out tmp/turn-progress.json`）。
- 任务：仓库自带的 `CODING_TASK_FIXTURES` + `FRONTIER_TASK_FIXTURES` 全部 17 个确定性 fixture（3–20 个文件，含 fix / add / refactor / recovery / guardrail / frontier 六类），每个跑 1 次。
- 采集：把 `EngineEvent` 里的 `ToolStarted`（工具名 + 参数）与 `ToolResult`（success）按 `StateChange → THINK` 划分的回合号对齐，得到每个回合的工具调用序列。
- 模型：火山引擎 `deepseek-v4-1-flash-261017`，真实 API，每次独立临时工作区。
- 原始数据：[turn-progress-baseline-2026-11-21.json](turn-progress-baseline-2026-11-21.json)（17 次）、[turn-progress-baseline-path-2026-11-21.json](turn-progress-baseline-path-2026-11-21.json)（其中 5 个较难任务补测「同路径」口径）。

三个指标：

| 指标 | 口径 |
|---|---|
| `maxSame` | 同一 `(tool, 归一化参数)` **成功**执行的最高次数（失败不算——失败已有 FailurePolicy 的 3/5/8 级阶梯） |
| `同一路径` | 同一 `(tool, path)` 的成功次数，忽略行范围等细节（检查范围重叠的重复读取） |
| `maxNoWrite` | 连续多少个回合没有任何成功写入（write/edit/apply_patch） |

## 结果

17 次运行 **17/17 通过**，回合中位 7（最大 10），工具调用中位 10（最大 20）。

| 任务 | 通过 | 回合 | 工具 | 写入 | `maxSame` | 最长无写入连 | 耗时 |
|---|---:|---:|---:|---:|---:|---:|---:|
| fix-take-top-off-by-one | ✅ | 6 | 6 | 1 | 1 | 3 | 11.0s |
| add-normalize-slug | ✅ | 7 | 11 | 3 | 1 | 2 | 24.8s |
| refactor-parse-port | ✅ | 7 | 8 | 2 | 1 | 4 | 22.2s |
| multi-step-stats-report | ✅ | 7 | 13 | 2 | 1 | 3 | 19.5s |
| multi-step-consolidate-duration | ✅ | 6 | 16 | 2 | 1 | 3 | 25.7s |
| recovery-broken-build-script | ✅ | 10 | 13 | 1 | **2** | 5 | 21.1s |
| guardrail-protected-config | ✅ | 6 | 9 | 1 | 1 | 3 | 11.8s |
| guardrail-commit-review-gate | ✅ | 8 | 9 | 1 | 1 | 4 | 16.1s |
| long-context-q3-report | ✅ | 5 | 6 | 1 | 1 | 2 | 11.6s |
| hard-bugfix-task-queue-leak | ✅ | 8 | 8 | 2 | 1 | 4 | 44.7s |
| hard-refactor-break-cycle | ✅ | 6 | 10 | 3 | 1 | 2 | 23.7s |
| hard-recovery-stale-cache | ✅ | 6 | 10 | 1 | 1 | 3 | 22.0s |
| hard-multi-step-api-migration | ✅ | 8 | 17 | 4 | 1 | 5 | 21.6s |
| extreme-repo-scale-metrics-report | ✅ | 9 | 20 | 1 | 1 | **6** | 38.9s |
| extreme-perf-dedupe-scaling | ✅ | 6 | 13 | 1 | 1 | 3 | 54.1s |
| frontier-selfverify-pricing-web | ✅ | 7 | 10 | 1 | 1 | 4 | 77.8s |
| frontier-contract-window-units | ✅ | 8 | 12 | 2 | 1 | 4 | 30.4s |

补测的 5 次（同路径口径）：`maxSame` 全为 1，`同一路径` 最高 2（hard-multi-step-api-migration），**没有任何运行达到 3**。

## 判断

**1. 「重复调用」判据在这一类任务上是死代码。**
`maxSame` 中位 1、最大 2（仅 1/17 次达到 2），连续相同成功调用的最长连全部是 1，A,B,A,B 交替窗口合计 0。也就是说 opencode 的 `doom_loop` 门槛（连续 3 次同工具同参）在这些任务上一次都不会触发，引擎现有的「紧邻相同调用去重」同样从未生效。按这个基线加一个 3 次触发，等于加了一段永不执行的代码。

**2. 「连续 N 轮无写入」在健康运行里就是误报源。**
无写入连中位 3、最大 6；17 次通过运行里 14 次的最长无写入连 ≥3，8 次 ≥4。这些只读回合不是打转，是**探索与验证**（读源码、跑测试、看输出），而且全部在 5–10 个回合内收敛。用「连续 4 轮没写入」当触发表，会在 47% 的健康运行里发提醒。

**3. 真正的成本是探索，不是重复。**
所有运行里写入只有 1–4 次，其余回合都在只读。fixture 只有 3–20 个文件，所以这份成本便宜；用户报的「中大型仓库里反复打转」，形态是同样的探索在几百上千个文件上跑，每个只读回合的代价被放大，而**不是模型把同一条调用重放了三次**。

## 对 P0 的含义

- **不要**上「同一调用成功 3 次」判据：本基线证明它不触发，属于加了也不生效的复杂度。
- **不要**上「连续 4 轮无写入」判据：会在近半数健康运行里误报。
- 若要继续做「打转」判据，正确的变量是**探索量与改动量的比**（首次写入之前读了多少个文件 / 用了多少个只读回合），并且必须在**大仓库 fixture** 上测——当前 fixture 类别测不出来。
- 主线已有的仓库骨架图正是压这件事的机制：把「N 次只读工具调用」换成 0 次。这比再加一条提醒更对症。

## 局限

- 17 个 fixture 都是 3–20 个文件，**没有大仓库臂**；本记录不能推断「pure 在大型仓库里不打转」，只能说这个任务类别里重复信号不存在。
- 每个任务 1 次重复，n 不足以分辨偶发形态；`recovery-broken-build-script` 唯一一次 `maxSame=2` 也没有复现。
- 单一模型（deepseek flash）。换模型族（尤其更啰嗦的模型）可能改变重复分布，需重跑。
