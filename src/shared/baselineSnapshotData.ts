// src/shared/baselineSnapshotData.ts
// 由 `bun run eval:snapshot` 生成，不要手改。
// 数据源：evals/ 下与套件 pure-coding-baseline-v5 匹配的真实 provider 报告。
// 重新生成：跑完 `bun run eval:baseline -- --agent <provider> --report evals/<name>.json`
// 之后执行 `bun run eval:snapshot`（发布流程的一部分，见 evals/BASELINE.md）。

import type { BaselineSnapshot } from './baseline';

export const BASELINE_SNAPSHOT: BaselineSnapshot = {
  "suiteVersion": "pure-coding-baseline-v5",
  "fixtureHash": "6087e3be",
  "generatedAt": "2026-09-19T01:04:07.453Z",
  "rows": [],
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
