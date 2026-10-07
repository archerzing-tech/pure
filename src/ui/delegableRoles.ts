// src/ui/delegableRoles.ts
// The delegable role surface, in one place.
//
// Why this module exists: `~/.pure/subagents/` roles are registered and
// delegable, but every observation slice used to read a hardcoded set of eight
// built-ins (`KNOWN_SUBAGENT_ROLES`). A generated role's delegations therefore
// landed nowhere — not in the advice cards, not in the team roster, not in the
// cost view — and 13.2's trial-period verdict ("delegate it 5–10 times, then
// judge it on outcomes") had nothing to read. The fix is to let the host say
// what it actually registered; the single scan that knows that lives here, so
// the chat session and the settings dashboard cannot drift into two truths.
//
// Role lifecycle lives here too (13.2's second half): the trial sidecar records
// `trial` / `promoted` / `archived`, and archiving is isolation — the role drops
// off the delegable surface while its manifest stays put, restorable from the
// dashboard. Deleting a manifest still makes the role disappear on the next scan;
// that remains the only way to get rid of one for good.

import { isTauriRuntime, loadTauriCore, tauriInvoke } from '../shared/tauri';
import { homeDir, join } from '@tauri-apps/api/path';
import { t } from '../shared/i18n';
import { loadConfig } from './config';
import { compileExternalSubagents } from '../harness/externalSubagents';
import { BUILT_IN_SUBAGENTS, CODING_AGENT_ROLES } from '../coding-agent/SubagentOrchestrator';
import { BUILT_IN_TOOLS } from '../coding-agent/ToolRegistry';
import type { SubagentDefinition } from '../coding-agent/types';
import {
  isRoleArchived,
  judgeRoleTrial,
  renderTrialMarker,
  trialBadge,
  trialStateFromMarker,
  trialWindowFloors,
  TRIAL_WINDOW_DAYS,
  type RoleOutcome,
  type RoleTrialBadge,
  type RoleTrialState,
  trialArchiveReason,
  trialMarkerFileName,
  trialPromotionReason,
} from '../shared/roleTrial';
import { summarizeTeamRoster } from '../shared/teamObservability';
import type { PromptObservation } from '../shared/promptObservability';

/** The eight built-ins, in registration order. */
export function builtinRoleNames(): string[] {
  return [...BUILT_IN_SUBAGENTS, ...CODING_AGENT_ROLES].map((def) => def.name);
}

/**
 * Built-in tool names, which a generated ROLE must never be allowed to take.
 *
 * The manifest name rule (`/^[a-z][a-z0-9_]{1,63}$/`) happily accepts
 * `execute_command`, and the compiler's `reserved` list only covers the eight
 * role names — so a manifest called `execute_command.json` is accepted, and
 * once this module's surface reached the observation slices, every shell call in
 * the session would show up as a "role delegation": a roster row, an advice
 * card, a cost line. Dropped here as well as at compile time, because the
 * dashboard has to survive a role directory that predates either guard.
 */
const BUILT_IN_TOOL_NAMES: ReadonlySet<string> = new Set(BUILT_IN_TOOLS.map((tool) => tool.name.toLowerCase()));

/**
 * Built-in roles **and** built-in tools: the reserved names a generated artifact
 * may never take. Read side (the scan below) rejects them at compile time so the
 * user is told; write side (trial / promote / archive / restore) must guard too,
 * because those write a sidecar for a role that only exists in the user's
 * imagination otherwise.
 */
const RESERVED_ROLE_NAMES: ReadonlySet<string> = new Set([...builtinRoleNames(), ...BUILT_IN_TOOL_NAMES]);

/** One delegable role plus what the system knows about it beyond its definition.
 *  `trial` is the 13.2 admission state; it is absent-free by design (a role with no
 *  marker is on trial), so consumers must not treat `undefined` as "unknown".
 *  `archived` is also a real state here, not a missing one — see
 *  `delegableExternalSubagents` for the difference between the two views. */
export interface DelegableRole {
  def: SubagentDefinition;
  trial: RoleTrialState;
}

/**
 * The evolution master switch, in ONE place.
 *
 * Not a nit: the scan and the promotion write are two different doors into the
 * same policy, and the load-side guard alone let `promoteGeneratedRole` mark a
 * role permanent with the switch off. `loadGuiExternalTools` keeps its own copy
 * for the tool family; a shared helper per family is the honest granularity
 * here (a global one would drag `src/ui/config`'s localStorage dependency into
 * every module that needs it).
 */
