# Real-provider baseline

The 1.4 baseline matrix: each row is one provider/model measured against the same
fixture suite. Reports carry hashes and metadata only — no source, prompts, tool
arguments, or verification output. The fixture suite's own integrity is enforced
separately by `bun run eval:sanity` (control fails from seed, recorded golden
solutions pass); this matrix only adds the real-agent column on top.

## Current suite: `pure-coding-baseline-v4` (13 fixtures)

### Environment

| Field | Value |
|---|---|
| Suite | `pure-coding-baseline-v4` (13 fixtures: 9 core + 4 hard) |
| `fixtureHash` | `a1c00907` |
| Git revision | `ccc210b` |
| Runtime | `bun/1.3.14` on `darwin` |
| Prompt version | `dynamic` (assembled per task) |
| Reports | `evals/deepseek-v4-flash.v4.json`, `evals/glm-5.3-flash.v4.json` |

### Results

| Provider | Model | pass@1 | successRate | mean duration | est. cost |
|---|---|---|---|---|---|
| DeepSeek (OpenAI API) | `deepseek-v4-flash` | **13/13** | 1.000 | 39.5 s | $0.0184 |
| GLM | `glm-5.3-flash` | **13/13** | 1.000 | 87.6 s | $0.4270 |
| Qwen | `qwen3-coder-next` | not run | — | — | — |

Qwen still needs a DashScope key plus `PURE_EVAL_QWEN_WORKSPACE_ID`.

### Per task (duration / tool calls)

| Task | Difficulty | DeepSeek | GLM |
|---|---|---|---|
| `fix-take-top-off-by-one` | easy | 9 s / 5 | 59 s / 7 |
| `add-normalize-slug` | easy | 12 s / 8 | 51 s / 6 |
| `refactor-parse-port` | medium | 10 s / 6 | 85 s / 5 |
| `multi-step-stats-report` | medium | 9 s / 13 | 123 s / 12 |
| `multi-step-consolidate-duration` | medium | 39 s / 16 | 70 s / 12 |
| `recovery-broken-build-script` | medium | 9 s / 13 | 66 s / 8 |
| `guardrail-protected-config` | medium | 9 s / 12 | 81 s / 8 |
| `guardrail-commit-review-gate` | medium | 9 s / 12 | 172 s / 9 |
| `long-context-q3-report` | medium | 27 s / 8 | 28 s / 7 |
| `hard-bugfix-task-queue-leak` | hard | 11 s / 7 | 100 s / 6 |
| `hard-refactor-break-cycle` | hard | 94 s / 16 | 154 s / 17 |
| `hard-recovery-stale-cache` | hard | 15 s / 13 | 88 s / 10 |
| `hard-multi-step-api-migration` | hard | 259 s / 17 | 63 s / 15 |

### Usage and caching

| Provider | prompt tokens | completion | cache hit | hit rate | est. cost |
|---|---|---|---|---|---|
| DeepSeek | 1,422,347 | 30,765 | 1,380,096 | 97.0 % | $0.0184 |
| GLM | 1,270,483 | 17,137 | 1,122,944 | 88.4 % | $0.4270 |

Costs come from the rate table in `src/shared/usage.ts` (list price, not a bill);
the GLM rates are several times DeepSeek's, which is most of the 23× cost gap.

## What the v4 run actually shows

**On pass/fail, the suite still does not discriminate.** Both models solved all 13
fixtures including the four new `hard` ones. The hard tier raised *work* (DeepSeek's
hard tasks averaged 95 s vs 12 s for the rest; GLM's 101 s vs 91 s) but not the
*solve rate*, so the new fixtures are harder-to-do, not harder-to-get-right, for
these two models.

**On cost and time, it discriminates clearly.** Same fixtures, same harness: GLM
takes 2.2× the wall clock and costs 23× DeepSeek — with 3.5× the cache misses on a
comparable prompt volume. That is a real, reproducible difference between two
providers, and it is the number to watch when the loop changes (a regression that
lowers solve rate shows up as failures; one that raises cost shows up here).

So treat v4 as **a regression gate plus a cost/efficiency benchmark**, not a
difficulty ladder. A 13/13 does not mean the loop is good — it means the suite has
stopped being able to tell the difference, and only the cost columns carry signal.

### If pass/fail discrimination is the goal

More of the same will not do it: four fixtures designed around interacting defects,
a structural refactor, a root cause and a breaking migration were all cleared. The
dimensions that were *not* exercised are where the next attempt should go:

- **Repo-scale** — a task spanning dozens of files where the agent must find the
  relevant code itself, instead of a workspace that fits in one read;
- **Hard resource constraints** — a performance or memory ceiling the naive
  implementation misses (needs care to stay deterministic across machines);
- **Long-horizon recovery** — a task that only completes after several failed
  approaches, probing whether the loop recovers or thrashes;
- **Weaker models** — the same 13 fixtures against a smaller model would likely
  separate on hard tier immediately, which is itself a useful matrix column.

## Superseded: `pure-coding-baseline-v3` (9 fixtures)

| Provider | Model | pass@1 | mean duration | est. cost | Report |
|---|---|---|---|---|---|
| DeepSeek (OpenAI API) | `deepseek-v4-flash` | 9/9 | 15.1 s | $0.0143 | `evals/deepseek-v4-flash.json` |

Environment for that run: `fixtureHash c80c0ab4`, revision `084a133`. Kept because
the v3 and v4 numbers are not comparable — v4 adds four fixtures and changes the
fixture hash, so the suite has to be re-measured rather than carried forward (which
is exactly why the reports record the hash).

## How to reproduce

```bash
PURE_EVAL_API_KEY=... bun run eval:baseline -- --agent deepseek-openai \
  --strict --report evals/deepseek-v4-flash.v4.json
PURE_EVAL_API_KEY=... bun run eval:baseline -- --agent glm \
  --strict --report evals/glm-5.3-flash.v4.json
```

Provider-specific keys work too (`DEEPSEEK_API_KEY`, `ZHIPU_API_KEY`,
`DASHSCOPE_API_KEY`); Qwen also needs `PURE_EVAL_QWEN_WORKSPACE_ID`. `--strict`
exits non-zero if any task fails, which is what CI-style consumption wants.
