import type { SessionEvent, TranscriptEntry } from './store';
import { projectSessionEvents, projectTranscript, type TranscriptReplayBlock } from './transcriptProjection';

export function projectCanonicalSession(
  events: SessionEvent[] | undefined,
  transcript: TranscriptEntry[] | undefined,
): TranscriptReplayBlock[] {
  if (events?.length) return projectSessionEvents(events);
  return projectTranscript(transcript ?? []);
}