function evolutionEnabled(): boolean {
  try {
    return loadConfig()?.skills?.evolution !== false;
  } catch {
    // Unreadable config reads as "on" — same call the tool loader makes.
    return true;
  }
}

let subagentsPromise: Promise<DelegableRole[]> | null = null;

/**
 * Scan `~/.pure/subagents/` once per app run and return the full definitions
 * (the chat session registers these; the dashboard needs only the names).
 *
 * Cached deliberately: the set of delegable roles is fixed for the run, and a
 * fresh scan per call would mean the dashboard could disagree with the session
 * it is describing. A role added mid-session shows up at the next app start —
 * the same rule the tool loader already follows.
 */
export function loadExternalSubagents(): Promise<DelegableRole[]> {
  // Policy is checked on EVERY call, not folded into the cache: a user who turns
  // the master switch off mid-session must stop seeing (and delegating to) the
  // generated roles without restarting. The cache exists to save the scan IO, not
  // to memoize a policy decision.
  if (!evolutionEnabled()) return Promise.resolve([]);
  subagentsPromise ??= (async () => {
    // 总开关关着 = 生成物一律不加载（设计 §13 边界表原文：「所有生成物不加载、
    // 建议卡不再出」）。这一 guard 不是可选项：观测记录在总开关关闭时照写
    // （PromptObservability 的 enabled 与 skills.evolution 无关），所以一旦这里
    // 放行，一个 100% 失败的生成角色就会在开关关着时照样出建议卡。
    if (!isTauriRuntime()) return [];
    if (!evolutionEnabled()) return [];
    try {
      const sources = await tauriInvoke<Array<{ file: string; text: string; trialMarker?: string | null }>>('list_external_subagents');
      // Reserved covers the built-in ROLES **and** the built-in TOOLS: a role
      // named `execute_command` is accepted by the manifest name rule, and once
      // this surface reached the observation slices every shell call in the
      // session would render as a "role delegation". Rejecting at compile time
      // means the user is told, rather than silently measured wrong.
      const reserved = [...RESERVED_ROLE_NAMES];
      const { defs, errors } = compileExternalSubagents(sources ?? [], reserved);
      for (const line of errors) console.warn(`[external-subagents] ${line}`);
      // Belt and braces for a manifest directory that predates this guard.
      const byName = new Map(defs.map((def) => [def.name, def]));
      return (sources ?? [])
        .map((source) => {
          const name = source.file.replace(/\.json$/, '');
          const def = byName.get(name);
          return def
            ? { def, trial: trialStateFromMarker(source.trialMarker) }
            : undefined;
        })
        .filter((entry): entry is DelegableRole => entry !== undefined);
    } catch (error) {
      console.warn('[external-subagents] scan failed:', error);
      return [];
    }
  })();
  return subagentsPromise;
}

/**
 * Every role name the host can delegate to, generated ones included. Pass this
 * to the observation slices; omitting it falls back to the built-in eight.
 * **Archived roles are not in here** — they are off the team on purpose.
 */
export async function loadDelegableRoleNames(): Promise<string[]> {
  const external = await delegableExternalSubagents();
  return [...builtinRoleNames(), ...external.map((entry) => entry.def.name)];
}

/**
 * The generated roles a session may actually delegate to: everything the scan
 * found **minus the archived ones**.
 *
 * This is the split that makes archiving mean anything. One scan answers "what is
 * on disk" (the source of truth the dashboard needs, archived roles included),
 * and this view answers "what is on the team" (what gets registered for
 * delegation). Filtering inside the scan instead would hide an archived role from
 * the very screen that is supposed to offer to bring it back.
 */
export async function delegableExternalSubagents(): Promise<DelegableRole[]> {
  return (await loadExternalSubagents()).filter((entry) => !isRoleArchived(entry.trial));
}

/**
 * The generated roles and their trial states, **archived ones included**.
 * **Promoted roles stay in this list** too — promotion removes the badge, not the
 * role; a role that vanishes from the roster because it was promoted would be the
 * most confusing possible outcome. Archived roles need to stay for the same
 * reason: the dashboard has to be able to show what the system retired and offer
 * the way back.
 */
