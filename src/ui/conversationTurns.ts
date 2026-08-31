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
  collapsed: boolean;
}

export const CONVERSATION_COLLAPSE_THRESHOLD = 50;
export const CONVERSATION_RECENT_TURNS = 8;
export const CONVERSATION_HISTORY_CHUNK = 10;

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
    return turns.map(turn => ({ startTurn: turn.index, endTurn: turn.index, turns: [turn], collapsed: false }));
  }

  const splitAt = Math.max(0, turns.length - recentTurns);
  const segments: ConversationSegment[] = [];
  for (let start = 0; start < splitAt; start += chunkSize) {
    const segmentTurns = turns.slice(start, Math.min(splitAt, start + chunkSize));
    segments.push({
      startTurn: segmentTurns[0].index,
      endTurn: segmentTurns[segmentTurns.length - 1].index,
      turns: segmentTurns,
      collapsed: true,
    });
  }
  for (const turn of turns.slice(splitAt)) {
    segments.push({ startTurn: turn.index, endTurn: turn.index, turns: [turn], collapsed: false });
  }
  return segments;
}
