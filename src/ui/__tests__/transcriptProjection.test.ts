import { describe, expect, it } from 'bun:test';
import { projectTranscript, rebuildInterruptedToolExec, type TranscriptReplayBlock } from '../transcriptProjection';
import { projectCanonicalSession } from '../sessionEvents';
import type { TranscriptEntry } from '../store';

function types(blocks: TranscriptReplayBlock[]): string[] {
  return blocks.map(block => block.type);
}

describe('projectTranscript', () => {
  it('projects the visible transcript in message order', () => {
    const entries: TranscriptEntry[] = [
      { id: 'u1', modelMessageIndex: 0, role: 'user', content: '请检查项目' },
      {
        id: 'a1',
        modelMessageIndex: 1,
        role: 'assistant',
        content: '我先检查。',
        analysis: '先确认项目结构',
        thinkingPhases: [{ text: '读取配置', assistantIndex: 0 }],
      },
      {
        id: 'a2',
        modelMessageIndex: 2,
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call-1', toolName: 'list_files', args: { path: '.' } }],
      },
      {
        id: 't1',
        modelMessageIndex: 3,
        role: 'tool',
        content: 'src/index.ts',
        toolCallId: 'call-1',
        toolName: 'list_files',
        toolExec: {
          toolName: 'list_files',
          success: true,
          duration: 12,
          args: { path: '.' },
          resultText: 'src/index.ts',
        },
      },
      { id: 'a3', modelMessageIndex: 4, role: 'assistant', content: '检查完成。' },
    ];

    const blocks = projectTranscript(entries);
    expect(types(blocks)).toEqual(['user', 'analysis', 'thinking', 'assistant', 'tool', 'assistant']);
    expect(blocks[1]).toEqual({ type: 'analysis', text: '先确认项目结构' });
    expect(blocks[2]).toEqual({ type: 'thinking', text: '读取配置' });
    expect(blocks[4]).toMatchObject({ type: 'tool', stopped: false, exec: { toolName: 'list_files', resultText: 'src/index.ts' } });
  });

  it('pairs completed tools and marks unreturned calls as stopped', () => {
    const entries: TranscriptEntry[] = [
      {
        id: 'a1',
        modelMessageIndex: 0,
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'call-1', toolName: 'read_file', args: { path: 'a.ts' } },
          { id: 'call-2', toolName: 'read_file', args: { path: 'b.ts' } },
        ],
      },
      {
        id: 't1',
        modelMessageIndex: 1,
        role: 'tool',
        content: 'a',
        toolCallId: 'call-1',
        toolName: 'read_file',
      },
      { id: 'u1', modelMessageIndex: 2, role: 'user', content: '停止' },
    ];

    const blocks = projectTranscript(entries);
    expect(types(blocks)).toEqual(['tool', 'tool', 'user']);
    expect(blocks[0]).toMatchObject({ type: 'tool', stopped: false, exec: { toolName: 'read_file', resultText: 'a', args: { path: 'a.ts' } } });
    expect(blocks[1]).toMatchObject({ type: 'tool', stopped: true, exec: { toolName: 'read_file', args: { path: 'b.ts' } } });
  });

  it('derives legacy artifact cards from successful write tools when metadata is absent', () => {
    const blocks = projectTranscript([
      {
        id: 'call',
        modelMessageIndex: 0,
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'write-1', toolName: 'write_file', args: { path: 'src/app.ts' } }],
      },
      {
        id: 'result',
        modelMessageIndex: 1,
        role: 'tool',
        content: 'written',
        toolCallId: 'write-1',
        toolName: 'write_file',
      },
      { id: 'answer', modelMessageIndex: 2, role: 'assistant', content: '完成' },
    ]);

    expect(blocks.at(-2)).toMatchObject({ type: 'assistant', content: '完成' });
    expect(blocks.at(-1)).toEqual({ type: 'artifact', items: [{ path: 'src/app.ts' }] });
  });

  it('carries the preceding user request into artifact replay context', () => {
    const blocks = projectTranscript([
      { id: 'u1', modelMessageIndex: 0, role: 'user', content: '画一幅图' },
      {
        id: 'a1',
        modelMessageIndex: 1,
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'draw-1', toolName: 'write_file', args: { path: 'tools/draw.py' } }],
      },
      {
        id: 't1',
        modelMessageIndex: 2,
        role: 'tool',
        content: 'written',
        toolCallId: 'draw-1',
        toolName: 'write_file',
      },
      { id: 'a2', modelMessageIndex: 3, role: 'assistant', content: '图片已生成。', artifacts: [{ path: 'output.png' }] },
    ]);

    expect(blocks.at(-1)).toEqual({
      type: 'artifact',
      items: [{ path: 'output.png' }],
      userRequest: '画一幅图',
    });
  });

  it('replays the plan card between the preflight analysis and the reasoning trace', () => {
    const plan = { steps: [{ id: '1', action: '拆模块', description: '', expectedOutcome: '模块边界清晰' }], reasoning: '' };
    const blocks = projectTranscript([{
      id: 'a1',
      modelMessageIndex: 0,
      role: 'assistant',
      content: '开始执行。',
      analysis: '这是一个复杂任务',
      thinkingPhases: [{ text: '读取配置', assistantIndex: 0 }],
      planCard: { plan, currentPlan: 1, currentTodo: 1, complete: false },
    }]);

    expect(types(blocks)).toEqual(['analysis', 'plan', 'thinking', 'assistant']);
    expect(blocks[1]).toEqual({ type: 'plan' });
  });

  it('replays plan assessment and artifact blocks around the assistant message', () => {
    const assessment = {
      intent: 'modify' as const,
      riskLevel: 'low' as const,
      reversibility: 'reversible' as const,
      impact: '只修改一个文件',
      recommendation: '可以执行',
      requiresProbe: false,
      requiresConfirmation: false,
    };
    const blocks = projectTranscript([{
      id: 'pause',
      modelMessageIndex: 0,
      role: 'assistant',
      content: '计划已暂停',
      isPlanPause: true,
      assessment,
      artifacts: [{ path: 'src/app.ts' }],
    }]);

    expect(types(blocks)).toEqual(['assessment', 'assistant', 'artifact']);
    expect(blocks[0]).toMatchObject({ type: 'assessment', assessment });
    expect(blocks[1]).toMatchObject({ type: 'assistant', content: '计划已暂停', isPlanPause: true });
    expect(blocks[2]).toEqual({ type: 'artifact', items: [{ path: 'src/app.ts' }] });
  });

  it('emits ONE deduplicated artifact card per user turn at the turn boundary', () => {
    // Regression: a multi-stage coding project used to render the project-
    // directory card after EVERY assistant message on restore, while live
    // streaming shows it once at turn end — history did not match live.
    const entries: TranscriptEntry[] = [
      { id: 'u1', modelMessageIndex: 0, role: 'user', content: '做一个项目' },
      { id: 'a1', modelMessageIndex: 1, role: 'assistant', content: '', toolCalls: [{ id: 'w1', toolName: 'write_file', args: { path: 'index.html' } }] },
      { id: 't1', modelMessageIndex: 2, role: 'tool', content: 'ok', toolCallId: 'w1', toolName: 'write_file' },
      { id: 'a2', modelMessageIndex: 3, role: 'assistant', content: '第1步完成' },
      { id: 'a3', modelMessageIndex: 4, role: 'assistant', content: '', toolCalls: [{ id: 'w2', toolName: 'write_file', args: { path: 'index.html' } }, { id: 'w3', toolName: 'write_file', args: { path: 'style.css' } }] },
      { id: 't3', modelMessageIndex: 5, role: 'tool', content: 'ok', toolCallId: 'w3', toolName: 'write_file' },
      { id: 'a4', modelMessageIndex: 6, role: 'assistant', content: '全部完成' },
      { id: 'u2', modelMessageIndex: 7, role: 'user', content: '从新设计4个UI界面' },
    ];

    const blocks = projectTranscript(entries);
    const artifactIdx = blocks.map(b => b.type === 'artifact');
    expect(artifactIdx.filter(Boolean)).toHaveLength(1); // exactly ONE card
    // It lands at the turn boundary (before the next user message)…
    expect(blocks[blocks.length - 1].type).toBe('user');
    expect(blocks[blocks.length - 2]).toMatchObject({ type: 'artifact' });
    // …with the turn's files deduplicated into a single list.
    expect(blocks[blocks.length - 2]).toEqual({
      type: 'artifact',
      items: [{ path: 'index.html' }, { path: 'style.css' }],
      userRequest: '做一个项目',
    });
  });

  it('emits artifact card when the transcript ends on a tool result (interrupted session)', () => {
    // Regression: completedTools were only drained into turnArtifactPaths
    // inside the assistant branch, so a transcript ending on a tool entry
    // (interrupted session) silently dropped the artifact card.
    const entries: TranscriptEntry[] = [
      { id: 'u1', modelMessageIndex: 0, role: 'user', content: '写一个文件' },
      { id: 'a1', modelMessageIndex: 1, role: 'assistant', content: '', toolCalls: [{ id: 'w1', toolName: 'write_file', args: { path: 'output.txt' } }] },
      { id: 't1', modelMessageIndex: 2, role: 'tool', content: 'written', toolCallId: 'w1', toolName: 'write_file' },
    ];

    const blocks = projectTranscript(entries);
    expect(blocks.at(-1)).toMatchObject({ type: 'artifact', items: [{ path: 'output.txt' }] });
  });

  it('preserves the edit op so replayed turns can show edited-file cards', () => {
    // Live turns mark edit_file writes with op:'edit' so planArtifactDisplay
    // can guarantee a card for the user's own modified file; the replay
    // projection must carry the same signal, both from tool-exec derivation
    // and from persisted artifact metadata.
    const blocks = projectTranscript([
      { id: 'u1', modelMessageIndex: 0, role: 'user', content: '把 config.json 改成多环境' },
      { id: 'a1', modelMessageIndex: 1, role: 'assistant', content: '', toolCalls: [{ id: 'e1', toolName: 'edit_file', args: { path: 'config.json' } }] },
      { id: 't1', modelMessageIndex: 2, role: 'tool', content: 'edited', toolCallId: 'e1', toolName: 'edit_file' },
      { id: 'a2', modelMessageIndex: 3, role: 'assistant', content: '改完了。', artifacts: [{ path: 'config.json', op: 'edit' }] },
    ]);

    expect(blocks.at(-1)).toEqual({
      type: 'artifact',
      items: [{ path: 'config.json', op: 'edit' }],
      userRequest: '把 config.json 改成多环境',
    });
  });

  it('strips interjection frames so replay shows the user\'s own words (渲染一致性)', () => {
    // 实时回显从来只有用户原话（echo bubble）；引擎转录里存的是框架文。
    // 重放剥壳：三条框架前缀 + 随附协议块剥掉，上屏的是用户自己说的话——
    // 重载后与实时所见一致，不再裸奔框架文。
    const blocks = projectTranscript([
      { id: 'u1', modelMessageIndex: 0, role: 'user', content: '调研一下竞品' },
      {
        id: 'u2',
        modelMessageIndex: 1,
        role: 'user',
        content: '【用户插话·顺路带上】竞品那份先别收\n（这是任务进行中的插话，不是新任务：按 <insertion_protocol> 判断它影响什么，选最小动作，手头的活继续。）',
      },
      {
        id: 'u3',
        modelMessageIndex: 2,
        role: 'user',
        content: '【中途追加的任务，不是闲聊】用户要求在本次任务里追加：顺便查查他们的定价\n执行要求：把这项追加的工作像其他委派一样派出去做完。',
      },
      {
        id: 'u4',
        modelMessageIndex: 3,
        role: 'user',
        content: '【中途取消，不是追加】用户中途收掉了这项工作：定价不用查了\n执行要求：不要再为它派任何委派。',
      },
    ]);
    const userBlocks = blocks.filter((b) => b.type === 'user');
    expect(userBlocks).toHaveLength(4);
    expect((userBlocks[1] as { content: string }).content).toBe('竞品那份先别收');
    expect((userBlocks[2] as { content: string }).content).toBe('顺便查查他们的定价');
    expect((userBlocks[3] as { content: string }).content).toBe('定价不用查了');
  });

  it('drops host machinery lines entirely (they are not the user\'s voice)', () => {
    // 【系统接管执行】是宿主给模型的合并口径，实时路径从不上屏；重放也要
    // 整条跳过，不能把它渲染成用户气泡冒充用户说话。
    const blocks = projectTranscript([
      { id: 'u1', modelMessageIndex: 0, role: 'user', content: '调研竞品' },
      {
        id: 'u2',
        modelMessageIndex: 1,
        role: 'user',
        content: '【系统接管执行】用户中途追加的任务「查定价」将在本轮由系统直接委派给 researcher 执行，结果稍后回收到本对话。',
      },
      { id: 'a1', modelMessageIndex: 2, role: 'assistant', content: '好的。' },
    ]);
    const userBlocks = blocks.filter((b) => b.type === 'user');
    expect(userBlocks).toHaveLength(1);
    expect((userBlocks[0] as { content: string }).content).toBe('调研竞品');
  });

  it('never strips 执行要求 from a genuine unframed user message', () => {
    // 尾部协议块只在认得框架前缀时才剥——用户自己的消息里出现「执行要求：」
    // 不许误伤。
    const blocks = projectTranscript([
      { id: 'u1', modelMessageIndex: 0, role: 'user', content: '写个脚本\n执行要求：带错误处理' },
    ]);
    expect((blocks[0] as { content: string }).content).toBe('写个脚本\n执行要求：带错误处理');
  });
});

