# Real-provider baseline

The 1.4 baseline matrix: each row is one provider/model measured against the same
fixture suite. Reports carry hashes and metadata only — no source, prompts, tool
arguments, or verification output. The fixture suite's own integrity is enforced
separately by `bun run eval:sanity` (control fails from seed, recorded golden
solutions pass); this matrix only adds the real-agent column on top.

## Current suite: `pure-coding-baseline-v5` (15 fixtures)

### Environment

| Field | Value |
|---|---|
| Suite | `pure-coding-baseline-v5` (15 fixtures: 9 core + 4 hard + 2 extreme) |
| `fixtureHash` | `6087e3be` |
| Git revision | `4d2e14b` |
| Runtime | `bun/1.3.14` on `darwin` |
| Prompt version | `dynamic` (assembled per task) |
| Reports | `evals/deepseek-v4-flash.v5.json`, `evals/glm-5.3-flash.v5.json`, `evals/glm-4.5-flash.v5.json` |

### Results

| Provider | Model | pass@1 | successRate | mean duration | est. cost |
|---|---|---|---|---|---|
| DeepSeek (OpenAI API) | `deepseek-v4-flash` | **15/15** | 1.000 | 27.2 s | $0.0237 |
| GLM | `glm-5.3-flash` | **15/15** | 1.000 | 113.5 s | $0.5581 |
| GLM | `glm-4.5-flash` | 13/15 | 0.867 | 236.2 s | $0.5707 |
| Qwen | `qwen3-coder-next` | dropped | — | — | — |

The Qwen column was dropped by user decision (2026-09-19): no DashScope
account, so the matrix finalizes at three providers and this cell stays
permanently blank. (`PURE_EVAL_QWEN_WORKSPACE_ID` / `DASHSCOPE_WORKSPACE_ID`
still work if that ever changes.)

### Per task (duration)

| Task | Difficulty | DeepSeek | GLM 5.3 | GLM 4.5 |
|---|---|---|---|---|
| `fix-take-top-off-by-one` | easy | 6 s | 39 s | 66 s |
| `add-normalize-slug` | easy | 11 s | 102 s | 54 s |
| `refactor-parse-port` | medium | 10 s | 68 s | 302 s |
| `multi-step-stats-report` | medium | 13 s | 58 s | 48 s |
| `multi-step-consolidate-duration` | medium | 23 s | 248 s | 63 s |
| `recovery-broken-build-script` | medium | 32 s | 59 s | 36 s |
| `guardrail-protected-config` | medium | 5 s | 49 s | 36 s |
| `guardrail-commit-review-gate` | medium | 8 s | 40 s | 28 s |
| `long-context-q3-report` | medium | 5 s | 42 s | 65 s |
| `hard-bugfix-task-queue-leak` | hard | 12 s | 70 s | 53 s |
| `hard-refactor-break-cycle` | hard | 25 s | 218 s | 79 s |
| `hard-recovery-stale-cache` | hard | 10 s | 57 s | 259 s |
| `hard-multi-step-api-migration` | hard | 15 s | 146 s | 1060 s · `agent_error` |
| `extreme-repo-scale-metrics-report` | extreme | 19 s | 105 s | 192 s |
| `extreme-perf-dedupe-scaling` | extreme | 215 s | 401 s | 1201 s · `agent_error` |

GLM 4.5's two `agent_error` entries are not verification failures and not
provider-side faults — they are the harness's own deterministic hard caps
(`EVAL_BUDGET` in `codingAgentExecutor.ts`: 30 turns / 200k tokens / 20 min, by
design so a run cannot go elastic). The executor's fatal message has a fixed
39-char prefix (`model call failed (AGENT_INTERRUPTED): `), so the recorded
`agentError.chars` reverses to the engine's interrupt reason exactly:

- `hard-multi-step-api-migration` — 48 chars → `max_turns`: the 30-turn ceiling
  ran out at 17.7 min **with every verification green** (bun test + the migration
  checker both passed); the row scores 0 purely because VERIFY never started;
- `extreme-perf-dedupe-scaling` — 54 chars → `Budget exceeded`: the 20-min
  `hardMaxTime` fired at 20.0 min and the scaling check (which itself allows 40 s)
  never ran, so `verificationPassed: false` means "never reached", not "failed".

The provider side was healthy throughout (97.8 % cache hit; the run was still
making progress when the caps fired). The executor's refusal to score an
unreached provider as a plain zero (`agent_error`, not `failed`) is the separate
fix that shipped in `4d2e14b`.

Reports generated after this diagnosis record the cause explicitly instead of
relying on that reversal: `agentError.code` / `agentError.reason` (the engine's
interrupt reason, sanitized to the text before the first colon so no provider
message lands in the report) and `agent.turns`. The v5 reports above predate the
field, which is why their cause had to be reverse-engineered from `chars`.

### Usage and caching

