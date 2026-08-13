import type { IntentAssessment } from '../coding-agent/types';

export type AssessmentFlowPhase = 'intent' | 'risk' | 'gate' | 'execute' | 'verify';
type AssessmentFlowStatus = 'pending' | 'active' | 'awaiting' | 'done' | 'skipped' | 'blocked' | 'failed';

export interface AssessmentFlowStage {
  phase: AssessmentFlowPhase;
  label: string;
  description: string;
  status: AssessmentFlowStatus;
}

export interface AssessmentFlowHandle {
  el: HTMLElement;
  setPhase(phase: AssessmentFlowPhase, activity?: string): void;
  /** Mark a phase as awaiting the user's reply (plan ready → execute). */
  awaitPhase(phase: AssessmentFlowPhase, activity?: string): void;
  completePhase(phase: AssessmentFlowPhase, activity?: string): void;
  skipPhase(phase: AssessmentFlowPhase, activity?: string): void;
  setActivity(activity: string): void;
  complete(activity?: string): void;
  cancel(activity?: string): void;
  fail(activity?: string): void;
}

const PHASES: AssessmentFlowPhase[] = ['intent', 'risk', 'gate', 'execute', 'verify'];

function gateCopy(assessment: IntentAssessment): { label: string; description: string } {
  if (assessment.requiresConfirmation) {
    return { label: '执行确认', description: '等待你确认影响范围与替代方案' };
  }
  if (assessment.requiresProbe) {
    return { label: '只读探针', description: '先收集证据，再决定具体改法' };
  }
  return { label: '安全闸门', description: '当前请求不需要额外确认' };
}

export function getAssessmentFlowStages(assessment: IntentAssessment): AssessmentFlowStage[] {
  const gate = gateCopy(assessment);
  return [
    // Intent starts pending: the card reveals it via a staged animation so it
    // reads as analysis in progress, not a pre-computed result.
    { phase: 'intent', label: '识别意图', description: `判断这是一次${assessment.intent}请求`, status: 'pending' },
    { phase: 'risk', label: '评估风险', description: `${assessment.riskLevel} · ${assessment.reversibility}`, status: 'pending' },
    { phase: 'gate', label: gate.label, description: gate.description, status: 'pending' },
    { phase: 'execute', label: '小步执行', description: '只在确认范围内开始改动', status: 'pending' },
    { phase: 'verify', label: '验证结果', description: '用检查和证据决定是否交付', status: 'pending' },
  ];
}

const RISK_LABELS: Record<IntentAssessment['riskLevel'], string> = {
  low: '低风险',
  medium: '中风险',
  high: '高风险',
};

const STATUS_LABELS: Record<AssessmentFlowStatus, string> = {
  pending: '待处理',
  active: '进行中',
  awaiting: '等待你回复',
  done: '已完成',
  skipped: '已跳过',
  blocked: '等待确认',
  failed: '未完成',
};

function setStatus(row: HTMLElement, icon: HTMLElement, status: AssessmentFlowStatus, index: number): void {
  row.classList.remove('pending', 'active', 'awaiting', 'done', 'skipped', 'blocked', 'failed');
  row.classList.add(status);
  icon.textContent = status === 'done' ? '✓' : status === 'skipped' ? '—' : status === 'blocked' ? '!' : status === 'failed' ? '×' : String(index + 1);
  row.dataset.status = status;
  row.setAttribute('aria-label', `${row.dataset.label ?? ''}：${STATUS_LABELS[status]}`);
}

