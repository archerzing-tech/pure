export type TaskKind = 'code' | 'general' | 'research' | 'write';

const CODE_RE = /(修复|实现|重构|bug|fix|feat|add|删除文件|写文件|新增|修改代码|改代码|跑通|构建|编译|测试|补全|实现功能)/i;
const RESEARCH_RE = /(调研|搜|查找|研究|对比分析|趋势|市场)/i;
const WRITE_RE = /(写文章|写文案|起草|拟稿|润色|改写)/i;
const GENERAL_RE = /(总结|概括|翻译|译|整理|列出|对比|解释|简述|梳理|归纳|说说|介绍一下)/i;
const FILE_MUTATE_RE = /(write_file|str_replace|rm\b|mv\b|删除|新增文件|覆盖文件)/i;

export function detectTaskKind(text: string): TaskKind {
  const t = text || '';
  if (CODE_RE.test(t)) return 'code';
  if (RESEARCH_RE.test(t)) return 'research';
  if (WRITE_RE.test(t)) return 'write';
  if (GENERAL_RE.test(t)) return 'general';
  // 保守：默认按 code 处理，避免破坏既有行为
  return 'code';
}

export function isFileMutating(text: string): boolean {
  return FILE_MUTATE_RE.test(text);
}
