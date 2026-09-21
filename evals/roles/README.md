# 角色级回归集（北极星第 6 步 13.3 part 2）

每个角色一个目录：`evals/roles/<role>/case-XX.json`。每个 case 是一次
**真实形态的委派**（`args` 与该角色 input_schema 的字段一致）加上对子 agent
**最终输出**的内容断言：

```json
{
  "id": "case-01",
  "description": "为什么出这道题（不发给模型）",
  "args": { "prompt": "review …", "files": "a.ts" },
  "must": ["correctness"],
  "mustNot": []
}
```

- `must`：输出里必须出现的子串（大小写、空白不敏感）。
- `mustNot`：输出里必须**不**出现的子串。
- 产出为空（崩溃/超时/被预算打断）按未过计。

## A/B 准入门槛

`bun run eval:roles -- --role <role>` 会把同一批 case 分别用 base persona 和
base+overlay（`~/.pure/personas/<role>.overlay.md`）各跑一遍，裁决规则：

- 任一侧样本 `< 5` 个 → **DENY**（overlay 不落盘）——验收口径"overlay 仅在
  有 A/B 数据支撑时落盘"。
- overlay 通过率 ≥ base 通过率（不输）→ **ALLOW**。
- 更低 → **REJECT**。

## 当前目录里的 case 都是手写种子

只用于打通管线，**刻意不达 5 个阈值**：门在真实数据到位前保持关闭。
真实样本的来源是历史真实派发（E4.1 outcome 数据里该角色的委派 args + 主
agent 采纳情况），后续由 reflector 流程沉淀进来后替换种子。
