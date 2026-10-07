// src/shared/roleTrial.ts
// 阶段 13.2 试用制准入 —— 判据（纯函数，无 IO）。
//
// 设计原话（capability-self-extension-design.md §13.2）：「**试用制准入**：新角色先以
// "试用"状态注册（卡片带试用角标），接 5–10 个真实委派，结局数据 ≥ 同类现有角色基线
// 才转正；不达标自动归档并出卡说明。」
//
// 本模块只做**判**，「转正」的写盘与「归档」的删除都在宿主侧。三条纪律：
//
//  1. **基线是父角色自己的数据，不是某个统计口径**。收窄变体的产生方式就是
//     「原角色在掉链子」（`scanSubagentAdvice` 的失败画像），所以它该被比过的对象
//     就是原角色。「同类」若理解成一个抽象的类别，全仓没有任何东西能把角色归类，
//     那个门槛就永远实现不了；理解成父角色，它立刻有数据且正是设计意图。
//  2. **门槛语义与止损卡相反，绝不复用**。`subagentAdvisory` 的 3 次 / 2 次 / 40%
//     是「这个角色在掉链子，别派了」——失败率高就该停。准入要问的是相反的问题：
//     成功率够不够格留下。把那套常量拿来当门槛，方向就是反的。
//  3. **父角色没数据就不裁决**。「≥ 基线」在没有基线时不等于「≥ 0」。把「没测到」
//     读成「通过」，等于给一个从未被比较过的角色发永久通行证。
//
/**
 * 旁挂账后缀：`<role>.trial.json`。
 *
 * 这个字面量曾经散在三处（TS 写入、TS 读盘、Rust 扫描），改一边就会出现
 * 「写的账读不到、或者账被当成 manifest 扫进去」这种静默故障。Rust 侧对应
 * `TRIAL_MARKER_SUFFIX`，`roleTrial.test.ts` 里有一条测试逐字比对两边。
 */
export const TRIAL_MARKER_SUFFIX = 'trial.json';

/**
 * The one label that means "the verdict is promote, show the button".
 *
 * This lives here, next to the string that produces it, because the dashboard
 * has to recognise it to decide whether to render a button — and a hand-copied
 * duplicate of a label is a silent failure: rename it here and the promote
 * button just... disappears, with no test failing. Same disease as
 * TRIAL_MARKER_SUFFIX, so it gets the same treatment.
 */
export const TRIAL_PROMOTE_LABEL = '够格转正';

/** `<role>.trial.json` —— 与 manifest 同目录，只是多一个后缀。 */
export function trialMarkerFileName(role: string): string {
  return `${role}.${TRIAL_MARKER_SUFFIX}`;
}

// 试用态本身记在 `~/.pure/subagents/<name>.trial.json` 旁挂账里，**不改用户的
// manifest**：那是角色的定义（用户可编辑），试用态是系统对它的裁决。分开放与
// persona overlay + meta、以及工具停用标记是同一条纪律。

/** 转正所需的最小委派数（设计给的是「5–10 个」，取下限当准入线）。 */
export const TRIAL_MIN_DELEGATIONS = 5;

/** 只看最近这么久的委派——半年前的样本不能给今天的角色背书。 */
export const TRIAL_WINDOW_DAYS = 30;

export type RoleTrialStatus = 'trial' | 'promoted';

export interface RoleTrialState {
  status: RoleTrialStatus;
  /** 委派给谁时记下的「原角色」——基线就从它的历史里取。 */
  parentRole?: string;
  /** 注册时刻（ms）。用于「试用了多久」与窗口裁剪。 */
  registeredAt?: number;
  /** 裁决时刻与理由（转正时写）。 */
  decidedAt?: number;
  reason?: string;
}

/**
 * 没有旁挂账 = 在试用中。这个缺省是有意的：手写的 manifest 与模型起草的 manifest
 * 在盘上长得一样，而我们没有任何办法知道手写那个是否被验证过。没被证明过的，就
 * 还处在试用里。
 *
 * 收文本**或**已解析对象：Rust 侧读文件得到的是 JSON 字符串。若这里只收对象，
 * 一个字符串会走进「不是对象」分支而被读成试用中——于是每个角色都永远显示试用中，
 * 且不报任何错。两种形态都收，这条隐式契约才不会变成陷阱。
 */