export async function loadGeneratedRoles(): Promise<DelegableRole[]> {
  return loadExternalSubagents();
}


// ── 13.2 试用制：角标与转正 ──

/**
 * The badge for every generated role, judged against the parent's own record.
 *
 * The baseline comes from `summarizeByRole`, which — thanks to the injectable
 * role surface — sees the generated roles too. Judging a variant against a
 * baseline computed without it would compare it against nothing.
 */
export function buildTrialBadges(
  roles: readonly DelegableRole[],
  records: readonly PromptObservation[],
  now: number,
): Record<string, RoleTrialBadge> {
  const surface = [...builtinRoleNames(), ...roles.map((entry) => entry.def.name)];
  // `summarizeTeamRoster`, NOT `summarizeByRole`: the latter reads only
  // `toolCalls`, and every record written since T1 carries its delegations in
  // the named `delegations` array. Using it here made the trial verdict read
  // zero delegations on real data — the badge would sit at "0/5" forever and the
  // promotion path would be unreachable in production.
  //
  // `roleSince` bounds each trial role's window at its own registration moment,
  // so a restored role starts a genuinely new trial instead of re-reading the
  // delegations that archived it.
  const roster = summarizeTeamRoster(records, {
    now,
    windowDays: TRIAL_WINDOW_DAYS,
    roles: surface,
    roleSince: trialWindowFloors(roles.map(({ def, trial }) => ({ name: def.name, trial })), now),
  });
  const byRole: Record<string, RoleOutcome> = {};
  for (const row of roster.rows) {
    byRole[row.role] = { delegations: row.delegations ?? 0, successes: row.successes };
  }
  const badges: Record<string, RoleTrialBadge> = {};
  for (const { def, trial } of roles) {
    const verdict = judgeRoleTrial({
      state: trial,
      outcome: byRole[def.name] ?? { delegations: 0, successes: 0 },
      baselineByRole: byRole,
    });
    badges[def.name] = trialBadge(def.name, trial, verdict);
  }
  return badges;
}

/**
 * Write a promotion marker. Reuses the generic `write_file` command rather than
 * adding a Rust command — the marker is a small JSON file in a directory the
 * scan already reads, so a new command would be a new write surface for nothing.
 *
 * The role must still exist: promoting a role the user deleted in the meantime
 * would leave an orphan marker that reads as a promotion for a role nobody has.
 *
 * `evidence` is the two-sided comparison the dashboard just showed the user
 * ("本角色 6 次委派成功 100%（6/6），父角色 researcher 8 次成功 100%（8/8）"). The
 * caller already has it — the badge rendered it — so it is passed in rather than
 * recomputed: recomputing here would add an observation read to the write path,
 * and it could disagree with the number the user actually clicked on. Written to
 * the sidecar so the next question ("on what grounds was this promoted?") has an
 * answer on disk instead of a bare conclusion.
 */
export async function promoteGeneratedRole(role: string, evidence?: string): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  if (!evolutionEnabled()) return false;
  if (ROLE_NAME_RE.test(role) && !RESERVED_ROLE_NAMES.has(role)) {
    const core = await loadTauriCore();
    if (!core) return false;
    const pureHome = await join(await homeDir(), '.pure');
    const markerPath = `subagents/${trialMarkerFileName(role)}`;
    // Read first: promote what is actually there, preserving its parent/registeredAt.
    let previous: RoleTrialState = { status: 'trial' };
    try {
      const raw = await core.invoke<string>('read_file', { workspace: pureHome, path: markerPath });
      previous = trialStateFromMarker(JSON.parse(raw));
    } catch {
      // No marker yet — first promotion.
    }
    try {
      await core.invoke('read_file', { workspace: pureHome, path: `subagents/${role}.json` });
    } catch {
      return false; // the manifest is gone; nothing to promote
    }
    const next: RoleTrialState = {
      ...previous,
      status: 'promoted',
      decidedAt: Date.now(),
      // 落盘**这次转正当时的两侧数字**，而不是一句结论。下次有人问「凭什么转正
      // 的」，账上有答案；只写「不劣于父角色」的话，等于把裁决过程扔掉。
      reason: evidence
        ? trialPromotionReason(role, evidence)
        : t('evolution.team.promoteReason', '结局数据不劣于父角色，用户确认转正'),
    };
    await core.invoke('write_file', { workspace: pureHome, path: markerPath, content: renderTrialMarker(next) });
    // Without this the dashboard keeps showing "trial" and the button stays
    // clickable after a successful promotion — the user can promote forever and
    // nothing ever changes on screen.
    invalidateExternalSubagents();
    return true;
  }
  return false;
}

