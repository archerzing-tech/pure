// src/ui/__tests__/worktreeFinishCard.test.ts
// Pure rendering tests for the wrap-up card (roadmap 4.4). The acceptance
// edges: a plain checkout never renders a card, a settled worktree does —
// with counts, the diff preview and BOTH exits wired to their own targets.

import { describe, expect, it } from 'bun:test';
import {
  renderWorktreeFinish,
  retentionMessage,
  showableWorktreeFinish,
  type WorktreeFinishCardState,
} from '../worktreeFinishCard';
import type { WorktreeFinishStatus } from '../../shared/worktreeFinish';

function status(partial: Partial<WorktreeFinishStatus>): WorktreeFinishStatus {
  return {
    binding: {
      worktreePath: '/home/x/.pure/worktrees/proj-1a2b3c4d/session_b',
      repoRoot: '/home/x/work/proj',
      branch: 'pure/session-b',
      mainBranch: 'main',
    },
    commits: [{ hash: 'abc1234', subject: 'session: feature' }],
    filesChanged: 2,
    stat: ' src/feature.ts | 5 +++++\n 2 files changed',
    uncommitted: 1,
    ...partial,
  };
}

function render(statusOrNull: WorktreeFinishStatus | null, busy: WorktreeFinishCardState['busy'] = null): string {
  return renderWorktreeFinish({ status: statusOrNull, busy });
}

describe('showableWorktreeFinish', () => {
  it('shows only session worktrees with unmerged work', () => {
    expect(showableWorktreeFinish(status({}))).toBe(true);
    // A plain (primary) checkout on branch main — never a card.
    expect(showableWorktreeFinish(status({ binding: { worktreePath: '/w/proj', repoRoot: '/w/proj', branch: 'main', mainBranch: 'main' } }))).toBe(false);
    // Fully merged and clean — nothing to settle.
    expect(showableWorktreeFinish(status({ commits: [], filesChanged: 0, stat: '', uncommitted: 0 }))).toBe(false);
    // Dirty-but-uncommitted still needs settling even with no commits.
    expect(showableWorktreeFinish(status({ commits: [], filesChanged: 0, stat: '', uncommitted: 2 }))).toBe(true);
    expect(showableWorktreeFinish(null)).toBe(false);
  });
});

describe('renderWorktreeFinish', () => {
  it('renders counts, preview, and two distinct actions', () => {
    const html = render(status({}));
    expect(html).toContain('1 个提交');
    expect(html).toContain('2 个文件改动');
    expect(html).toContain('1 个未提交');
    expect(html).toContain('pure/session-b');
    // Diff preview is inert text (stat + commit list), actions carry data attrs.
    expect(html).toContain('wf-diff-stat');
    expect(html).toContain('abc1234');
    expect(html).toContain('data-wf-merge');
    expect(html).toContain('data-wf-discard');
  });

  it('hides zero chips and the preview when there is only uncommitted work', () => {
    const html = render(status({ commits: [], filesChanged: 0, stat: '', uncommitted: 2 }));
    expect(html).not.toContain('0 个提交');
    expect(html).not.toContain('wf-diff');
    expect(html).toContain('2 个未提交');
  });

  it('escapes hostile branch names and subjects (card is innerHTML)', () => {
    const html = render(status({
      binding: { worktreePath: '/w', repoRoot: '/r', branch: 'pure/session-"><img onerror=x>', mainBranch: 'main' },
      commits: [{ hash: 'a', subject: '<script>alert(1)</script>' }],
    }));
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders nothing for null status and disables actions while busy', () => {
    expect(render(null)).toBe('');
    expect(render(status({}), 'merge')).toContain('disabled');
    expect(render(status({}), 'merge')).toContain('合并中');
    expect(render(status({}), 'discard')).toContain('disabled');
  });
});

describe('retentionMessage', () => {
  it('names the counts and the surviving worktree path', () => {
    const msg = retentionMessage(status({}));
    expect(msg).toContain('1 个提交');
    expect(msg).toContain('1 个未提交');
    expect(msg).toContain('/home/x/.pure/worktrees/proj-1a2b3c4d/session_b');
  });
});
