// src/evolution/overlayGuardHost.ts
// P1-2 — overlay 回退护栏的 CLI 宿主缝（判定纯核在 src/harness/overlayGuard.ts，
// 这里只做 node:fs IO 与数据源装配——与 memoryDecayTimer 的 GUI 缝同构）。
//
// GUI 把判定挂在与 decay 同一节流窗；CLI 没有常驻定时器，挂点由调用方选
// （runCliSleepCycle 末尾同窗追加）。角色清单自扫 personas/*.overlay.md；
// records 默认与技能闸同源（cli.jsonl）。总开关不在这里判——挂点所属的宿主
// 流程已经把守（runCliSleepCycle 前置 cliEvolutionDisabled）。

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PURE_DIR } from '../cliConfig';
import { FilePromptObservationStore } from '../shared/FilePromptObservationStore';
import type { PromptObservation } from '../shared/promptObservability';
import { runOverlayGuardPass, type OverlayGuardIo } from '../harness/overlayGuard';

const CLI_OBSERVATIONS_PATH = `${PURE_DIR}/observations/cli.jsonl`;

/** CLI overlay-guard 的 node:fs IO 绑定（路径相对 pureHome，overlayGuardPaths 给相对路径）。 */
function cliOverlayGuardIo(pureHome: string): OverlayGuardIo {
  return {
    readFile: async (path) => {
      try {
        return readFileSync(join(pureHome, path), 'utf8');
      } catch {
        return undefined;
      }
    },
    writeFile: async (path, content) => {
      const target = join(pureHome, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, 'utf8');
    },
  };
}

/**
 * CLI 的一轮 overlay 回退判定。回退 = 归档原文 + meta 写 revertedAt（不删
 * 文件、可逆），返回被回退的角色清单供日志/通知。读侧失败静默降级（读不到
 * = 没什么可守）；写侧失败上抛——由挂点兜底（runCliSleepCycle 的 try/catch
 * 把整轮判定降级，绝不影响已完成的进化循环）。
 */
export async function runCliOverlayGuardPass(options: {
  /** pure home（默认 ~/.pure；测试注入临时目录）。 */
  pureHome?: string;
  /** 判卷用的观测记录（默认从 cli.jsonl 读）。 */
  records?: readonly PromptObservation[];
}): Promise<string[]> {
  const pureHome = options.pureHome ?? PURE_DIR;
  let roles: string[] = [];
  try {
    roles = readdirSync(join(pureHome, 'personas'))
      .filter((file) => file.endsWith('.overlay.md'))
      .map((file) => file.replace(/\.overlay\.md$/, ''));
  } catch {
    return []; // 没有 personas 目录 = 没有可守的 overlay
  }
  if (roles.length === 0) return [];
  let records = options.records;
  if (!records) {
    try {
      records = new FilePromptObservationStore(CLI_OBSERVATIONS_PATH).list();
    } catch {
      records = [];
    }
  }
  const report = await runOverlayGuardPass(cliOverlayGuardIo(pureHome), roles, records);
  return report.reverted;
}
