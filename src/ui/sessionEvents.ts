import type { SessionEvent, SessionAgentActivity, TranscriptEntry } from './store';
import { projectSessionEvents, projectTranscript, type TranscriptReplayBlock } from './transcriptProjection';

export function projectCanonicalSession(
  events: SessionEvent[] | undefined,
  transcript: TranscriptEntry[] | undefined,
  /** 第 2 期第四刀收尾：活动档案进投影——孤儿委派卡（结算 ToolResult 没赶上
   *  落盘）据此重建「用户暂停/停掉」的中断结算，而不是谜之「输出中断」灰卡。 */
  agentActivities?: SessionAgentActivity[],
): TranscriptReplayBlock[] {
  if (events?.length) return projectSessionEvents(events, agentActivities);
  return projectTranscript(transcript ?? [], agentActivities);
}