/**
 * Archive a role: same sidecar, a different verdict — **isolation, not deletion**.
 *
 * The manifest is untouched. What changes is that the role drops off the
 * delegable surface (`delegableExternalSubagents`), which is the entire point of
 * 13.2's 「不达标自动归档」: a variant that lost to the role it was derived from
 * should stop consuming delegations, and a screen that says 「不达标」 while the
 * role keeps taking work is not a lifecycle, just a label.
 *
 * Why not delete the manifest, as the design's wording (「自动归档」) could be read
 * to mean: deletion is a one-way door into the user's own file, it needs a
 * recursive host delete command this gate has no other use for, and the 13.4
 * tool gate already settled the same question the same way (隔离，不删除；用户可看
 * 可删可重新启用). Restore is one write; 删文件即消失 still holds for anyone who
 * wants it gone for good.
 *
 * The role must still exist on disk. A sidecar that outlives its manifest would
 * be an archive for a role nobody has.
 */
export async function archiveGeneratedRole(role: string, evidence?: string): Promise<boolean> {
  if (!isTauriRuntime() || !evolutionEnabled()) return false;
  if (!ROLE_NAME_RE.test(role) || RESERVED_ROLE_NAMES.has(role)) return false;
  const core = await loadTauriCore();
  if (!core) return false;
  const pureHome = await join(await homeDir(), '.pure');
  const markerPath = `subagents/${trialMarkerFileName(role)}`;
  // Read-then-write on purpose: a hand-written role has no sidecar, and archiving
  // one is legitimate — but if we wrote from scratch we would also throw away a
  // `parentRole`/`registeredAt` a hand-edit had put there.
  let previous: RoleTrialState = { status: 'trial' };
  try {
    const raw = await core.invoke<string>('read_file', { workspace: pureHome, path: markerPath });
    previous = trialStateFromMarker(JSON.parse(raw));
  } catch {
    // No sidecar yet — first verdict for this role.
  }
  try {
    await core.invoke('read_file', { workspace: pureHome, path: `subagents/${role}.json` });
  } catch {
    return false; // the manifest is gone; nothing to archive
  }
  const now = Date.now();
  const next: RoleTrialState = {
    ...previous,
    status: 'archived',
    decidedAt: now,
    archivedAt: now,
    // 落盘**当时那组数字**（与转正同理）：下次有人问「凭什么把它归档」，账上有答案，
    // 而不是一句「不达标」。
    reason: evidence
      ? trialArchiveReason(role, evidence)
      : t('evolution.team.archiveReason', '结局数据低于父角色，已自动归档'),
  };
  await core.invoke('write_file', { workspace: pureHome, path: markerPath, content: renderTrialMarker(next) });
  // Writes change what the scan would return; without this the role keeps being
  // offered for delegation until the next app start — i.e. the archive does
  // nothing today.
  invalidateExternalSubagents();
  return true;
}

/**
 * Bring an archived role back: a **new trial**, not a resumed one.
 *
 * `registeredAt` is reset, and that reset is the whole substance of "restore":
 * the trial window is bounded at registration (`trialWindowStart`), so without it
 * the next verdict would read the very delegations that produced the archive and
 * the gate would archive the role again on its next idle pass — a loop the user
 * could never leave. Clearing `decidedAt`/`reason` follows from the same idea: a
 * live trial should not carry a past verdict around as if it were current.
 *
 * `parentRole` is preserved — the lineage is a fact about the role, not about the
 * verdict, and dropping it would strand the restored role at 「未记父角色」 with
 * no way back.
 */
