// src/cliIntent.ts
// Pure CLI-side helpers for proactive intent assessment. Kept separate from
// cli.ts so tests can cover the request policy without starting the CLI entrypoint.

import type { IntentAssessment } from './coding-agent/types';
import { cyan, dim, red, yellow } from './termcolors';

/** Resolve the CLI permission stance from the opt-out flag alone.
 *
 *  请求风险**不再**翻转立场（2026-10-10 修复「做着做着突然没权限」）：此前
 *  某一轮被 Planner 判 `requiresConfirmation` 就把整轮 autoApprove 关掉，
 *  该轮全部 write/edit/execute 落进确认门——非 TTY 直接硬拒，用户看到的是
 *  「没有任何改动却突然没权限」，下一轮评估回落又自己恢复。现在高风险轮
 *  照常自动放行：风险提示行照打（formatCliIntentAssessment），只有
 *  dangerLevel==='danger' 的**操作本身**才落到交互门（见
 *  createCliPermissionHandler）。护栏从「模型一句话」换成了「操作分级」。 */
export function resolveCliAutoApprove(
  promptOnTool: boolean,
  defaultAutoApprove = true,
): boolean {
  return defaultAutoApprove && !promptOnTool;
}

/** Render the risk summary printed before a CLI turn. Low-risk turns stay
 *  silent: the word-list safety gate (assessIntent) only raises risk on
 *  destructive operations, so what prints here is a safety warning, not a
 *  guess about what the turn is. */
export function formatCliIntentAssessment(
  assessment: IntentAssessment,
  options: { bareWorkspace?: boolean } = {},
): string {
  if (assessment.riskLevel === 'low') return '';
  const label = assessment.riskLevel === 'high' ? red('high risk') : yellow('medium risk');
  // 空工作区里的任务级「删除」指向的是待写的功能，不是磁盘上的既有对象
  // （2026-11-23 判例：从零做一个待办页，「删除」只是按钮文案，却让开场多付
  // 一次「先只读探查、列受影响对象」）。词表命中的是请求，探查对象得看磁盘：
  // 没有清单也没有验证入口时，这句话不成立。操作级毁灭词（high）不受影响。
  if (options.bareWorkspace && assessment.riskLevel !== 'high') {
    return `  ${cyan('🧭')} ${label} ${dim(`· ${assessment.reversibility}`)}\n`
      + `     ${dim('空工作区：没有既有对象要探查，直接按需求实现。')}\n`;
  }
  return `  ${cyan('🧭')} ${label} ${dim(`· ${assessment.reversibility}`)}\n`
    + `     ${dim(assessment.impact)}\n`
    + `     ${yellow('↳')} ${dim(assessment.recommendation)}\n`;
}
