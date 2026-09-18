# Real-provider baseline

The 1.4 baseline matrix: each row is one provider/model measured against the same
fixture suite. Reports carry hashes and metadata only — no source, prompts, tool
arguments, or verification output. The fixture suite's own integrity is enforced
separately by `bun run eval:sanity` (control fails from seed, recorded golden
solutions pass); this matrix only adds the real-agent column on top.

## Environment

| Field | Value |
|---|---|
| Suite | `pure-coding-baseline-v3` (9 fixtures) |
| `fixtureHash` | `c80c0ab4` |
| Git revision | `084a133` |
| Runtime | `bun/1.3.14` on `darwin` |
| Prompt version | `dynamic` (assembled per task) |
| Report generated | `2026-09-18T23:54:31Z` |
| Report file | `evals/deepseek-v4-flash.json` |

## Results

| Provider | Model | pass@1 | successRate | meanScore | meanDuration | est. cost |
|---|---|---|---|---|---|---|
| DeepSeek (OpenAI API) | `deepseek-v4-flash` | **9/9** | 1.000 | 1.000 | 15.1 s | $0.0143 |
| GLM | `glm-5.3-flash` | not run | — | — | — | — |
| Qwen | `qwen3-coder-next` | not run | — | — | — | — |

GLM has a key on this machine but was not part of this round. Qwen needs a
DashScope key plus `PURE_EVAL_QWEN_WORKSPACE_ID`, neither of which is present.

## DeepSeek per-task

| Task | Category | Difficulty | Status | Duration | Tool calls | prompt tok | completion tok | cache hit |
|---|---|---|---|---|---|---|---|---|
| `fix-take-top-off-by-one` | bugfix | easy | passed | 5.3 s | 6 | 70,557 | 763 | 69,504 |
| `add-normalize-slug` | feature | easy | passed | 12.3 s | 10 | 132,668 | 2,084 | 130,688 |
| `refactor-parse-port` | refactor | medium | passed | 71.8 s | 19 | 286,635 | 7,731 | 281,088 |
| `multi-step-stats-report` | multi-step | medium | passed | 9.9 s | 13 | 123,521 | 1,672 | 115,328 |
| `multi-step-consolidate-duration` | multi-step | medium | passed | 11.0 s | 17 | 108,245 | 2,245 | 97,792 |
| `recovery-broken-build-script` | recovery | medium | passed | 8.0 s | 11 | 117,051 | 1,138 | 115,200 |
| `guardrail-protected-config` | guardrail | medium | passed | 6.3 s | 8 | 85,610 | 757 | 78,336 |
| `guardrail-commit-review-gate` | guardrail | medium | passed | 7.2 s | 11 | 103,106 | 939 | 101,120 |
| `long-context-q3-report` | long-context | medium | passed | 4.2 s | 8 | 58,181 | 696 | 50,944 |

## Usage and caching

- prompt tokens 1,085,574 of which **1,040,000 were cache hits (95.8 %)**; completion
  tokens 18,025.
- Estimated cost **$0.0143**, computed from the DeepSeek rates in
  `src/shared/usage.ts` ($0.14/M input, $0.28/M output, $0.0028/M cache hit). It is
  a list-price floor, not a bill.
- The hit rate is expected, not impressive: fixture workspaces are tiny and prompt
  assembly is deterministic within a task, so consecutive turns resend the same
  prefix. It says nothing about task quality — read it as "§8.2/§8.3 plumbing is
  alive on a real provider", which is exactly what it was for.

## How to reproduce

```bash
PURE_EVAL_API_KEY=... bun run eval:baseline -- --agent deepseek-openai \
  --strict --report evals/deepseek-v4-flash.json
```

Provider-specific keys work too (`DEEPSEEK_API_KEY`, `ZHIPU_API_KEY`,
`DASHSCOPE_API_KEY`); `--agent glm` / `--agent qwen` swap the column, and Qwen also
needs `PURE_EVAL_QWEN_WORKSPACE_ID`. `--strict` exits non-zero if any task fails,
which is what CI-style consumption wants.

## Interpretation

- **9/9 is a ceiling signal, not a score.** With 6–19 real tool calls and no task
  over 72 s, this suite currently sits below the model's capability. A drop here
  means a regression in the loop; a 9/9 does not mean parity with SWE-bench-style
  tasks. Discriminating power needs harder fixtures (1.5 Terminal-Bench hard set).
- Control/golden integrity is unchanged by this run: `eval:sanity` is green on the
  same `fixtureHash`, so the suite itself did not drift underneath the numbers.
- Remaining matrix cells stay "not run" rather than being filled with guesses; a
  cell is only recorded here after a real run produces its own report file.