export function trialStateFromMarker(marker: string | object | null | undefined): RoleTrialState {
  let parsed: unknown = marker;
  if (typeof marker === 'string') {
    if (!marker.trim()) return { status: 'trial' };
    try {
      parsed = JSON.parse(marker);
    } catch {
      return { status: 'trial' };
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { status: 'trial' };
  const m = parsed as Record<string, unknown>;
  const num = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  const state: RoleTrialState = {
    status: m.status === 'promoted' ? 'promoted' : 'trial',
    ...(typeof m.parentRole === 'string' && m.parentRole ? { parentRole: m.parentRole } : {}),
    ...(num(m.registeredAt) !== undefined ? { registeredAt: num(m.registeredAt) } : {}),
    ...(num(m.decidedAt) !== undefined ? { decidedAt: num(m.decidedAt) } : {}),
    ...(typeof m.reason === 'string' && m.reason ? { reason: m.reason } : {}),
  };
  return state;
}

export function renderTrialMarker(state: RoleTrialState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

/** 一侧的角色战绩（与 `summarizeByRole` 的输出一致，这里只声明用到的字段）。 */
export interface RoleOutcome {
  delegations: number;
  successes: number;
}

export type RoleTrialVerdict =
  /** 已转正，或本来就已转正——不需要再裁决。 */
  | { kind: 'already-promoted' }
  /** 试用样本还不够，继续攒。 */
  | { kind: 'accumulating'; delegations: number; need: number }
  /** 父角色没有可比的基线，不裁决（不是通过，也不是失败）。 */
  | { kind: 'no-baseline'; parentRole?: string }
  /** 够格转正。 */
  | { kind: 'promote'; evidence: string }
  /** 够样本但不达标——留在试用里继续看，或由用户归档。 */
  | { kind: 'below-baseline'; evidence: string };

function rate(outcome: RoleOutcome): number {
  return outcome.delegations > 0 ? outcome.successes / outcome.delegations : 0;
}

/**
 * 裁决一个试用中的角色能不能转正。
 *
 * @param outcome 这个角色自己的窗口内战绩
 * @param baselineByRole 全角色战绩，用来取父角色那条
 */
export function judgeRoleTrial(input: {
  state: RoleTrialState;
  outcome: RoleOutcome;
  baselineByRole: Readonly<Record<string, RoleOutcome>>;
  minDelegations?: number;
}): RoleTrialVerdict {
  const need = input.minDelegations ?? TRIAL_MIN_DELEGATIONS;
  if (input.state.status === 'promoted') return { kind: 'already-promoted' };
  if (input.outcome.delegations < need) {
    return { kind: 'accumulating', delegations: input.outcome.delegations, need };
  }
  const parentRole = input.state.parentRole;
  // 无父角色 = 不知道该跟谁比。拿「整体平均」当基线会造出一个谁都没验证过的门槛。
  if (!parentRole) return { kind: 'no-baseline' };
  const baseline = input.baselineByRole[parentRole];
  // 父角色自己也还没被测过：同样不裁决。
  if (!baseline || baseline.delegations < need) return { kind: 'no-baseline', parentRole };
  const mine = rate(input.outcome);
  const theirs = rate(baseline);
  const pct = (value: number): string => `${Math.round(value * 100)}%`;
  const evidence =
    `本角色 ${input.outcome.delegations} 次委派成功 ${pct(mine)}（${input.outcome.successes}/${input.outcome.delegations}）`
    + `，父角色 ${parentRole} ${baseline.delegations} 次成功 ${pct(theirs)}（${baseline.successes}/${baseline.delegations}）`;
  return mine >= theirs
    ? { kind: 'promote', evidence }
    : { kind: 'below-baseline', evidence };
}

/** 卡片上给人看的那一行状态文案所需的数据。 */
export interface RoleTrialBadge {
  status: RoleTrialStatus;
  /** 已转正 / 试用中 · 3/5 次 / 够格转正 / 不达标：低于父角色 x% · 无基线 */
  label: string;
  evidence?: string;
}

export function trialBadge(
  role: string,
  state: RoleTrialState,
  verdict: RoleTrialVerdict,
): RoleTrialBadge {
  const badge = (label: string, evidence?: string): RoleTrialBadge => ({ status: state.status, label, ...(evidence ? { evidence } : {}) });
  switch (verdict.kind) {
    case 'already-promoted':
      return badge('已转正');
    case 'accumulating':
      return badge(`试用中 · ${verdict.delegations}/${verdict.need} 次`);
    case 'no-baseline':
      return badge(verdict.parentRole ? `试用中 · 父角色 ${verdict.parentRole} 样本不足` : '试用中 · 未记父角色');
    case 'promote':
      return badge(TRIAL_PROMOTE_LABEL, verdict.evidence);
    case 'below-baseline':
      return badge('试用中 · 不达标', verdict.evidence);
  }
}

/**
 * The reason line that lands in the sidecar's `reason` field (host supplies the
 * wording; this module stays out of i18n).
 *
 * Takes the evidence **string**, not the verdict, because the caller is the
 * dashboard — it already rendered the comparison, and passing the verdict back
 * would mean re-reading the observations to rebuild something we had.
 */
export function trialPromotionReason(role: string, evidence: string): string {
  return `角色 "${role}" 已转正：${evidence}。它不再带试用角标。`;
}