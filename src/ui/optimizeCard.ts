// src/ui/optimizeCard.ts
// 课后优化建议 card: appended after a turn that delivered files, offering a
// MANUAL "generate suggestions" action that runs the code_reviewer subagent in
// non-blocking advisory mode. Never runs on its own — no token spend, no delay
// at the end of a turn. Renders like thinkingCard (.bubble-row + <details>) so
// it reads as part of the transcript and collapses cleanly.

import { t } from '../shared/i18n';

export interface OptimizeCardOptions {
  /** Files this turn produced, shown / passed to the reviewer. */
  files: string[];
  /** Effective workspace directory ('' when unset). */
  workspace: string;
  /** The user's original request this turn answered. */
  userRequest: string;
  /** Runs the advisory code review; returns the reviewer's text output. */
  runReview: (prompt: string, files: string[]) => Promise<string>;
}

export interface OptimizeCardHandle {
  el: HTMLElement;
  /** Run the review (idempotent; a running review is not restarted). */
  trigger: () => Promise<void>;
}

/** Strip a trailing blocking-gate VERDICT line — advisory output doesn't need it. */
export function stripVerdict(output: string): string {
  return output.replace(/\n?VERDICT:\s*(PASS|FAIL)\s*$/i, '').trim();
}

export function createOptimizeCard(host: HTMLElement, opts: OptimizeCardOptions): OptimizeCardHandle {
  const row = document.createElement('div');
  row.className = 'bubble-row optimize-row';

  const details = document.createElement('details');
  details.className = 'optimize-card';
  details.open = true;

  const summary = document.createElement('summary');
  summary.className = 'optimize-toggle';
  const title = document.createElement('span');
  title.textContent = t('optimize.title');
  const badge = document.createElement('span');
  badge.className = 'optimize-badge';
  badge.textContent = t('optimize.advisory');
  summary.append(title, badge);
  details.appendChild(summary);

  const body = document.createElement('div');
  body.className = 'optimize-body';
  details.appendChild(body);
  row.appendChild(details);
  host.appendChild(row);

  let running = false;
  const renderHint = (): void => {
    body.replaceChildren();
    const hint = document.createElement('p');
    hint.className = 'optimize-hint';
    hint.textContent = t('optimize.hint');
    const run = document.createElement('button');
    run.type = 'button';
    run.className = 'setting-btn secondary optimize-run-btn';
    run.textContent = t('optimize.generate');
    run.addEventListener('click', () => void trigger());
    body.append(hint, run);
  };

  const trigger = async (): Promise<void> => {
    if (running) return;
    running = true;
    body.replaceChildren();
    // 过程可见（2026-09-29 用户反馈：点下去很久什么都看不到）：审查是子
    // 代理级别的长活（读文件→逐文件审→汇总），至少给用户一个活的阶段行，
    // 别让它读起来像点了没反应。阶段推进由下方 timer 驱动（轮换文案），
    // 完成时连同耗时一行收尾。
    const loading = document.createElement('p');
    loading.className = 'optimize-loading optimize-loading-live';
    loading.textContent = t('optimize.loading');
    body.appendChild(loading);
    const stages = [
      t('optimize.loading'),
      t('optimize.staging.reading'),
      t('optimize.staging.reviewing'),
      t('optimize.staging.summarizing'),
    ];
    let stageIdx = 0;
    const stageTimer = window.setInterval(() => {
      stageIdx = (stageIdx + 1) % stages.length;
      loading.textContent = stages[stageIdx]!;
    }, 12_000);
    const startedAt = Date.now();
    const elapsed = (): string => {
      const s = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`;
    };
    const files = opts.files.length > 0 ? opts.files : [opts.workspace || '（未设置工作区）'];
    const prompt = [
      '这是课后优化建议（非阻断，请只给出改进方向，不要输出 VERDICT）。',
      `用户原始请求：${opts.userRequest || '（无）'}`,
      `工作区：${opts.workspace || '（未设置）'}`,
      '请检查以下本次生成/修改的文件，给出简洁的重构、性能、可维护性与边界情况优化建议；若无明显问题，直接说明。',
      `文件：${files.join(', ')}`,
    ].join('\n');
    try {
      const output = await opts.runReview(prompt, files);
      const text = document.createElement('pre');
      text.className = 'optimize-result';
      text.textContent = stripVerdict(output) || t('optimize.empty');
      const doneLine = document.createElement('p');
      doneLine.className = 'optimize-elapsed';
      doneLine.textContent = t('optimize.doneIn').replace('{n}', elapsed());
      body.append(doneLine, text);
    } catch (err) {
      body.replaceChildren();
      const fail = document.createElement('p');
      fail.className = 'optimize-error';
      fail.textContent = `${t('optimize.error')}: ${err instanceof Error ? err.message : String(err)}`;
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'setting-btn secondary optimize-run-btn';
      retry.textContent = t('optimize.generate');
      retry.addEventListener('click', () => void trigger());
      body.append(fail, retry);
    } finally {
      window.clearInterval(stageTimer);
      running = false;
    }
  };

  renderHint();
  return { el: row, trigger };
}