describe('orphaned delegation cards rebuild the user interruption from the activity ledger (第 2 期第四刀收尾)', () => {
  // 场景：用户暂停/停掉一支子 agent 后整轮被掐（Esc/暂停），这支的结算
  // ToolResult 没赶上落盘——转录只剩 tool_call，回放此前一律渲染成
  // 「本轮输出在此中断」的谜之灰卡，用户主动中断的事实全丢。
  const entries: TranscriptEntry[] = [
    {
      id: 'a1',
      modelMessageIndex: 0,
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'call-paused', toolName: 'researcher', args: { topic: '竞品分析' } },
        { id: 'call-orphan', toolName: 'read_file', args: { path: 'a.ts' } },
      ],
    },
    { id: 'u1', modelMessageIndex: 1, role: 'user', content: '继续' },
  ];

  it('rebuilds a paused delegation from the ledger: grey settlement + trace narrative, never the mystery line', () => {
    const blocks = projectTranscript(entries, [
      {
        callId: 'call-paused',
        agentName: '资料调研',
        lifecycle: 'paused',
        status: 'paused',
        toolTrace: [
          { name: 'web_search', args: 'query=竞品', status: 'completed' },
          { name: 'read_file', args: 'path=notes.md', status: 'running' },
        ],
      },
    ]);
    const toolBlocks = blocks.filter((b) => b.type === 'tool') as Array<Extract<TranscriptReplayBlock, { type: 'tool' }>>;
    expect(toolBlocks).toHaveLength(2);
    const paused = toolBlocks[0];
    expect(paused.stopped).toBe(true);
    expect(paused.exec.outcome).toBe('paused');
    expect(paused.exec.success).toBe(true);
    expect(paused.exec.resultText).toContain('已暂停');
    expect(paused.exec.subagentTrace).toEqual(['✓ web_search 完成', '→ read_file path=notes.md']);
    // 非委派/无档案的孤儿仍走原兜底（谜之灰卡只属于真被捎死的调用）。
    expect(toolBlocks[1].exec.outcome).toBeUndefined();
    expect(toolBlocks[1]).toMatchObject({ stopped: true, exec: { success: false } });
  });

  it('rebuilds a cancelled delegation with the stopped wording', () => {
    const blocks = projectTranscript(entries, [
      { callId: 'call-paused', agentName: '资料调研', lifecycle: 'cancelled', status: 'cancelled' },
    ]);
    const toolBlocks = blocks.filter((b) => b.type === 'tool') as Array<Extract<TranscriptReplayBlock, { type: 'tool' }>>;
    expect(toolBlocks[0].exec.outcome).toBe('stopped');
    expect(toolBlocks[0].exec.resultText).toContain('已按你的要求停止');
  });

  it('keeps the historic fallback when the ledger has no entry for the call', () => {
    const blocks = projectTranscript(entries, [
      { callId: 'call-other', agentName: '资料调研', lifecycle: 'paused' },
    ]);
    const toolBlocks = blocks.filter((b) => b.type === 'tool') as Array<Extract<TranscriptReplayBlock, { type: 'tool' }>>;
    expect(toolBlocks[0].exec.outcome).toBeUndefined();
    expect(toolBlocks[1].exec.outcome).toBeUndefined();
    expect(toolBlocks[0]).toMatchObject({ stopped: true, exec: { success: false } });
    expect(toolBlocks[1]).toMatchObject({ stopped: true, exec: { success: false } });
  });

  it('rebuild works through the canonical entrypoint (v3 events path)', () => {
    const eventSession: import('../store').SessionEvent[] = [
      { id: 'e1', type: 'assistant', toolCalls: [{ id: 'call-paused', toolName: 'researcher', args: { topic: '竞品分析' } }] },
      { id: 'e2', type: 'user', content: '继续' },
    ];
    const blocks = projectCanonicalSession(eventSession, [], [
      { callId: 'call-paused', agentName: '资料调研', lifecycle: 'paused', toolTrace: [{ name: 'web_search', status: 'completed' }] },
    ]);
    const toolBlocks = blocks.filter((b) => b.type === 'tool') as Array<Extract<TranscriptReplayBlock, { type: 'tool' }>>;
    expect(toolBlocks[0].exec.outcome).toBe('paused');
    expect(toolBlocks[0].exec.subagentTrace).toEqual(['✓ web_search 完成']);
  });

  it('rebuildInterruptedToolExec keeps the plain fallback for a non-terminal lifecycle', () => {
    // lifecycle 未到终态（running/done/failed…）的档案不参与重建——那是
    // 回合中断的另一种兜底（stopped:true 谜之灰卡）的事，不是中断结算。
    const exec = rebuildInterruptedToolExec(
      { callId: 'call-x', agentName: '资料调研', lifecycle: 'started' },
      { id: 'call-x', toolName: 'researcher', args: {} },
    );
    expect(exec.outcome).toBeUndefined();
    expect(exec.success).toBe(false);
  });
});