| Provider | prompt tokens | completion | cache hit | hit rate | est. cost |
|---|---|---|---|---|---|
| DeepSeek | 1,797,810 | 42,667 | 1,748,736 | 97.3 % | $0.0237 |
| GLM 5.3 | 1,644,946 | 35,171 | 1,499,264 | 91.1 % | $0.5581 |
| GLM 4.5 | 2,403,645 | 14,774 | 2,350,231 | 97.8 % | $0.5707 |

Costs come from the rate table in `src/shared/usage.ts` (list price, not a bill);
the GLM rates are several times DeepSeek's, which is most of the cost gap.

## What the v5 run actually shows

**Pass/fail discrimination arrived with the extreme tier.** After the hard tier
still left both models at 13/13 (see Superseded below), the two `extreme` fixtures
did what the hard tier could not: `glm-4.5-flash` drops to 13/15 while DeepSeek and
`glm-5.3-flash` hold 15/15. The two failures are `agent_error` timeouts/aborts at
the 18–20-minute marks, not wrong answers — but on pass/fail they count, which is
exactly the separation the tier was built to produce.

**Cost and time still discriminate harder.** Same fixtures, same harness: GLM 5.3
takes 4.2× the wall clock and ~24× the cost of DeepSeek; GLM 4.5 is slower still on
wall clock (8.7×) at a comparable cost. The cost gap is dominated by the rate table,
not by behavior — cache hit rates are comparable (91–98 %) across all three runs.

The two extreme tiers justify themselves differently:

- `extreme-repo-scale` (45 files, prompt names no file) was cleared by all three —
  repo-scale search is inside range for all of them;
- `extreme-perf` (a scaling ratio, not a wall-clock number) is where GLM 4.5 died:
  the naive quadratic implementation was the trap, and the model either never got
  to a passing rewrite or ran out of runway.

### If pass/fail discrimination is the goal

More of the same will not do it. The dimensions already covered — repo-scale
search, a scaling-ratio performance ceiling, interacting defects, structural
refactor, root cause, breaking migration — were cleared by at least two of the
three models. What remains uncovered:

- **Long-horizon recovery** — a task that only completes after several failed
  approaches, probing whether the loop recovers or thrashes;
- **Tighter resource ceilings** — the perf fixture's bound is generous (4× records
  must cost under 7× time); a stricter ratio or a memory ceiling would catch more;
- **Weaker models** — a smaller/older model column separates exactly the way GLM 4.5
  just did, which makes it the cheapest way to keep the matrix honest.

## Superseded: `pure-coding-baseline-v4` (13 fixtures)

| Provider | Model | pass@1 | mean duration | est. cost | Report |
|---|---|---|---|---|---|
| DeepSeek (OpenAI API) | `deepseek-v4-flash` | 13/13 | 39.5 s | $0.0184 | `evals/deepseek-v4-flash.v4.json` |
| GLM | `glm-5.3-flash` | 13/13 | 87.6 s | $0.4270 | `evals/glm-5.3-flash.v4.json` |

Environment for that run: `fixtureHash a1c00907`, revision `ccc210b`. The hard tier
raised work but not solve rate — both models cleared all four hard fixtures, so v4's
conclusion was "a regression gate plus a cost/efficiency benchmark, not a difficulty
ladder", which is what motivated the extreme tier in v5. Kept because the v4 and v5
numbers are not comparable — v5 adds two fixtures and changes the fixture hash, so
the suite has to be re-measured rather than carried forward (which is exactly why
the reports record the hash).

## Superseded: `pure-coding-baseline-v3` (9 fixtures)

| Provider | Model | pass@1 | mean duration | est. cost | Report |
|---|---|---|---|---|---|
| DeepSeek (OpenAI API) | `deepseek-v4-flash` | 9/9 | 15.1 s | $0.0143 | `evals/deepseek-v4-flash.json` |

Environment for that run: `fixtureHash c80c0ab4`, revision `084a133`.

## How to reproduce

```bash
PURE_EVAL_API_KEY=... bun run eval:baseline -- --agent deepseek-openai \
  --strict --report evals/deepseek-v4-flash.v5.json
PURE_EVAL_API_KEY=... bun run eval:baseline -- --agent glm \
  --strict --report evals/glm-5.3-flash.v5.json
PURE_EVAL_API_KEY=... bun run eval:baseline -- --agent glm \
  --model glm-4.5-flash \
  --report evals/glm-4.5-flash.v5.json
```

Provider-specific keys work too (`DEEPSEEK_API_KEY`, `ZHIPU_API_KEY`,
`DASHSCOPE_API_KEY` — the Qwen column needs
`PURE_EVAL_QWEN_WORKSPACE_ID` as well, though it is currently dropped from
the matrix). `--strict`
exits non-zero if any task fails — GLM 4.5's row above is why the reproduce
commands for that column drop `--strict`. Then publish the numbers into the app
with `bun run eval:snapshot` (see `evals/README.md`).
