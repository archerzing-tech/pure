import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findChromePath, readDevToolsPort } from '../../channels/rasterize/headlessChrome';
import { CHROME_NOT_FOUND_HINT, closeSharedSession, runBrowserTool, runScreenshotTool } from './browser';
import type { ToolRuntime } from '../runtime';

/** A runtime whose OS-touching primitives all explode: the argument-contract
 * tests below prove malformed calls fail BEFORE any of these can fire. */
const noOsRuntime: ToolRuntime = {
  runArgv: async () => {
    throw new Error('runArgv must not be reached');
  },
  resolveExecutable: async () => {
    throw new Error('resolveExecutable must not be reached');
  },
  launchHeadlessChrome: async () => {
    throw new Error('launchHeadlessChrome must not be reached');
  },
  writeArtifact: async () => {
    throw new Error('writeArtifact must not be reached');
  },
};

describe('browser/screenshot argument contract (no Chrome needed)', () => {
  it('rejects missing and unknown actions without touching any OS primitive', async () => {
    closeSharedSession();
    const noAction = await runBrowserTool({ url: 'data:text/html,x' }, noOsRuntime);
    expect(noAction.ok).toBe(false);
    expect(noAction.output).toContain('navigate / click / type / evaluate / screenshot');

    const unknown = await runBrowserTool({ action: 'scroll' }, noOsRuntime);
    expect(unknown).toEqual({ ok: false, output: 'unknown browser action: scroll' });
  });

  it('validates per-action arguments before the session spins up', async () => {
    closeSharedSession();
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ action: 'navigate' }, 'browser navigate requires a url'],
      [{ action: 'navigate', url: '   ' }, 'browser navigate requires a url'],
      [{ action: 'click' }, 'browser click requires a CSS selector'],
      [{ action: 'type', selector: '#i' }, 'browser type requires text'],
      [{ action: 'type', text: 'hi' }, 'browser type requires a CSS selector'],
      [{ action: 'evaluate' }, 'browser evaluate requires a js expression'],
    ];
    for (const [args, expected] of cases) {
      const outcome = await runBrowserTool(args, noOsRuntime);
      expect(outcome.ok).toBe(false);
      expect(outcome.output).toBe(expected);
    }
  });

  it('no Chrome found reads as an honest hint, not a crash', async () => {
    closeSharedSession();
    const noChrome: ToolRuntime = { ...noOsRuntime, resolveExecutable: async () => null };
    const outcome = await runScreenshotTool({}, noChrome);
    expect(outcome.ok).toBe(false);
    expect(outcome.output).toBe(CHROME_NOT_FOUND_HINT);
  });
});

/** Real-Chrome round-trip: navigate a data: page, read it, edit it, click it,
 * screenshot it. Skipped entirely where no Chrome exists (CI without Chrome
 * stays green; the contract suite above still runs). */
