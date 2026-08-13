import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PromptObservation, PromptObservationStore } from './promptObservability';

/** Explicit opt-in JSONL sink for local persistence; malformed lines are ignored. */
export class FilePromptObservationStore implements PromptObservationStore {
  constructor(private readonly path: string, private readonly maxRecords = 2_000) {
    mkdirSync(dirname(path), { recursive: true });
  }

  append(record: PromptObservation): void {
    appendFileSync(this.path, `${JSON.stringify({ schemaVersion: 1, ...record })}\n`, 'utf8');
    const records = this.list();
    if (records.length > this.maxRecords) {
      const retained = records.slice(-this.maxRecords);
      const temporaryPath = `${this.path}.tmp-${process.pid}`;
      writeFileSync(temporaryPath, retained.map((item) => `${JSON.stringify({ schemaVersion: 1, ...item })}\n`).join(''), 'utf8');
      renameSync(temporaryPath, this.path);
    }
  }

  list(): PromptObservation[] {
    if (!existsSync(this.path)) return [];
    const records: PromptObservation[] = [];
    for (const line of readFileSync(this.path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as PromptObservation;
        if (parsed && (parsed.type === 'prompt_assembly' || parsed.type === 'agent_run')) records.push(parsed);
      } catch {
        // A truncated/corrupt line must not hide later observations.
      }
    }
    return records.slice(-this.maxRecords).map((record) => structuredClone(record));
  }

  clear(): void {
    writeFileSync(this.path, '', 'utf8');
  }
}
