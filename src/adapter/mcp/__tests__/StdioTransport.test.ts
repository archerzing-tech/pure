// src/adapter/mcp/__tests__/StdioTransport.test.ts
// Regression guards for StdioTransport's process lifecycle: a missing command
// used to crash the whole CLI as an uncaught 'error' event, and the dead
// process stayed cached (spawn failures emit no 'exit', so the exit cleanup
// never ran).

import { describe, expect, it } from 'bun:test';
import { StdioTransport } from '../StdioTransport';

describe('StdioTransport process lifecycle', () => {
  it('surfaces a missing command as a rejected request instead of an uncaught exception', async () => {
    // Before the 'error' handler existed this test died with the process:
    // ENOENT arrived as an uncaught exception on the ChildProcess.
    const t = new StdioTransport(['definitely-not-a-real-binary-xyz-42', '--flag'], {}, 5_000);
    await expect(t.send('initialize', {})).rejects.toThrow(/command not found|failed to start/);
    await t.close();
  });

  it('evicts a failed spawn from the cache so the next send() respawns instead of writing into a dead stdin', async () => {
    const t = new StdioTransport(['definitely-not-a-real-binary-xyz-42'], {}, 5_000);
    await expect(t.send('initialize', {})).rejects.toThrow();
    // The second send must go through ensureProcess → startProcess again (a
    // fresh spawn attempt) rather than reusing the cached corpse; both fail,
    // but the failure must be a clean request rejection, not EPIPE against a
    // destroyed stream or a hang.
    await expect(t.send('initialize', {})).rejects.toThrow(/command not found|failed to start/);
    await t.close();
  });

  it('rejects pending requests with the stderr tail when the server exits mid-request', async () => {
    // Server prints one diagnostic line to stderr, then exits 3 without ever
    // answering. The pending request must reject promptly with code + stderr.
    const t = new StdioTransport(['sh', '-c', 'echo boom-on-stderr >&2; exit 3'], {}, 5_000);
    await expect(t.send('tools/list', {})).rejects.toThrow(/exited with code 3[\s\S]*boom-on-stderr/);
    await t.close();
  });

  it('still answers requests from a healthy server', async () => {
    // Replies with a real JSON-RPC result carrying the request's own id —
    // the happy-path guard while refactoring exit/error teardown.
    const t = new StdioTransport(
      ['sh', '-c', `while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -E 's/.*"id":([0-9]+).*/\\1/')
  printf '{"jsonrpc":"2.0","id":%s,"result":{"ok":true}}\\n' "$id"
done`],
      {},
      5_000,
    );
    const result = (await t.send('initialize', { p: 1 })) as { ok: boolean };
    expect(result.ok).toBe(true);
    await t.close();
  });
});