const chromePath = findChromePath();
(chromePath ? describe : describe.skip)('browser tools against real headless Chrome', () => {
  it('navigate → evaluate → type → click → screenshot edits a page end to end', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'pure-browser-it-'));
    const shotDir = mkdtempSync(join(tmpdir(), 'pure-shots-it-'));
    try {
      const proc = Bun.spawn([
        chromePath!,
        '--headless=new', '--remote-debugging-port=0', '--no-first-run',
        '--no-default-browser-check', '--disable-gpu', '--disable-dev-shm-usage',
        '--window-size=1400,900', 'about:blank', `--user-data-dir=${profile}`,
      ], { stdout: 'ignore', stderr: 'pipe' });
      const port = await readDevToolsPort(proc, 30_000);
      expect(port).not.toBeNull();
      const runtime: ToolRuntime = {
        runArgv: async () => {
          throw new Error('runArgv not expected in browser tests');
        },
        resolveExecutable: async () => chromePath!,
        launchHeadlessChrome: async () => ({ port: port!, pid: proc.pid }),
        writeArtifact: async (_kind, basename, bytes) => {
          const target = join(shotDir, basename);
          await Bun.write(target, bytes);
          return target;
        },
      };

      const page = 'data:text/html,<title>pure-bx</title>'
        + '<h1 id="h">hello</h1><input id="i"/>'
        + '<button id="b" onclick="document.getElementById(\'h\').textContent=\'clicked\'">go</button>';

      const navigated = await runBrowserTool({ action: 'navigate', url: page }, runtime);
      expect(navigated.ok).toBe(true);
      expect(navigated.output).toContain('navigated to');

      const title = await runBrowserTool({ action: 'evaluate', expression: 'document.title' }, runtime);
      expect(title.output).toBe('pure-bx');

      const typed = await runBrowserTool({ action: 'type', selector: '#i', text: 'hi there' }, runtime);
      expect(typed.ok).toBe(true);
      const value = await runBrowserTool({ action: 'evaluate', expression: 'document.getElementById("i").value' }, runtime);
      expect(value.output).toBe('hi there');

      const clicked = await runBrowserTool({ action: 'click', selector: '#b' }, runtime);
      expect(clicked.ok).toBe(true);
      const afterClick = await runBrowserTool({ action: 'evaluate', expression: 'document.getElementById("h").textContent' }, runtime);
      expect(afterClick.output).toBe('clicked');

      const missing = await runBrowserTool({ action: 'click', selector: '.does-not-exist' }, runtime);
      expect(missing.ok).toBe(false);
      expect(missing.output).toContain('no element matches');

      const shot = await runScreenshotTool({}, runtime);
      expect(shot.ok).toBe(true);
      expect(shot.output).toContain('Screenshot saved');
      const shotPath = shot.screenshot?.path ?? '';
      expect(existsSync(shotPath)).toBe(true);
      const head = readFileSync(shotPath).subarray(0, 4);
      expect([...head]).toEqual([0x89, 0x50, 0x4e, 0x47]); // PNG magic
      expect(shot.screenshot?.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
      expect(shot.screenshot?.mimeType).toBe('image/png');
    } finally {
      closeSharedSession(); // Browser.close → the spawned Chrome exits
      rmSync(profile, { recursive: true, force: true });
      rmSync(shotDir, { recursive: true, force: true });
    }
  });

  it('a second screenshot reuses the warm session (same Chrome, no relaunch)', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'pure-browser-it2-'));
    const shotDir = mkdtempSync(join(tmpdir(), 'pure-shots-it2-'));
    let launches = 0;
    try {
      const proc = Bun.spawn([
        chromePath!,
        '--headless=new', '--remote-debugging-port=0', '--no-first-run',
        '--no-default-browser-check', '--disable-gpu', '--disable-dev-shm-usage',
        '--window-size=1400,900', 'about:blank', `--user-data-dir=${profile}`,
      ], { stdout: 'ignore', stderr: 'pipe' });
      const port = await readDevToolsPort(proc, 30_000);
      expect(port).not.toBeNull();
      const runtime: ToolRuntime = {
        runArgv: async () => {
          throw new Error('runArgv not expected');
        },
        resolveExecutable: async () => chromePath!,
        launchHeadlessChrome: async () => {
          launches += 1;
          return { port: port!, pid: proc.pid };
        },
        writeArtifact: async (_kind, basename, bytes) => {
          const target = join(shotDir, basename);
          await Bun.write(target, bytes);
          return target;
        },
      };

      await runScreenshotTool({ url: 'data:text/html,<title>one</title>hi' }, runtime);
      await runScreenshotTool({ url: 'data:text/html,<title>two</title>yo' }, runtime);
      // Session warmth is the whole point: one launch serves many calls.
      expect(launches).toBe(1);
    } finally {
      closeSharedSession();
      rmSync(profile, { recursive: true, force: true });
      rmSync(shotDir, { recursive: true, force: true });
    }
  });
});
