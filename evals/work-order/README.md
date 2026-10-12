# evals/work-order — 分量判读判例集（人格轨道刀 6，2026-10-12）

每条判例一个 `.json`：`userTurns` 里的措辞必须被 `detectWorkOrderRegister`
判成 `register` 标注的档位。`matched` 期望见各条的 `expectMatched`：
轻档判例必须命中信号词（可解释性），`production-default` 必须空命中
（默认档不靠词命中，靠"判不出=正式"）。

- **replay**（`bun run eval:work-order`，免 key，CI 门）：判定面 + 档位表 +
  解析缩放 + 交付标记解析的固定断言。它证明机制链没被改坏。
- **live**（`--agent <provider>`，人工抽查层）：把判例措辞用真实档位段装配
  （`buildPlanThinkingPrompt`）问真 provider，断言模型**自发**步数不超过档位
  表上限（不经解析层缩放——测的是模型对档位段的服从，不是裁剪器的服从），
  且轻档回复带跳过声明。禁 LLM-as-judge，判卷的只有固定行为断言。
