// E0.1 — GUI durable sink for promptObservability. The WebView has no node:fs,
// so records cross into Rust through the append_observation command (JSONL
// under ~/.pure/observations/). The record travels as an opaque JSON string —
// the Rust side never couples to TS schema drift. Persistence is fire-and-
// forget: a failed invoke is swallowed, never surfaced into the run loop.
import type { PromptObservation, PromptObservationSink } from './promptObservability';
import { isTauriRuntime, tauriInvoke } from './tauri';

export function createTauriObservationSink(): PromptObservationSink | undefined {
  if (!isTauriRuntime()) return undefined;
  return {
    append(record: PromptObservation): void {
      tauriInvoke('append_observation', { recordJson: JSON.stringify(record) }).catch(() => { });
    },
  };
}
