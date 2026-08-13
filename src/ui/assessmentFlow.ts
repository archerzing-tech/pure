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
  awaitPhase(phase: AssessmentFlowPhase, activity?: string): void;
  completePhase(phase: AssessmentFlowPhase, activity?: string): void;
  skipPhase(phase: AssessmentFlowPhase, activity?: string): void;
  setActivity(activity: string): void;
  complete(activity?: string): void;
  cancel(activity?: string): void;
  fail(activity?: string): void;
}

const RISK_LABELS: Record<IntentAssessment['riskLevel'], string> = {
  low: '低风险',
  medium: '中风险',
  high: '高风险',
};

const INTENT_LABELS: Record<IntentAssessment['intent'], string> = {
  question: '咨询',
  research: '调研',
  add: '新增功能',
  modify: '修改功能',
  debug: '排查问题',
  refactor: '重构',
  migrate: '迁移',
  delete: '删除',
  build: '项目构建',
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

function relevantStages(assessment: IntentAssessment): AssessmentFlowStage[] {
  const stages: AssessmentFlowStage[] = [{
    phase: 'intent',
    label: `我判断这是一次${INTENT_LABELS[assessment.intent]}请求`,
    description: assessment.impact || '正在根据任务目标判断影响范围。',
    status: 'pending',
  }];
  if (assessment.riskLevel !== 'low') {
    stages.push({
      phase: 'risk',
      label: '需要注意的影响',
      description: assessment.recommendation || `${RISK_LABELS[assessment.riskLevel]}，执行时会保留验证证据。`,
      status: 'pending',
    });
  }
  if (assessment.requiresConfirmation) {
    stages.push({
      phase: 'gate',
      label: '执行前需要你的确认',
      description: assessment.recommendation || '确认影响范围后才会执行写入或破坏性操作。',
      status: 'pending',
    });
  }
  return stages;
}

export function getAssessmentFlowStages(assessment: IntentAssessment): AssessmentFlowStage[] {
  return relevantStages(assessment);
}

function setStatus(row: HTMLElement, icon: HTMLElement, status: AssessmentFlowStatus, index: number): void {
  row.classList.remove('pending', 'active', 'awaiting', 'done', 'skipped', 'blocked', 'failed');
  row.classList.add(status);
  icon.textContent = status === 'done' ? '✓' : status === 'skipped' ? '—' : status === 'blocked' ? '!' : status === 'failed' ? '×' : String(index + 1);
  row.dataset.status = status;
  row.setAttribute('aria-label', `${row.dataset.label ?? ''}：${STATUS_LABELS[status]}`);
}

export function createAssessmentFlowCard(assessment: IntentAssessment): AssessmentFlowHandle {
  const stages = relevantStages(assessment);
  const el = document.createElement('div');
  el.className = 'bubble-row assessment-flow-row';

  const card = document.createElement('details');
  card.className = `assessment-flow-card risk-${assessment.riskLevel}`;
  card.setAttribute('aria-label', '任务影响与安全边界');
  card.open = true;

  const summary = document.createElement('summary');
  summary.className = 'assessment-flow-summary';
  const marker = document.createElement('span');
  marker.className = 'assessment-flow-marker';
  marker.setAttribute('aria-hidden', 'true');
  marker.textContent = assessment.requiresConfirmation ? '!' : 'i';
  const title = document.createElement('span');
  title.className = 'assessment-flow-title';
  title.textContent = assessment.requiresConfirmation ? '执行前需要确认' : '任务影响';
  const risk = document.createElement('span');
  risk.className = `assessment-flow-risk risk-${assessment.riskLevel}`;
  risk.textContent = RISK_LABELS[assessment.riskLevel];
  const summaryStatus = document.createElement('span');
  summaryStatus.className = 'assessment-flow-summary-status';
  summaryStatus.setAttribute('role', 'status');
  summaryStatus.setAttribute('aria-live', 'polite');
  summaryStatus.textContent = assessment.requiresConfirmation ? '尚未执行任何改动' : '正在结合任务继续判断';
  const chevron = document.createElement('span');
  chevron.className = 'assessment-flow-chevron';
  chevron.setAttribute('aria-hidden', 'true');
  chevron.textContent = '⌄';
  summary.append(marker, title, risk, summaryStatus, chevron);

  const body = document.createElement('div');
  body.className = 'assessment-flow-body';
  body.setAttribute('role', 'group');
  body.setAttribute('aria-label', '任务影响与安全边界详情');

  const context = document.createElement('div');
  context.className = 'assessment-flow-context';
  if (assessment.impact) {
    const impact = document.createElement('span');
    impact.className = 'assessment-flow-impact';
    impact.textContent = `影响：${assessment.impact}`;
    context.appendChild(impact);
  }
  if (assessment.reversibility) {
    const recovery = document.createElement('span');
    recovery.className = 'assessment-flow-recovery';
    recovery.textContent = `可逆性：${assessment.reversibility}`;
    context.appendChild(recovery);
  }

  const activity = document.createElement('div');
  activity.className = 'assessment-flow-activity';
  activity.setAttribute('role', 'status');
  activity.setAttribute('aria-live', 'polite');
  activity.textContent = assessment.requiresConfirmation
    ? '我会先把影响和方案说清楚，确认后才开始执行。'
    : '这条信息只保留与当前任务有关的影响判断。';

  const diagram = document.createElement('div');
  diagram.className = 'assessment-flow-diagram';
  diagram.setAttribute('role', 'list');
  diagram.setAttribute('aria-label', '相关决策点');
  const rows = new Map<AssessmentFlowPhase, { row: HTMLElement; icon: HTMLElement; status: HTMLElement; index: number }>();
  stages.forEach((stage, index) => {
    const row = document.createElement('div');
    row.className = 'assessment-flow-node pending';
    row.dataset.label = stage.label;
    row.setAttribute('role', 'listitem');
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
    status.textContent = STATUS_LABELS.pending;
    nodeBody.append(nodeLabel, nodeDescription, status);
    row.append(icon, nodeBody);
    diagram.appendChild(row);
    rows.set(stage.phase, { row, icon, status, index });
    setStatus(row, icon, 'pending', index);
  });

  body.append(context, activity, diagram);
  card.append(summary, body);
  el.appendChild(card);

  let finished = false;
  const updateSummary = (text: string): void => {
    summaryStatus.textContent = text;
    activity.textContent = text;
  };
  const transition = (phase: AssessmentFlowPhase, status: AssessmentFlowStatus, text?: string): void => {
    if (finished) return;
    const current = rows.get(phase);
    if (!current) {
      if (text) updateSummary(text);
      return;
    }
    for (const stage of stages) {
      const entry = rows.get(stage.phase);
      if (!entry || entry === current) break;
      const previousStatus = entry.row.dataset.status as AssessmentFlowStatus | undefined;
      if (previousStatus !== 'done' && previousStatus !== 'skipped') {
        setStatus(entry.row, entry.icon, 'done', entry.index);
        entry.status.textContent = STATUS_LABELS.done;
      }
    }
    setStatus(current.row, current.icon, status, current.index);
    current.status.textContent = STATUS_LABELS[status];
    updateSummary(text ?? `${current.row.dataset.label}：${STATUS_LABELS[status]}`);
  };
  const setPhase = (phase: AssessmentFlowPhase, text?: string): void => transition(phase, 'active', text);
  const awaitPhase = (phase: AssessmentFlowPhase, text?: string): void => transition(phase, 'awaiting', text);
  const completePhase = (phase: AssessmentFlowPhase, text?: string): void => transition(phase, 'done', text);
  const skipPhase = (phase: AssessmentFlowPhase, text?: string): void => transition(phase, 'skipped', text);
  const setActivity = (text: string): void => { if (!finished) updateSummary(text); };
  const cancel = (text?: string): void => {
    if (finished) return;
    const gate = rows.get('gate');
    if (gate) {
      setStatus(gate.row, gate.icon, 'blocked', gate.index);
      gate.status.textContent = STATUS_LABELS.blocked;
    }
    finished = true;
    card.classList.add('cancelled');
    updateSummary(text ?? '已暂停，尚未执行改动。');
  };
  const complete = (text?: string): void => {
    if (finished) return;
    for (const entry of rows.values()) {
      const currentStatus = entry.row.dataset.status as AssessmentFlowStatus | undefined;
      if (currentStatus !== 'skipped' && currentStatus !== 'blocked' && currentStatus !== 'failed') {
        setStatus(entry.row, entry.icon, 'done', entry.index);
        entry.status.textContent = STATUS_LABELS.done;
      }
    }
    finished = true;
    card.classList.add('complete');
    updateSummary(text ?? '相关影响已确认，后续按实际进展处理。');
    card.open = false;
  };
  const fail = (text?: string): void => {
    if (finished) return;
    const current = [...rows.values()].find((entry) => entry.row.dataset.status === 'active' || entry.row.dataset.status === 'awaiting') ?? [...rows.values()].at(-1);
    if (current) {
      setStatus(current.row, current.icon, 'failed', current.index);
      current.status.textContent = STATUS_LABELS.failed;
    }
    finished = true;
    card.classList.add('failed');
    updateSummary(text ?? '这次判断未完成，请查看后续反馈。');
  };
  return { el, setPhase, awaitPhase, completePhase, skipPhase, setActivity, complete, cancel, fail };
}
