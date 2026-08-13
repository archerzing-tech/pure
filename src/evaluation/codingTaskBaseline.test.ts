import { describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  evaluateCodingTask,
  evaluateCodingTaskSuite,
  writeEvaluationReport,
  type CodingTaskFixture,
} from './codingTaskBaseline';

const fixture: CodingTaskFixture = {
  id: 'writes-answer',
  category: 'feature',
  difficulty: 'easy',
  prompt: 'Create answer.txt.',
  files: { 'README.txt': 'seed' },
  verification: [{
    name: 'answer exists',
    command: 'bun',
    args: ['-e', "if (!(await Bun.file('answer.txt').exists())) process.exit(1)"],
    timeoutMs: 10_000,
  }],
};

describe('coding task baseline', () => {
  it('keeps control verification separate from agent success', async () => {
    const result = await evaluateCodingTask(fixture);
    expect(result.status).toBe('control');
    expect(result.success).toBe(false);
    expect(result.passAt1).toBe(false);
    expect(result.verificationPassed).toBe(false);
  });

  it('passes only when the agent completes and verification passes', async () => {
    const result = await evaluateCodingTask(fixture, {
      agent: async ({ workspace }) => {
        await writeFile(join(workspace, 'answer.txt'), 'ok', 'utf8');
        return undefined;
      },
    });
    expect(result.status).toBe('passed');
    expect(result.agentCompleted).toBe(true);
    expect(result.verificationPassed).toBe(true);
    expect(result.success).toBe(true);
    expect(result.passAt1).toBe(true);
  });

  it('records agent errors without exposing their message', async () => {
    const result = await evaluateCodingTask(fixture, {
      agent: async () => {
        throw new Error('Authorization: Bearer secret-token');
      },
    });
    expect(result.status).toBe('agent_error');
    expect(result.success).toBe(false);
    expect(result.agentError?.kind).toBe('agent_error');
    expect(result.agentError?.hash).toBeDefined();
    expect(JSON.stringify(result)).not.toContain('secret-token');
  });

  it('includes fixture and runtime metadata in suite reports', async () => {
    const report = await evaluateCodingTaskSuite([fixture], {
      metadata: { provider: 'mock', model: 'fixture-agent', promptVersion: 'prompt_test', seed: '1' },
    });
    expect(report.taskCount).toBe(1);
    expect(report.fixtureHash).toMatch(/^[0-9a-f]{8}$/);
    expect(report.metadata.provider).toBe('mock');
    expect(report.metadata.model).toBe('fixture-agent');
    expect(report.metadata.runtime).toContain('bun/');
    expect(report.metadata.platform).toBe(process.platform);
    expect(report.tasks[0].status).toBe('control');
  });

  it('writes a complete report atomically', async () => {
    const directory = await mkdtemp('/tmp/pure-eval-test-');
    try {
      const path = join(directory, 'report.json');
      const report = await evaluateCodingTaskSuite([fixture]);
      await writeEvaluationReport(path, report);
      const parsed = JSON.parse(await readFile(path, 'utf8'));
      expect(parsed.suiteVersion).toBe(report.suiteVersion);
      expect(parsed.fixtureHash).toBe(report.fixtureHash);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
