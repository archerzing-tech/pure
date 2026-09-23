import { formatHistoryGroupSummary, TRANSCRIPT_GROUP_THRESHOLD, TRANSCRIPT_GROUP_TURNS, TRANSCRIPT_RECENT_PLAIN_TURNS } from './transcriptHistory';
import type { TranscriptReplayBlock } from './transcriptProjection';

export interface ConversationTurn {
  index: number;
  userText: string;
  blocks: TranscriptReplayBlock[];
}

export interface ConversationSegment {
  startTurn: number;
  endTurn: number;
  turns: ConversationTurn[];
  /**
   * Older-than-recent turns. They render as a collapsible group that is
   * EXPANDED BY DEFAULT and rendered on demand as it approaches the viewport —
   * collapsing history by default made a reopened conversation look like it had
   * lost everything except the last few turns (the cards of every older turn
   * were parked behind a closed <details>).
   */
  historical: boolean;
}

// The folding thresholds live in transcriptHistory.ts — the live transcript
// folds with the SAME numbers, so a session looks identical no matter whether
// it was reopened from disk or streamed live.
export const CONVERSATION_COLLAPSE_THRESHOLD = TRANSCRIPT_GROUP_THRESHOLD;
export const CONVERSATION_RECENT_TURNS = TRANSCRIPT_RECENT_PLAIN_TURNS;
export const CONVERSATION_HISTORY_CHUNK = TRANSCRIPT_GROUP_TURNS;

export function groupConversationTurns(blocks: TranscriptReplayBlock[]): {
  preamble: TranscriptReplayBlock[];
  turns: ConversationTurn[];
} {
  const preamble: TranscriptReplayBlock[] = [];
  const turns: ConversationTurn[] = [];
  let current: ConversationTurn | null = null;

  for (const block of blocks) {
    if (block.type === 'user') {
      if (current) turns.push(current);
      current = { index: turns.length + 1, userText: block.content, blocks: [block] };
    } else if (current) {
      current.blocks.push(block);
    } else {
      preamble.push(block);
    }
  }
  if (current) turns.push(current);
  return { preamble, turns };
}

export function segmentConversationTurns(
  turns: ConversationTurn[],
  threshold = CONVERSATION_COLLAPSE_THRESHOLD,
  recentTurns = CONVERSATION_RECENT_TURNS,
  chunkSize = CONVERSATION_HISTORY_CHUNK,
): ConversationSegment[] {
  if (turns.length <= threshold) {
    return turns.map(turn => ({ startTurn: turn.index, endTurn: turn.index, turns: [turn], historical: false }));
  }

  const splitAt = Math.max(0, turns.length - recentTurns);
  const segments: ConversationSegment[] = [];
  for (let start = 0; start < splitAt; start += chunkSize) {
    const segmentTurns = turns.slice(start, Math.min(splitAt, start + chunkSize));
    segments.push({
      startTurn: segmentTurns[0].index,
      endTurn: segmentTurns[segmentTurns.length - 1].index,
      turns: segmentTurns,
      historical: true,
    });
  }
  for (const turn of turns.slice(splitAt)) {
    segments.push({ startTurn: turn.index, endTurn: turn.index, turns: [turn], historical: false });
  }
  return segments;
}

export interface ConversationSegmentStats {
  turnCount: number;
  toolCalls: number;
  artifacts: number;
}

/** Counts worth seeing on a collapsed group header: how much work is inside,
 *  so a closed group never reads as "empty history". */
export function summarizeSegmentTurns(turns: ConversationTurn[]): ConversationSegmentStats {
  let toolCalls = 0;
  let artifacts = 0;
  for (const turn of turns) {
    for (const block of turn.blocks) {
      if (block.type === 'tool') toolCalls++;
      else if (block.type === 'artifact') artifacts += block.items.length;
    }
  }
  return { turnCount: turns.length, toolCalls, artifacts };
}

export function formatSegmentSummary(segment: ConversationSegment): string {
  const stats = summarizeSegmentTurns(segment.turns);
  return formatHistoryGroupSummary({
    startTurn: segment.startTurn,
    endTurn: segment.endTurn,
    turnCount: stats.turnCount,
    toolCalls: stats.toolCalls,
    artifacts: stats.artifacts,
    preview: segment.turns[0]?.userText,
  });
}