export async function restoreGeneratedRole(role: string): Promise<boolean> {
  if (!isTauriRuntime() || !evolutionEnabled()) return false;
  if (!ROLE_NAME_RE.test(role) || RESERVED_ROLE_NAMES.has(role)) return false;
  const core = await loadTauriCore();
  if (!core) return false;
  const pureHome = await join(await homeDir(), '.pure');
  const markerPath = `subagents/${trialMarkerFileName(role)}`;
  let previous: RoleTrialState;
  try {
    const raw = await core.invoke<string>('read_file', { workspace: pureHome, path: markerPath });
    previous = trialStateFromMarker(JSON.parse(raw));
  } catch {
    return false; // no sidecar = nothing that was ever archived
  }
  if (!isRoleArchived(previous)) return false; // only an archived role can be restored
  try {
    await core.invoke('read_file', { workspace: pureHome, path: `subagents/${role}.json` });
  } catch {
    return false; // the manifest is gone; bring nothing back
  }
  const next: RoleTrialState = {
    ...(previous.parentRole ? { parentRole: previous.parentRole } : {}),
    status: 'trial',
    registeredAt: Date.now(),
  };
  await core.invoke('write_file', { workspace: pureHome, path: markerPath, content: renderTrialMarker(next) });
  invalidateExternalSubagents();
  return true;
}

/**
 * Start a role's trial period: write the sidecar with the parent it was derived
 * from.
 *
 * **This is the load-bearing write of the whole feature.** Without it no role
 * ever carries a `parentRole`, the verdict can never find a baseline to compare
 * against, and "够格转正" is unreachable on real data — the promotion path would
 * be a function nobody can reach. Both drafting entry points (deterministic and
 * model-drafted) call it right after the manifest lands, because that is the one
 * moment the parent role is known: the advice card that triggered the draft names
 * it, and the manifest's own description says "`<role>` 的收窄变体".
 *
 * A role added by hand has no parent. That is honest — nothing knows what it was
 * derived from — so it stays on trial with no baseline and never auto-promotes.
 */
export async function startRoleTrial(role: string, parentRole: string): Promise<boolean> {
  if (!isTauriRuntime() || !evolutionEnabled()) return false;
  if (!ROLE_NAME_RE.test(role) || RESERVED_ROLE_NAMES.has(role)) return false;
  // 血缘校验：模型起草那条路可以自取名字（prompt 里明写 "Append _v2 unless you
  // are deliberately renaming"），于是 `startRoleTrial(draft.name, advice.role)`
  // 可能把一个与父角色毫无关系的角色绑成父子。裁决会拿不相干角色的战绩当基线
  // ——基线找得到，于是读起来像一个正经的对比，实际是错的。
  // 名字不派生自父角色就不记父角色：那个角色会永远停在「未记父角色」，不会转正。
  // 这是保守方向——发不出永久通行证，好过按错误的基线发。
  if (!derivesFrom(role, parentRole)) return false;
  const core = await loadTauriCore();
  if (!core) return false;
  const pureHome = await join(await homeDir(), '.pure');
  const state: RoleTrialState = { status: 'trial', parentRole, registeredAt: Date.now() };
  await core.invoke('write_file', {
    workspace: pureHome,
    path: `subagents/${trialMarkerFileName(role)}`,
    content: renderTrialMarker(state),
  });
  // The cached scan predates this manifest; dropping it is what makes the badge
  // appear on the very next render instead of after a restart.
  invalidateExternalSubagents();
  return true;
}

/** Drop the per-run cache. Called after any write that changes what the scan
 *  would return — otherwise the dashboard keeps rendering the previous state and
 *  the user can click the same action forever. */
export function invalidateExternalSubagents(): void {
  subagentsPromise = null;
}

const ROLE_NAME_RE = /^[a-z][a-z0-9_]{1,63}$/;

/**
 * Does `role` read as a variant of `parentRole`? The deterministic draft is
 * exactly `<parent>_focused`; the model path is told to append `_v2`. So the name
 * must start with the parent **followed by a separator**. Anything else is a
 * rename, and a rename is not evidence of lineage — the advice card diagnosed one
 * role, and a different name is not that role's variant.
 *
 * The separator is not pedantry: a bare prefix test says `researcherfoo` derives
 * from `researcher`, and a lineage claim is what unlocks the baseline comparison
 * — the wrong parent means the verdict is computed against an unrelated role's
 * record while still reading like a proper two-sided comparison.
 */
export function derivesFrom(role: string, parentRole: string): boolean {
  return parentRole.length > 0 && role.startsWith(`${parentRole}_`) && role.length > parentRole.length + 1;
}
