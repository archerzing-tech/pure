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

export const RISK_LABELS: Record<IntentAssessment['riskLevel'], string> = {
  low: '低风险',
  medium: '中风险',
  high: '高风险',
};

/** 内部枚举 → 用户能读的档位。以前卡片和确认卡都把 `irreversible` 这样的
 *  原始值直接印在界面上。 */
export const REVERSIBILITY_LABELS: Record<IntentAssessment['reversibility'], string> = {
  reversible: '可以撤销',
  'partially-reversible': '只能部分回退',
  'hard-to-reverse': '回退代价高',
  irreversible: '基本不可恢复',
};

const STATUS_LABELS: Record<AssessmentFlowStatus, string> = {
  pending: '待处理',
  active: '进行中',
  awaiting: '等待你回复',
  done: '已完成',
  skipped: '已跳过',
  blocked: '等待确认',
  failed: '未完成',
};/** 卡片上的每一句实质内容都取自这次分析自己的结论（impact / recommendation，
 *  由模型按用户原话写），代码只出结构性的短标签。这里刻意不拼内容：
 *  「我判断这是一次删除请求」这类句子是把 intent 枚举套进模板生成的，一旦判断
 *  出错（把「你帮我看下如何重置」读成删除指令）卡片就当着用户的面说错话，
 *  而且看不出判断是怎么来的。
 *  某一段没有结论时也不编：闸门节点只报状态，不自己编一句「为什么」。 */
function relevantStages(assessment: IntentAssessment): AssessmentFlowStage[] {
  const stages: AssessmentFlowStage[] = [{
    phase: 'intent',
    label: '这次请求会动到什么',
    description: assessment.impact.trim(),
    status: 'pending',
  }];
  if (assessment.riskLevel !== 'low') {
    stages.push({
      phase: 'risk',
      label: '打算怎么做',
      description: assessment.recommendation.trim(),
      status: 'pending',
    });
  }
  if (assessment.requiresConfirmation) {
    stages.push({
      phase: 'gate',
      label: '需要你确认',
      description: '',
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
    recovery.textContent = `可逆性：${REVERSIBILITY_LABELS[assessment.reversibility] ?? assessment.reversibility}`;
    context.appendChild(recovery);
  }

  const activity = document.createElement('div');
  activity.className = 'assessment-flow-activity';
  activity.setAttribute('role', 'status');
  activity.setAttribute('aria-live', 'polite');
  // 展开区的状态行同样引用这次的判断，不另编一句说明——模型写的判断就是卡片
  // 要说的话，找不到就退回纯状态。
  activity.textContent = assessment.impact.trim()
    || assessment.recommendation.trim()
    || (assessment.requiresConfirmation ? '等待你确认后再动手。' : '正在结合任务继续判断。');

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
    const status = document.createElement('span');
    status.className = 'assessment-flow-node-status';
    status.textContent = STATUS_LABELS.pending;
    if (stage.description) {
      const nodeDescription = document.createElement('small');
      nodeDescription.className = 'assessment-flow-node-description';
      nodeDescription.textContent = stage.description;
      nodeBody.append(nodeLabel, nodeDescription, status);
    } else {
      nodeBody.append(nodeLabel, status);
    }
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
