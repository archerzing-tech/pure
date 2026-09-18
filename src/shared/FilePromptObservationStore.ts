import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parsePromptObservations, type PromptObservation, type PromptObservationStore } from './promptObservability';

/** Default retention ≈ 50k records (~64MB at a 1.2KB average record) so a week
 *  of real usage still supports time-window statistics (E0.1 — the old 2k cap
 *  rotated history away faster than it accumulated). */
export const DEFAULT_OBSERVATION_MAX_RECORDS = 50_000;
export const DEFAULT_OBSERVATION_MAX_BYTES = 64 * 1024 * 1024;

/** JSONL sink for local persistence; malformed lines are ignored. The append
 *  path stays cheap (one stat + one append) and the full-file compacting
 *  rewrite runs only when the size budget is exceeded — the previous
 *  rotate-on-every-append design read the whole file per record, which does
 *  not survive a 50k-record budget. */
export class FilePromptObservationStore implements PromptObservationStore {
  constructor(
    private readonly path: string,
    private readonly maxRecords = DEFAULT_OBSERVATION_MAX_RECORDS,
    private readonly maxBytes = DEFAULT_OBSERVATION_MAX_BYTES,
  ) {
    mkdirSync(dirname(path), { recursive: true });
  }

  append(record: PromptObservation): void {
    appendFileSync(this.path, `${JSON.stringify({ schemaVersion: 1, ...record })}\n`, 'utf8');
    try {
      if (statSync(this.path).size > this.maxBytes) this.compact();
    } catch {
      // A stat failure must not fail the observation that was already written.
    }
  }

  private compact(): void {
    const records = this.list();
    if (records.length <= this.maxRecords) return;
    const temporaryPath = `${this.path}.tmp-${process.pid}`;
    writeFileSync(temporaryPath, records.slice(-this.maxRecords).map((item) => `${JSON.stringify({ schemaVersion: 1, ...item })}\n`).join(''), 'utf8');
    renameSync(temporaryPath, this.path);
  }

  list(): PromptObservation[] {
    if (!existsSync(this.path)) return [];
    // Shared parser (same line policy as the GUI dashboard's Rust tail read).
    const records = parsePromptObservations(readFileSync(this.path, 'utf8'));
    return records.slice(-this.maxRecords).map((record) => structuredClone(record));
  }

  clear(): void {
    writeFileSync(this.path, '', 'utf8');
  }
}
