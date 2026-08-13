# Coding-task evaluation baseline

This directory defines a small, reproducible local baseline for Pure's coding-agent loop. It is intentionally separate from provider calls: the same fixture and verification command can be run against different providers, prompt versions, or agent implementations without changing the scoring code.

## Run the control baseline

```bash
bun run eval:baseline
bun run eval:baseline -- --report evals/baseline.latest.json
```

The control baseline starts each task from its seeded buggy/incomplete files and runs the real Bun verification command without an agent. It should score `0/3`; that is a fixture sanity check, not an agent-quality score. Use `--strict` when a real agent callback is wired and failed tasks should produce a non-zero exit code:

```bash
PURE_EVAL_API_KEY=... bun run eval:baseline -- --agent deepseek-openai --strict --report evals/model.latest.json
```

Provider/model/prompt/revision metadata can be supplied through `PURE_EVAL_MODEL`, `PURE_EVAL_PROMPT_VERSION`, `GIT_COMMIT`/`GITHUB_SHA`, and `PURE_EVAL_SEED`. Use `--agent deepseek-openai|deepseek-anthropic|qwen|glm|mock` (or `PURE_EVAL_AGENT`) to run the real CodingAgent executor; omit it for the control baseline. Set `PURE_EVAL_TRACE=evals/traces.jsonl` or pass `--trace evals/traces.jsonl` to persist local prompt traces. For custom OpenAI-compatible endpoints, pass `PURE_EVAL_BASE_URL` and optionally `PURE_EVAL_CONTEXT_WINDOW_TOKENS`, `PURE_EVAL_OUTPUT_RESERVE_TOKENS`, and `PURE_EVAL_SAFETY_MARGIN_TOKENS`.

## Task protocol

`src/evaluation/codingTaskBaseline.ts` contains the versioned fixtures. Each task has:

- a stable id, category, difficulty, and natural-language user prompt;
- seeded files written into an isolated temporary workspace by default; even when `workspace` is supplied, each task gets a fresh `pure-eval-*` subdirectory;
- one or more executable verification commands with timeout and hashed output;
- an optional agent callback that receives the prompt and workspace path.

The built-in `scripts/run-evals.ts` can call `evaluateCodingTask()` through the real `CodingAgent` executor for supported providers, returning normalized token usage, tool-call count, and the Prompt observability trace id. A custom runner can supply its own `agent` callback with the same contract. The evaluator never trusts the model's text as a pass signal: `verificationPassed` is determined only by the verification commands, while `success`/`passAt1` additionally require an invoked agent to complete without error. A no-agent run is explicitly marked `control`, and an agent exception is marked `agent_error` rather than being reported as a pass.

Fixtures reject absolute and parent-traversal paths. Fixture preparation errors, verification spawn failures, and agent exceptions become structured `fixture_error`/failed results rather than aborting the entire suite. Use `--keep-workspaces` only when inspecting a run; otherwise isolated temporary workspaces are deleted after each task.

## Reported metrics

- `passAt1` and `successRate`: behavioral agent task success;
- per-task `status`, `agentCompleted`, and `verificationPassed` to distinguish agent failure from test failure;
- `meanScore`: currently binary task correctness, leaving room for partial rubrics;
- `meanDurationMs`: end-to-end task time including verification;
- `totalUsage` and `estimatedCostUsd`: provider-reported usage when the agent callback supplies it;
- `fixtureHash` and runtime/provider/model/prompt/revision metadata for comparison across runs;
- per-task verification status, duration, output length/hash, and optional trace id.

Reports deliberately contain hashes and metadata rather than source, prompts, command output, tool arguments, or secrets. For a real benchmark, run each task in a disposable workspace/container and record the suite version, fixture hash, provider, model, prompt version, git revision, seed, and runtime alongside the report.

## Prompt observability

Prompt assembly records are local and opt-in at the integration boundary. They store fragment ids, budget decisions, provider/model, lengths, and hashes—not raw system prompts, user prompts, tool arguments, verification output, or final answers. Harness run traces reuse the matching assembly trace id when one exists, then record event counts, tool durations, usage, verification statuses, and outcome. Set `PromptObservability({ enabled: false })` for a no-op collector; the default in-memory store is bounded. The evaluation CLI can opt into the versioned, corruption-tolerant JSONL sink with `PURE_EVAL_TRACE=...`.

## Baseline interpretation

This is a compact regression gate, not a replacement for SWE-bench/Terminal-Bench. It measures whether Pure can complete a few representative local bugfix, feature, and refactor tasks under the exact verification commands. Expand the fixture set only when each new task has a deterministic behavioral check and a clear reason to exist.
