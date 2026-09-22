// src/shared/baselineSnapshotData.ts
// 由 `bun run eval:snapshot` 生成，不要手改。
// 数据源：evals/ 下与套件 pure-coding-baseline-v5 匹配的真实 provider 报告。
// 重新生成：跑完 `bun run eval:baseline -- --agent <provider> --report evals/<name>.json`
// 之后执行 `bun run eval:snapshot`（发布流程的一部分，见 evals/BASELINE.md）。

import type { BaselineSnapshot } from './baseline';

export const BASELINE_SNAPSHOT: BaselineSnapshot = {
  "suiteVersion": "pure-coding-baseline-v5",
  "fixtureHash": "6087e3be",
  "generatedAt": "2026-09-22T03:14:00.942Z",
  "rows": [
    {
      "provider": "nvidia",
      "model": "nvidia/nemotron-3-ultra-550b-a55b",
      "gitRevision": "40f5693",
      "passAt1": 15,
      "taskCount": 15,
      "meanDurationMs": 84784.13333333333,
      "estimatedCostUsd": 0,
      "promptTokens": 0,
      "cacheHitTokens": 0,
      "report": "evals/nemotron-3-ultra-550b-a55b.v5.json"
    },
    {
      "provider": "deepseek-openai",
      "model": "deepseek-v4-flash",
      "gitRevision": "4d2e14b",
      "passAt1": 15,
      "taskCount": 15,
      "meanDurationMs": 27240.8,
      "estimatedCostUsd": 0.023713580800000002,
      "promptTokens": 1797810,
      "cacheHitTokens": 1748736,
      "report": "evals/deepseek-v4-flash.v5.json"
    },
    {
      "provider": "deepseek-openai",
      "model": "deepseek-flash",
      "gitRevision": "40f5693",
      "passAt1": 15,
      "taskCount": 15,
      "meanDurationMs": 33991.933333333334,
      "estimatedCostUsd": 0.032530092000000004,
      "promptTokens": 2262957,
      "cacheHitTokens": 2170240,
      "report": "evals/deepseek-flash.v5.json"
    },
    {
      "provider": "glm",
      "model": "glm-4.5-flash",
      "gitRevision": "(uncommitted)",
      "passAt1": 15,
      "taskCount": 15,
      "meanDurationMs": 91825.66666666667,
      "estimatedCostUsd": 0.4196842,
      "promptTokens": 1381665,
      "cacheHitTokens": 1311936,
      "report": "evals/glm-4.5-flash.think53.v5.json"
    },
    {
      "provider": "glm",
      "model": "glm-5.3-flash",
      "gitRevision": "4d2e14b",
      "passAt1": 15,
      "taskCount": 15,
      "meanDurationMs": 113479.26666666666,
      "estimatedCostUsd": 0.558082,
      "promptTokens": 1644946,
      "cacheHitTokens": 1499264,
      "report": "evals/glm-5.3-flash.v5.json"
    },
    {
      "provider": "glm",
      "model": "glm-4.5-flash",
      "gitRevision": "4d2e14b",
      "passAt1": 13,
      "taskCount": 15,
      "meanDurationMs": 236241.4,
      "estimatedCostUsd": 0.570737,
      "promptTokens": 2403645,
      "cacheHitTokens": 2350231,
      "report": "evals/glm-4.5-flash.v5.json"
    }
  ],
  "excluded": [
    {
      "report": "evals/deepseek-v4-flash.json",
      "suiteVersion": "pure-coding-baseline-v3"
    },
    {
      "report": "evals/deepseek-v4-flash.v4.json",
      "suiteVersion": "pure-coding-baseline-v4"
    },
    {
      "report": "evals/glm-5.3-flash.v4.json",
      "suiteVersion": "pure-coding-baseline-v4"
    }
  ]
};
