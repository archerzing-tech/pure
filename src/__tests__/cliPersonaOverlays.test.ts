// src/__tests__/cliPersonaOverlays.test.ts
// P1-2 — CLI 装载侧回退过滤的真跑覆盖。装载路径的基准曾是双层错位（join 到
// 已是 personas 目录的 dir 头上 ⇒ personas/personas/，永不读到 meta，回退过滤
// 整体失效、被回退的 overlay 在 CLI 下照装正文）——这里用真 fs + 真 env 把
// 装载决策锁死。import cliHarness 有模块级副作用（观察 sink 会 mkdir
// ~/.pure/observations），干净可容忍；临时目录经 PURE_PERSONAS_DIR 注入，
// 绝不读写真实的 personas。
import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCliPersonaOverlays } from '../cliHarness';
import { overlayGuardPaths } from '../harness/overlayGuard';

const ROLE = 'researcher';

/** 在临时 personas 目录落 overlay + 护栏旁挂文件（后缀基于 overlay 全名追加——
 *  与 overlayGuardPaths 的 `<role>.overlay.md.*` 同款）。 */
function seedPersona(dir: string, body: string, side: { bak?: string; meta?: object } = {}): void {
  writeFileSync(join(dir, `${ROLE}.overlay.md`), `${body}\n`, 'utf8');
  if (side.bak !== undefined) writeFileSync(join(dir, `${ROLE}.overlay.md.bak`), `${side.bak}\n`, 'utf8');
  if (side.meta) writeFileSync(join(dir, `${ROLE}.overlay.md.meta.json`), `${JSON.stringify(side.meta, null, 2)}\n`, 'utf8');
}

function loadWith(dir: string): Map<string, string> {
  const prev = process.env.PURE_PERSONAS_DIR;
  process.env.PURE_PERSONAS_DIR = dir;
  try {
    return loadCliPersonaOverlays([]);
  } finally {
    if (prev === undefined) delete process.env.PURE_PERSONAS_DIR;
    else process.env.PURE_PERSONAS_DIR = prev;
  }
}

describe('loadCliPersonaOverlays（P1-2 装载侧过滤）', () => {
  it('loads a handwritten overlay (no meta) as-is', () => {
    const home = mkdtempSync(join(tmpdir(), 'pure-cli-p-'));
    try {
      const dir = join(home, 'personas');
      mkdirSync(dir, { recursive: true });
      seedPersona(dir, 'handwritten overlay constraints');
      expect(loadWith(dir).get(ROLE)).toBe('handwritten overlay constraints');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('a reverted overlay with a previous version loads the .bak body, not the reverted body', () => {
    const home = mkdtempSync(join(tmpdir(), 'pure-cli-p-'));
    try {
      const dir = join(home, 'personas');
      mkdirSync(dir, { recursive: true });
      seedPersona(dir, 'reverted overlay constraints', {
        bak: 'previous overlay constraints',
        meta: {
          version: 1,
          writtenAt: 1_000,
          prevExisted: true,
          baseline: { delegations: 10, failures: 0, failureRate: 0 },
          revertedAt: 5_000,
          revertedReason: 'regressed',
        },
      });
      // 路径双层错位的旧 bug 下 meta 读不到 ⇒ 这里会拿到 reverted body（红）。
      expect(loadWith(dir).get(ROLE)).toBe('previous overlay constraints');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('a reverted overlay with no previous version disappears (base persona)', () => {
    const home = mkdtempSync(join(tmpdir(), 'pure-cli-p-'));
    try {
      const dir = join(home, 'personas');
      mkdirSync(dir, { recursive: true });
      seedPersona(dir, 'reverted overlay constraints', {
        meta: {
          version: 1,
          writtenAt: 1_000,
          prevExisted: false,
          baseline: { delegations: 10, failures: 0, failureRate: 0 },
          revertedAt: 5_000,
        },
      });
      expect(loadWith(dir).has(ROLE)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('a reinstated overlay (meta without revert markers) loads its body again', () => {
    const home = mkdtempSync(join(tmpdir(), 'pure-cli-p-'));
    try {
      const dir = join(home, 'personas');
      mkdirSync(dir, { recursive: true });
      seedPersona(dir, 'reinstated overlay constraints', {
        meta: {
          version: 1,
          writtenAt: 1_000,
          prevExisted: true,
          baseline: { delegations: 10, failures: 0, failureRate: 0 },
        },
      });
      expect(loadWith(dir).get(ROLE)).toBe('reinstated overlay constraints');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
