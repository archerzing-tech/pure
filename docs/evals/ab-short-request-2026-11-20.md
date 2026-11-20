# 短请求思考档真实任务 A/B（2026-11-20）

> 状态：一次性评测记录，不作常设基线。对照版本：`v4.9.6`（`d8e63d6`）与 `main`（`ace9288`）。
> 范围：5 个仓库内确定性 fixture，只把 prompt 改写成 46–64 字、不含路径/URL 的中文短句；文件、控制组与验收命令不动。
> 模型：火山引擎 `deepseek-v4-1-flash-261017`，真实 API。旧版走 `isLightShapedTurn → true` 的 `disableThinking + reasoning_effort:low`；新版走主档（该模型行未显式设置，按 auto = `medium`）。每次运行独立临时工作区，逐题跑 fixture 自带验收。

## 结果

旧版 `v4.9.6`：5 题全部被判为轻档（`light=true`），全部通过。

| 任务 | 旧档位 | 通过 | 回合 | 工具 | 耗时 | prompt tokens |
|---|---|---:|---:|---:|---:|---:|
| fix-take-top-off-by-one | low | ✅ | 6 | 6 | 9.7s | 61.5k |
| add-normalize-slug | low | ✅ | 6 | 6 | 14.8s | 62.6k |
| hard-bugfix-task-queue-leak | low | ✅ | 6 | 8 | 14.0s | 64.0k |
| frontier-selfverify-pricing-web | low | ✅ | 7 | 12 | 39.4s | 102.9k |
| frontier-contract-window-units | low | ✅ | 14 | 14 | 45.0s | 204.1k |

新版 `main`：同一批 prompt 全部判为主档（`light=false`），同样 5/5 通过，但 frontier 两题出现明显长尾。

| 任务 | 新档位 | 通过 | 回合 | 工具 | 耗时 | prompt tokens |
|---|---|---:|---:|---:|---:|---:|
| fix-take-top-off-by-one | 默认 | ✅ | 5 | 6 | 8.6s | 52.2k |
| add-normalize-slug | 默认 | ✅ | 6 | 7 | 15.0s | 62.9k |
| hard-bugfix-task-queue-leak | 默认 | ✅ | 6 | 7 | 18.7s | 64.6k |
| frontier-selfverify-pricing-web | 默认 | ✅ | 18 | 19 | 157.3s | 350.4k |
| frontier-contract-window-units | 默认 | ✅ | 18 | 26 | 339.9s | 264.3k |

frontier 两题各补跑一次，确认不是稳定差异：

| 任务 | 版本 | 通过 | 回合 | 耗时 | prompt tokens |
|---|---|---:|---:|---:|---:|
| pricing-web | v4.9.6（第 2 次） | ✅ | 9 | 58.0s | 128.1k |
| pricing-web | main（第 2 次） | ✅ | 7 | 81.7s | 106.1k |
| contract-window | v4.9.6（第 2 次） | ✅ | 9 | 37.2s | 113.9k |
| contract-window | main（第 2 次） | ✅ | 10 | 56.2s | 128.6k |

原始报告：`docs/evals/ab-short-request-{v496,main}-2026-11-20.json`、`docs/evals/ab-short-request-v496-rep2-2026-11-20.json`、`docs/evals/ab-short-request-main-rep2-{pricing,contract}-2026-11-20.json`。

## 结论

1. **短请求不再降档，这一点已由真实版本行为确认。** 同一批 5 条中文工程短句在 `v4.9.6` 全部命中轻档，在 `main` 全部留主档。纯函数侧寒暄仍保持轻档（`谢谢`/`你好`），没有把所有短句都拉进主档。
2. **这批任务没有测出质量提升，也没有回归。** 两个版本都是 5/5；旧版低档并不是「做不对」，只是少付推理成本。该修复的当前价值是降低「首轮把工程活判成寒暄」的风险，而不是已量化的正确率收益。
3. **主档的代价不是线性增加，而是长尾。** 非长尾的 frontier 复跑里，main 约 1.4–2.1× 墙钟、token 与旧版接近；但首轮 contract 任务在 18 回合上限、340s、264k prompt tokens 后才通过，旧版同题 14 回合 / 45s。也就是说，同一档位下有时会在验收已绿后继续补测试、继续绕，直到接近预算上限。
4. **下一个能力缺口是「验收绿后的停止与收尾纪律」，不是短请求分类。** 现在升档只在回合开始前决定一次；进入主档后没有「确定性验收已通过 → 只允许一次最终验证和总结」的收口，也没有把「继续打磨」的成本和收益算进停止条件。修复轮升 high 解决的是失败后的深度，解决不了成功后的过度工作。
5. **评测侧的缺口同样明显：这套 fixture 对当前模型已经饱和。** 5 题两档全过，无法回答「低档到底会在哪类任务上做浅」。要量化这次修复的质量收益，需要一组短句形态、且低档确实会失败的留出题，而不是继续加现有题。

## 建议的下一步

- 先做**验收即停**：交付验收通过后，禁止再开新的探索/补测回合；只保留一次最终复验与总结。目标是把 frontier 的长尾从 18 回合压回 7–10 回合，同时不改变通过率。
- 停止条件用**确定性证据**（verification 全绿 + 工作树无待跑命令）判断，不用模型自述「我完成了」。
- 之后再补一组**短句形态的留出题**，专门覆盖低档容易漏的规划/约束组合，才能给这次思考档修复一个质量读数；当前 5/5 只能证明「没变坏、没降档」。

## 复现

```bash
# main
bun run scripts/ab-short-request-intelligence.ts --out docs/evals/ab-short-request-main-2026-11-20.json

# v4.9.6（同一脚本，独立 worktree）
git worktree add .ab-v496 v4.9.6
cp scripts/ab-short-request-intelligence.ts .ab-v496/scripts/
cd .ab-v496
bun run scripts/ab-short-request-intelligence.ts --out ../docs/evals/ab-short-request-v496-2026-11-20.json
```

脚本不打印、不落盘密钥；从 `~/.pure/config.json` 的 `custom001` 条目与 `~/.pure/secrets.json` 取运行时配置。`--only <id[,id]>` 可单跑指定题。
