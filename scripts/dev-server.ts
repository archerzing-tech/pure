#!/usr/bin/env bun
// scripts/dev-server.ts
// Start `bun run dev` fully detached from the calling shell so the dev server
// keeps running after the terminal command that launched it exits (nohup +
// disown is not enough in this environment — the command runner reaps the
// process group). The launcher exits immediately; vite writes its own log.
import { writeFileSync } from 'node:fs';

const logPath = '/tmp/pure-dev.log';  const proc = Bun.spawn(['bash', '-c', `exec bun run dev > ${logPath} 2>&1`], {
  cwd: process.cwd(),
  detached: true,
  stdin: 'ignore',
  stdout: 'ignore',
  stderr: 'ignore',
});
writeFileSync('/tmp/pure-dev.pid', String(proc.pid));
console.log(`dev server started (pid ${proc.pid}); log: ${logPath}`);
