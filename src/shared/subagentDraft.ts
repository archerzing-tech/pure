// src/shared/subagentDraft.ts
// E1.4 → 13.2 生成半边（MVP）。E1.4 建议卡说"这个角色在反复掉链子"，本模块把那条
// 建议升级成一键动作：按失败画像生成一个**收窄范围的变体角色** manifest 草稿
// （~/.pure/subagents/<role>_focused.json），用户改完重启即被 13.2 加载半边接收。
//
// 设计口径（capability-self-extension-design.md §13.2）：模型起草是完整版；MVP 先做
// 确定性草稿——不依赖 provider、瞬间完成、绝不静默落盘（调用方必须先过
// compileExternalSubagents 校验，再让用户确认）。试用制准入留给完整版。

import { SUBAGENT_ADVICE_WINDOW_DAYS, type SubagentAdvice } from './subagentAdvisory';

/** 草稿命名：原角色名 + `_focused`（收窄语义），与 manifest 名字规则同构。 */
export function draftRoleName(role: string): string {
  return `${role}_focused`;
}

export interface DraftRoleManifest {
  file: string;
  /** 格式化好的 manifest JSON 文本（2 空格缩进，用户可直接编辑）。 */
  json: string;
}

/**
 * 按失败画像生成变体角色草稿。超时型 → 教"一次只做一小步"；失败型 → 教"先验证
 * 再交付"。标签/预算沿用加载半边的安全默认（read-only、并行安全），超时型给满
 * 30 分钟预算（与内建角色一致，让子代理预算而不是角色超时先说话）。
 */
export function buildDraftRoleManifest(advice: SubagentAdvice): DraftRoleManifest {
  const name = draftRoleName(advice.role);
  const timeoutShaped = advice.reason === 'timeout';
  const description = timeoutShaped
    ? `${advice.role} 的收窄变体：一次委派只做一个小而自足的步骤（原角色近 ${SUBAGENT_ADVICE_WINDOW_DAYS} 天超时 ${advice.timeoutCount} 次，任务体量偏大）。用更小的任务粒度换取稳定完成。`
    : `${advice.role} 的收窄变体：只接目标明确、可验证的小任务，交付必须带验证证据（原角色近 ${SUBAGENT_ADVICE_WINDOW_DAYS} 天失败率 ${advice.failureRate}%）。`;
  const discipline = timeoutShaped
    ? `纪律：
1. 一次委派只处理一个明确的小步骤；接到大任务时，先输出"我会怎么拆"，请求把任务拆小，而不是硬跑。
2. 控制探索范围：只读完成任务所必需的文件，不做顺带的全面检查。
3. 交付从简：结论 + 一行证据即可，宁可交一半确定的结果，也不为凑完整而超时。`
    : `纪律：
1. 动手前先声明你要验证什么；交付时必须带验证证据（命令输出/文件行号），没有证据的结论要标注"未验证"。
2. 范围收紧：只做任务描述里点名的事，顺带发现的问题记录下来但不展开。
3. 卡住就如实上报卡点，不要用猜测填补证据的空缺。`;
  const manifest = {
    version: 1,
    name,
    description,
    systemPrompt: `你是 ${advice.role} 的收窄特化版，专注把一个小任务稳定做完，而不是把一个大任务做完一半。

任务：{prompt}
相关文件（可能为空）：{files}

${discipline}`,
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '一个小而明确的任务步骤' },
        files: { type: 'string', description: '相关文件路径（可选，逗号分隔）' },
      },
      required: ['prompt'],
    },
    ...(timeoutShaped ? { timeoutMs: 1_800_000 } : {}),
  };
  return { file: `${name}.json`, json: `${JSON.stringify(manifest, null, 2)}\n` };
}
