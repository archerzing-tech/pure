import { describe, expect, it } from 'bun:test';
import { createGreenWatch, isProjectVerificationCommand } from '../stopAtGreen';

function args(command: string): string {
  return JSON.stringify({ command });
}

describe('isProjectVerificationCommand — 项目级验证识别', () => {
  it('认全量验证：脚本名与直调命令', () => {
    for (const command of [
      'bun test',
      'bun run typecheck',
      'bun run build',
      'npm test',
      'npm run lint',
      'pnpm run check',
      'yarn build',
      'npx tsc --noEmit',
      'tsc -p tsconfig.json',
      'vitest run',
      'pytest',
      'python -m pytest',
      'go test ./...',
      'cargo test',
      'make check',
      'eslint .',
    ]) {
      expect(isProjectVerificationCommand(command)).toBe(true);
    }
  });

  it('组合命令按段判定：前置 cd 与后置管道不影响语义', () => {
    expect(isProjectVerificationCommand('cd app && bun test 2>&1 | tail -5')).toBe(true);
    expect(isProjectVerificationCommand('CI=1 bun run typecheck')).toBe(true);
    expect(isProjectVerificationCommand('git add -A && npm test')).toBe(true);
  });

  it('认自建验收脚本：node/bun/npx tsx 跑 verify/e2e/smoke 整页验收', () => {
    for (const command of [
      'node scripts/verify.mjs',
      'cd app && node scripts/verify.mjs 2>&1 | tail -25',
      'bun scripts/verify.ts',
      'bun run scripts/verify.mjs',
      'npx tsx scripts/e2e.ts',
      'node --test',
    ]) {
      expect(isProjectVerificationCommand(command)).toBe(true);
    }
  });

  it('局部跑与开发命令不算项目已绿', () => {
    for (const command of [
      'bun test src/a.test.ts',
      'bun test tests/',
      'pytest tests/test_api.py',
      'vitest run src/foo.spec.ts',
      'tsc src/a.ts',
      'go test ./pkg/foo',
      'npm run dev',
      'bun run test:unit',
      'bun build src/index.ts',
      'cat package.json',
      'ls -la',
      // 自建脚本只认验收面文件名：server/build/seed 不是验收。
      'node server.mjs',
      'node scripts/build-assets.mjs',
      'node scripts/verify.mjs --only src/login.ts',
      // 临时目录的一次性 smoke 不是项目验收。
      'node /tmp/smoke.mjs',
      'node /private/tmp/e2e.mjs',
    ]) {
      expect(isProjectVerificationCommand(command)).toBe(false);
    }
  });

  it('heredoc 正文不是命令：cat 写 smoke 脚本不冒充验收（2026-11-21 真机误报）', () => {
    const command = [
      "cd /repo/app && cat > /tmp/smoke.mjs <<'EOF'",
      "import fs from 'node:fs';",
      "// node scripts/verify.mjs 只是正文里的一句话",
      "console.log('smoke');",
      'EOF',
    ].join('\n');
    expect(isProjectVerificationCommand(command)).toBe(false);
    // 正文之外的那条真命令仍按自己的语义判定。
    expect(isProjectVerificationCommand(`${command}\nnode /tmp/smoke.mjs`)).toBe(false);
    expect(isProjectVerificationCommand(`${command}\nnode scripts/verify.mjs`)).toBe(true);
  });
});

describe('createGreenWatch — 每回合一次收束提醒', () => {
  it('首次项目级验证通过时给出提醒，之后不再重复', () => {
    const watch = createGreenWatch();
    expect(watch.observe('execute_command', args('bun test src/a.test.ts'), true)).toBe('');
    const first = watch.observe('execute_command', args('bun test'), true);
    expect(first).toContain('<stop_at_green>');
    expect(first).toContain('bun test');
    expect(watch.observe('execute_command', args('bun run typecheck'), true)).toBe('');
  });

  it('失败、非命令工具、坏参数都不触发', () => {
    const watch = createGreenWatch();
    expect(watch.observe('execute_command', args('bun test'), false)).toBe('');
    expect(watch.observe('read_file', args('bun test'), true)).toBe('');
    expect(watch.observe('execute_command', '{not json', true)).toBe('');
    expect(watch.observe('execute_command', undefined, true)).toBe('');
  });

  it('观察器彼此独立：子代理/续跑不会吃掉父回合的提醒', () => {
    const parent = createGreenWatch();
    const child = createGreenWatch();
    expect(child.observe('execute_command', args('bun run typecheck'), true)).not.toBe('');
    expect(parent.observe('execute_command', args('npm test'), true)).not.toBe('');
  });
});