export function createAssessmentFlowCard(assessment: IntentAssessment): AssessmentFlowHandle {
  const stages = getAssessmentFlowStages(assessment);
  const el = document.createElement('div');
  el.className = 'bubble-row assessment-flow-row';

  const card = document.createElement('details');
  card.className = `assessment-flow-card risk-${assessment.riskLevel}`;
  card.setAttribute('aria-label', '主动评估状态');
  card.open = true;

  const summary = document.createElement('summary');
  summary.className = 'assessment-flow-summary';
  const marker = document.createElement('span');
  marker.className = 'assessment-flow-marker';
  marker.setAttribute('aria-hidden', 'true');
  marker.textContent = '✦';
  const title = document.createElement('span');
  title.className = 'assessment-flow-title';
  title.textContent = '主动评估';
  const risk = document.createElement('span');
  risk.className = `assessment-flow-risk risk-${assessment.riskLevel}`;
  risk.textContent = RISK_LABELS[assessment.riskLevel];
  const summaryStatus = document.createElement('span');
  summaryStatus.className = 'assessment-flow-summary-status';
  summaryStatus.setAttribute('role', 'status');
  summaryStatus.setAttribute('aria-live', 'polite');
  // 卡面不预制任何“正在分析”的演出：节点状态只由真实事件（chat.ts 的分析落地、
  // 探针、用户确认）驱动，初始文案如实说明在等分析结果。
  summaryStatus.textContent = '等待评估结果…';
  const chevron = document.createElement('span');
  chevron.className = 'assessment-flow-chevron';
  chevron.setAttribute('aria-hidden', 'true');
  chevron.textContent = '⌄';
  summary.append(marker, title, risk, summaryStatus, chevron);

  const body = document.createElement('div');
  body.className = 'assessment-flow-body';
  body.setAttribute('role', 'group');
  body.setAttribute('aria-label', '主动评估状态详情');
  const context = document.createElement('div');
  context.className = 'assessment-flow-context';
  const impact = document.createElement('span');
  impact.className = 'assessment-flow-impact';
  impact.textContent = `影响：${assessment.impact}`;
  const recovery = document.createElement('span');
  recovery.className = 'assessment-flow-recovery';
  recovery.textContent = `可逆性：${assessment.reversibility}`;
  context.append(impact, recovery);

  const activity = document.createElement('div');
  activity.className = 'assessment-flow-activity';
  activity.setAttribute('role', 'status');
  activity.setAttribute('aria-live', 'polite');
  activity.textContent = '评估结果将在分析完成后显示。';

  const diagram = document.createElement('div');
  diagram.className = 'assessment-flow-diagram';
  diagram.setAttribute('role', 'list');
  diagram.setAttribute('aria-label', '主动评估流程');
  const rows = new Map<AssessmentFlowPhase, { row: HTMLElement; icon: HTMLElement; status: HTMLElement }>();
  stages.forEach((stage, index) => {
    const row = document.createElement('div');
    row.className = 'assessment-flow-node pending';
    row.dataset.label = stage.label;
    row.setAttribute('role', 'listitem');
    row.setAttribute('aria-label', `${stage.label}：${STATUS_LABELS[stage.status]}`);
    const icon = document.createElement('span');
    icon.className = 'assessment-flow-node-icon';
    icon.setAttribute('aria-hidden', 'true');
    const nodeBody = document.createElement('span');
    nodeBody.className = 'assessment-flow-node-body';
    const nodeLabel = document.createElement('strong');
    nodeLabel.className = 'assessment-flow-node-label';
    nodeLabel.textContent = stage.label;
    const nodeDescription = document.createElement('small');
    nodeDescription.className = 'assessment-flow-node-description';
    nodeDescription.textContent = stage.description;
    const status = document.createElement('span');
    status.className = 'assessment-flow-node-status';
    status.textContent = STATUS_LABELS[stage.status];
    nodeBody.append(nodeLabel, nodeDescription, status);
    row.append(icon, nodeBody);
    diagram.appendChild(row);
    rows.set(stage.phase, { row, icon, status });
    setStatus(row, icon, stage.status, index);
  });

  body.append(context, activity, diagram);
  card.append(summary, body);
  el.appendChild(card);

  let currentIndex = 0;
  let finished = false;
  const updateSummary = (text: string): void => {
    summaryStatus.textContent = text;
    activity.textContent = text;
  };    // True when the flow reaches a node whose preceding stage is a real
    // async boundary (probe / confirmation) — used to phrase how the stage
    // will resume, instead of implying work is happening right now.
    const awaitCopy = (phase: AssessmentFlowPhase): string => {
      if (phase === 'gate') return assessment.requiresConfirmation
        ? '正在等待你的确认，确认后会立即进入执行…'
        : '正在做只读检查，确认影响范围后再动手…';
      if (phase === 'execute') return '计划已就绪，正在等待你的回复后开始执行…';
      return `${rows.get(phase)?.row.dataset.label ?? '当前阶段'}：${STATUS_LABELS.awaiting}`;
    };
    const transition = (phase: AssessmentFlowPhase, status: AssessmentFlowStatus, text?: string): void => {
      if (finished) return;
      const targetIndex = PHASES.indexOf(phase);
      if (targetIndex < 0) return;
      if (targetIndex >= PHASES.indexOf('execute') && (assessment.requiresProbe || assessment.requiresConfirmation)) {
        const gateStatus = rows.get('gate')?.row.dataset.status;
        const gatePassed = gateStatus === 'done' || (!assessment.requiresConfirmation && gateStatus === 'skipped');
        if (!gatePassed) {
          updateSummary('安全闸门尚未通过，暂不进入执行阶段');
          return;
        }
      }
      for (let i = 0; i < targetIndex; i++) {
        const previous = rows.get(PHASES[i]);
        if (!previous) continue;
        const previousStatus = previous.row.dataset.status as AssessmentFlowStatus | undefined;
        if (previousStatus === 'blocked' || previousStatus === 'failed') {
          updateSummary(`${previous.row.dataset.label}：${STATUS_LABELS[previousStatus]}，暂不进入下一阶段`);
          return;
        }
        if (previousStatus === 'done' || previousStatus === 'skipped') continue;
        setStatus(previous.row, previous.icon, 'done', i);
        previous.status.textContent = STATUS_LABELS.done;
      }
      const current = rows.get(phase);
      if (!current) return;
      currentIndex = Math.max(currentIndex, targetIndex);
      setStatus(current.row, current.icon, status, targetIndex);
      current.status.textContent = STATUS_LABELS[status];
      if (text) updateSummary(text);
      else updateSummary(status === 'awaiting' ? awaitCopy(phase) : `${current.row.dataset.label}：${STATUS_LABELS[status]}`);
    };
    // 节点状态只由真实事件驱动（chat.ts 在分析落地后立即落定 intent/risk，探针/
    // 确认驱动 gate，执行/验证驱动后续节点）。不再有预制的时间轴动画假装在分析。
    const setPhase = (phase: AssessmentFlowPhase, text?: string): void => {
      transition(phase, 'active', text);
    };
    const awaitPhase = (phase: AssessmentFlowPhase, text?: string): void => {
      transition(phase, 'awaiting', text);
    };
    const completePhase = (phase: AssessmentFlowPhase, text?: string): void => {
      transition(phase, 'done', text);
    };
    const skipPhase = (phase: AssessmentFlowPhase, text?: string): void => {
      transition(phase, 'skipped', text);
    };
    const setActivity = (text: string): void => {
      if (!finished) updateSummary(text);
    };
    const cancel = (text?: string): void => {
      if (finished) return;
      const gate = rows.get('gate');
      if (gate) {
        setStatus(gate.row, gate.icon, 'blocked', 2);
        gate.status.textContent = STATUS_LABELS.blocked;
      }
      finished = true;
      card.classList.add('cancelled');
      summaryStatus.textContent = text ?? '已暂停，等待新的指令';
      activity.textContent = text ?? '未执行任何改动，已保留在安全闸门前。';
    };
    const complete = (text?: string): void => {
      if (finished) return;
      for (let i = 0; i < PHASES.length; i++) {
        const stage = rows.get(PHASES[i]);
        if (!stage) continue;
        const currentStatus = stage.row.dataset.status as AssessmentFlowStatus | undefined;
        if (currentStatus !== 'skipped' && currentStatus !== 'blocked' && currentStatus !== 'failed') {
          setStatus(stage.row, stage.icon, 'done', i);
          stage.status.textContent = STATUS_LABELS.done;
        }
      }
      const blocked = PHASES.some((phase) => rows.get(phase)?.row.dataset.status === 'blocked' || rows.get(phase)?.row.dataset.status === 'failed');
      finished = true;
      card.classList.add(blocked ? 'failed' : 'complete');
      summaryStatus.textContent = text ?? (blocked ? '流程未完全通过' : '评估流程完成');
      activity.textContent = text ?? (blocked ? '流程仍有未完成的安全节点，请查看当前状态。' : '评估流程完成，结果已交给执行与验证流程。');
      if (!blocked) card.open = false;
    };
    const fail = (text?: string): void => {
      if (finished) return;
      const current = rows.get(PHASES[currentIndex]);
      if (current) {
        setStatus(current.row, current.icon, 'failed', currentIndex);
        current.status.textContent = STATUS_LABELS.failed;
      }
      finished = true;
      card.classList.add('failed');
      summaryStatus.textContent = text ?? '流程未完成';
      activity.textContent = text ?? '流程未完成，请查看下方错误信息。';
    };
    return {
      el,
      setPhase,
      awaitPhase,
      completePhase,
      skipPhase,
      setActivity,
      complete,
      cancel,
      fail,
    };
}
