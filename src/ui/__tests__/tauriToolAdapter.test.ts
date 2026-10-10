// src/ui/__tests__/tauriToolAdapter.test.ts

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { formatCommandOutput, buildCommandResult, formatWriteProgress, buildWebSearchArgs, buildCodeSearchArgs, filterResearchSources, researchLimits, TauriToolAdapter, parseCommandStreamChunk, resolveDownloadOutSpec, buildDownloadCommand } from '../TauriToolAdapter';
import type { ToolCall } from '../../shared/types';
import { formatCommandError, formatBytes } from '../../shared/format';
import {
  benchmarkUrlFor,
  checkGuiProbeTarget,
  classifyGuiHttpProbe,
  isReservedProbeIp,
} from '../TauriToolAdapter';
// GUI 侧的护栏/归因/渲染现在与 CLI 同源（shared/netProbeCore）：GUI 不再自带
// 一份 report 类型与渲染器，那正是本轮收口删掉的重复。
import { renderProbeReport, renderProbeReportForHuman, type NetProbeReport } from '../../shared/netProbeCore';
import { recordNetFailure, recordNetSuccess } from '../../shared/netGuard';

describe('formatCommandOutput', () => {
  it('joins plain stdout lines', () => {
    expect(formatCommandOutput([
      { kind: 'stdout', line: 'line one' },
      { kind: 'stdout', line: 'line two' },
    ])).toBe('line one\nline two');
  });

  it('labels stderr sections with [stderr]', () => {
    expect(formatCommandOutput([
      { kind: 'stdout', line: 'ok' },
      { kind: 'stderr', line: 'warn' },
    ])).toBe('ok\n\n[stderr]\nwarn');
  });

  it('separates multiple stderr sections', () => {
    expect(formatCommandOutput([
      { kind: 'stderr', line: 'err a' },
      { kind: 'stderr', line: 'err b' },
      { kind: 'stdout', line: 'out' },
      { kind: 'stderr', line: 'err c' },
    ])).toBe('[stderr]\nerr a\nerr b\nout\n\n[stderr]\nerr c');
  });

  it('handles empty input', () => {
    expect(formatCommandOutput([])).toBe('');
  });
});

describe('formatCommandError', () => {
  it('includes the exit code and appends output when present', () => {
    expect(formatCommandError(3, '[stderr]\nboom')).toBe('Command failed with exit code 3:\n[stderr]\nboom');
  });

  it('omits output when empty', () => {
    expect(formatCommandError(1, '')).toBe('Command failed with exit code 1');
  });

  it('trims surrounding whitespace from the output tail', () => {
    expect(formatCommandError(2, '  some output  ')).toBe('Command failed with exit code 2:\nsome output');
  });
});

describe('buildCommandResult', () => {
  it('reports success with the output for exit code 0', () => {
    const r = buildCommandResult(0, [{ kind: 'stdout', line: 'ok' }]);
    expect(r.success).toBe(true);
    expect(r.error).toBeUndefined();
    expect(r.result).toBe('ok');
  });

  it('reports failure with the exit code in the error for non-zero exits', () => {
    const r = buildCommandResult(3, [{ kind: 'stderr', line: 'boom' }]);
    expect(r.success).toBe(false);
    expect(r.error).toContain('exit code 3');
    expect(r.error).toContain('boom'); // stderr survives into the failure message
    expect(r.result).toContain('[stderr]'); // output is labeled, not swallowed
  });

  it('keeps output in the result even when the command fails', () => {
    const r = buildCommandResult(2, [{ kind: 'stdout', line: 'partial' }]);
    expect(r.success).toBe(false);
    expect(r.error).toContain('partial');
    expect(r.result).toBe('partial');
  });
});

describe('formatBytes', () => {
  it('formats bytes, KB, and MB', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(12 * 1024)).toBe('12.0 KB');
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB');
  });
});

describe('buildWebSearchArgs (Rust web_search invoke arg lock)', () => {
  it('passes the query, default maxResults, and both API keys', () => {
    expect(buildWebSearchArgs('/ws', { query: '西安到重庆 机票' }, 'tvly-1', 'serper-2')).toEqual({
      workspace: '/ws',
      query: '西安到重庆 机票',
      maxResults: 10,
      apiKey: 'tvly-1',
      serperApiKey: 'serper-2',
    });
  });

  it('keeps a caller-supplied maxResults and defaults empty keys to empty strings', () => {
    expect(buildWebSearchArgs('/ws', { query: 'rust', maxResults: 5 }, '', '')).toEqual({
      workspace: '/ws',
      query: 'rust',
      maxResults: 5,
      apiKey: '',
      serperApiKey: '',
    });
  });

  it('forwards a configured proxy only when one is enabled', () => {
    expect(buildWebSearchArgs('/ws', { query: 'rust' }, '', '', 'socks5://127.0.0.1:1080').proxyUrl)
      .toBe('socks5://127.0.0.1:1080');
  });

  it('forwards the configured location so the Tier-2 weather fallback works', () => {
    expect(buildWebSearchArgs('/ws', { query: '明天天气' }, '', '', '', '上海').location)
      .toBe('上海');
    expect(buildWebSearchArgs('/ws', { query: '明天天气' }, '', '', '', '').location)
      .toBeUndefined();
  });
});

describe('research tool argument contracts', () => {
  it('forwards the full code search contract to Rust', () => {
    expect(buildCodeSearchArgs('/ws', {
      query: 'useActionState',
      path: 'src',
      globs: ['*.ts', '!*.test.ts'],
      caseSensitive: false,
      maxResults: 7,
      globalMaxResults: 19,
      timeoutSeconds: 4,
    })).toEqual({
      workspace: '/ws',
      query: 'useActionState',
      path: 'src',
      globs: ['*.ts', '!*.test.ts'],
      caseSensitive: false,
      maxResults: 7,
      globalMaxResults: 19,
      timeoutSeconds: 4,
    });
  });

  it('filters sources by hostname and clamps research limits', () => {
    const sources = [
      { title: 'Docs', snippet: 'x', url: 'https://docs.example.com/api' },
      { title: 'Other', snippet: 'y', url: 'https://other.example.net' },
    ];
    expect(filterResearchSources(sources, ['example.com'])).toEqual([sources[0]]);
    expect(researchLimits({ maxSources: 99, maxCharsPerSource: 1 })).toEqual({ maxSources: 8, maxCharsPerSource: 500 });
  });
});

function toolCall(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `test_${name}`, index: 0, function: { name, arguments: JSON.stringify(args) } };
}

describe('create_document save path', () => {
  it('saves via save_file_binary with the camelCase dataBase64 key', async () => {
    // Regression: the snake_case `data_base64` spelling is rejected by the
    // Tauri v2 IPC layer ("required key dataBase64") — binary documents never
    // reached disk even though generation succeeded.
    let seen: Record<string, unknown> = {};
    const invoke = async (command: string, args?: Record<string, unknown>) => {
      seen = args ?? {};
      return '';
    };
    const result = await new TauriToolAdapter('/ws', '', '', '', invoke).execute(
      toolCall('create_document', { format: 'docx', path: '报告.docx', spec: { sections: [{ type: 'paragraph', text: 'hello' }] } }),
    );
    expect(result.success).toBe(true);
    expect(seen.path).toBe('报告.docx');
    expect(seen.dataBase64).toBeTypeOf('string');
    expect(String(seen.dataBase64).length).toBeGreaterThan(0);
    // The binary payload must decode — i.e. the base64 round-trips.
    expect(atob(String(seen.dataBase64)).startsWith('PK')).toBe(true);
  });
});

describe('dynamic capability tools', () => {
  it('aggregates official MCP candidates and community search results', async () => {
    const invoke = async (command: string) => {
      if (command === 'web_fetch') {
        return JSON.stringify({
          servers: [{
            server: {
              name: 'com.example/crm',
              title: 'CRM MCP',
              description: 'CRM records',
              version: '1.0.0',
              remotes: [{ type: 'streamable-http', url: 'https://example.com/crm/mcp' }],
            },
          }],
        });
      }
      if (command === 'web_search') return '1. Community CRM MCP\n   hosted directory\n   https://mcp.so/crm';
      throw new Error(`unexpected command: ${command}`);
    };
    const adapter = new TauriToolAdapter('/ws', '', '', '', invoke);
    const result = await adapter.execute(toolCall('search_mcp_servers', { query: 'CRM', maxResults: 5 }));
    expect(result.success).toBe(true);
    const payload = JSON.parse(String(result.result)) as { directories: string[]; candidates: Array<{ id: string; source: string; config?: unknown }> };
    expect(payload.directories).toEqual(['official-registry', 'community-search']);
    expect(payload.candidates.some((candidate) => candidate.id === 'mcp:com.example/crm:1.0.0' && candidate.config)).toBe(true);
    expect(payload.candidates.some((candidate) => candidate.source === 'community-search')).toBe(true);
  });

  it('connects only a searched MCP candidate and returns newly discovered tools', async () => {
    let connectedName = '';
    const invoke = async (command: string) => command === 'web_fetch'
      ? JSON.stringify({ servers: [{ server: { name: 'com.example/crm', version: '1.0.0', remotes: [{ type: 'streamable-http', url: 'https://example.com/mcp' }] } }] })
      : 'No results found';
    const adapter = new TauriToolAdapter('/ws', '', '', '', invoke, 'session-1', '', undefined, '', {
      connectMcpServer: async (config) => {
        connectedName = config.name;
        return { tools: [{ name: `${config.name}__lookup`, description: 'lookup', input_schema: { type: 'object' } }], persisted: true };
      },
    });
    await adapter.execute(toolCall('search_mcp_servers', { query: 'CRM' }));
    const result = await adapter.execute(toolCall('connect_mcp_server', { candidateId: 'mcp:com.example/crm:1.0.0' }));
    expect(result.success).toBe(true);
    expect(connectedName).toBe('com.example/crm');
    expect(String(result.result)).toContain('com.example/crm__lookup');
  });
});

describe('Tauri Tier-2/3 web tool execution paths', () => {
  it('forwards web_public_api with the search keys, location, and searchOnMiss', async () => {
    let seen: Record<string, unknown> = {};
    const invoke = async (command: string, args?: Record<string, unknown>) => {
      expect(command).toBe('web_public_api');
      seen = args ?? {};
      return '[Frankfurter (ECB)] 1 USD = 7.2 CNY';
    };
    const result = await new TauriToolAdapter('/ws', 'tvly-1', 'serper-2', '上海', invoke).execute(toolCall('web_public_api', { query: '1 usd to cny' }));
    expect(result.success).toBe(true);
    expect(String(result.result)).toContain('[Frankfurter (ECB)]');
    expect(seen).toMatchObject({
      workspace: '/ws',
      query: '1 usd to cny',
      apiKey: 'tvly-1',
      serperApiKey: 'serper-2',
      location: '上海',
      searchOnMiss: true,
    });
  });

  it('forwards web_scrape with the selector and maxChars contract', async () => {
    let seen: Record<string, unknown> = {};
    const invoke = async (command: string, args?: Record<string, unknown>) => {
      expect(command).toBe('web_scrape');
      seen = args ?? {};
      return 'Scraped content';
    };
    const result = await new TauriToolAdapter('/ws', '', '', '', invoke).execute(toolCall('web_scrape', { url: 'https://example.com/page', selector: '#main', maxChars: 5000 }));
    expect(result.success).toBe(true);
    expect(String(result.result)).toBe('Scraped content');
    expect(seen).toMatchObject({
      workspace: '/ws',
      url: 'https://example.com/page',
      selector: '#main',
      maxChars: 5000,
    });
  });

  it('defaults web_scrape selector to null when omitted', async () => {
    let seen: Record<string, unknown> = {};
    const invoke = async (_command: string, args?: Record<string, unknown>) => {
      seen = args ?? {};
      return 'ok';
    };
    await new TauriToolAdapter('/ws', '', '', '', invoke).execute(toolCall('web_scrape', { url: 'https://example.com' }));
    expect(seen.selector).toBeNull();
    expect(seen.maxChars).toBe(20000);
  });
});

describe('Tauri researcher execution paths', () => {
  it('reports empty web research as a failed tool result', async () => {
    const invoke = async (command: string) => command === 'web_search' ? 'No results found' : '';
    const result = await new TauriToolAdapter('/ws', '', '', '', invoke).execute(toolCall('researcher_web', { prompt: 'missing' }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('No usable research sources');
  });

  it('fetches documentation evidence and preserves the structured payload', async () => {
    const calls: string[] = [];
    const invoke = async (command: string) => {
      calls.push(command);
      if (command === 'web_search') return ['1. React docs', '   API reference', '   https://docs.example.com/react'].join('\n');
      if (command === 'web_fetch') return 'useActionState reference';
      throw new Error(`unexpected command: ${command}`);
    };
    const result = await new TauriToolAdapter('/ws', '', '', '', invoke).execute(toolCall('researcher_docs', {
      library: 'React',
      topic: 'useActionState',
      maxSources: 1,
    }));
    expect(result.success).toBe(true);
    expect(calls).toEqual(['web_search', 'web_fetch']);
    const payload = JSON.parse(String(result.result)) as { sources: Array<{ content?: string }>; officialVerified?: boolean };
    expect(payload.sources[0].content).toBe('useActionState reference');
    expect(payload.officialVerified).toBe(false);
  });
});

describe('Tauri workspace snapshots', () => {
  it('captures and restores a write through the IPC contract', async () => {
    let exists = true;
    let content = 'before';
    const invoke = async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
      if (command === 'path_info') return { exists, isDirectory: false };
      if (command === 'read_file') return content;
      if (command === 'write_file') {
        exists = true;
        content = String(args?.content ?? '');
        return `Wrote ${content.length} bytes`;
      }
      if (command === 'remove_path') {
        exists = false;
        return 'Removed';
      }
      throw new Error(`unexpected command: ${command}`);
    };
    const adapter = new TauriToolAdapter('/ws', '', '', '', invoke, 'session-tauri');
    const changed = await adapter.execute(toolCall('write_file', { path: 'app.ts', content: 'after' }));
    expect(changed.success).toBe(true);
    expect(adapter.getSnapshotPort().getLatestWriteBatch()?.sessionId).toBe('session-tauri');
    const restored = await adapter.getSnapshotPort().undoLastWriteBatch();
    expect(restored.restored).toBe(true);
    expect(content).toBe('before');
  });

  it('does not restore over a newer external value', async () => {
    let exists = false;
    let content = '';
    const invoke = async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
      if (command === 'path_info') return { exists, isDirectory: false };
      if (command === 'read_file') return content;
      if (command === 'write_file') { exists = true; content = String(args?.content ?? ''); return 'Wrote'; }
      if (command === 'remove_path') { exists = false; return 'Removed'; }
      throw new Error(`unexpected command: ${command}`);
    };
    const adapter = new TauriToolAdapter('/ws', '', '', '', invoke);
    await adapter.execute(toolCall('write_file', { path: 'new.ts', content: 'agent' }));
    content = 'user';
    const result = await adapter.getSnapshotPort().undoLastWriteBatch();
    expect(result.restored).toBe(false);
    expect(result.conflicts).toEqual(['new.ts']);
    expect(content).toBe('user');
  });
});

describe('formatWriteProgress (Rust write_file_stream protocol lock)', () => {
  it('formats the exact line the adapter streams for a progress event', () => {
    // 230/512 KB = 44.9% → 45%; mirrors the Rust {type,written,total} event.
    expect(formatWriteProgress('src/foo.ts', 230 * 1024, 512 * 1024))
      .toBe('正在写入 src/foo.ts — 45% (230.0 KB/512.0 KB)');
  });

  it('treats a zero-total (empty file) as 100%', () => {
    expect(formatWriteProgress('empty.txt', 0, 0))
      .toBe('正在写入 empty.txt — 100% (0 B/0 B)');
  });

  it('shows the full write at the final chunk', () => {
    expect(formatWriteProgress('big.bin', 1024 * 1024, 1024 * 1024))
      .toBe('正在写入 big.bin — 100% (1.0 MB/1.0 MB)');
  });
});

describe('parseCommandStreamChunk (execute_command_stream protocol lock)', () => {
  it('parses a stdout progress chunk (lone-\\r redraw from the Rust splitter)', () => {
    expect(parseCommandStreamChunk('{"type":"stdout","content":"Downloading 45%","progress":true}'))
      .toEqual({ type: 'stdout', line: 'Downloading 45%', progress: true });
  });

  it('marks non-progress chunks progress:false even when progress is omitted', () => {
    expect(parseCommandStreamChunk('{"type":"stdout","content":"line"}'))
      .toEqual({ type: 'stdout', line: 'line', progress: false });
    expect(parseCommandStreamChunk('{"type":"stderr","content":"warn","progress":false}'))
      .toEqual({ type: 'stderr', line: 'warn', progress: false });
  });

  it('parses the exit event and falls back to -1 for a bad code', () => {
    expect(parseCommandStreamChunk('{"type":"exit","code":3}'))
      .toEqual({ type: 'exit', code: 3 });
    expect(parseCommandStreamChunk('{"type":"exit"}'))
      .toEqual({ type: 'exit', code: -1 });
  });

  it('coerces a non-string content into a string line', () => {
    expect(parseCommandStreamChunk('{"type":"stdout","content":42}'))
      .toEqual({ type: 'stdout', line: '42', progress: false });
  });

  it('returns null for malformed JSON and unknown shapes', () => {
    expect(parseCommandStreamChunk('not json')).toBeNull();
    expect(parseCommandStreamChunk('{"type":"progress"}')).toBeNull();
    expect(parseCommandStreamChunk('null')).toBeNull();
  });
});

// The native download_file_stream path must carry the same cancel wiring as
// the shell path: a Stop (engine aborts the tool signal) asks the Rust backend
// to kill the transfer — download_file_stream registers a cancel channel under
// the toolCall id and kill_command fires it. Without this, a stopped download
// kept running to completion in the background (bandwidth + a file nobody is
// waiting for), and the cancelled outcome fell through to the shell chain.
describe('native download cancel wiring', () => {
  const readSource = (url: URL): string => readFileSync(url, 'utf8');

  it('native download_file wires abort → kill_command and reports cancelled', () => {
    const src = readSource(new URL('../TauriToolAdapter.ts', import.meta.url));
    // 锚点随出口路由改造变过一次：download_file_stream 现在由 runNative(proxyUrl)
    // 闭包发起（首选路由失败后换反向路由整体重下一次），不再是裸的 inline await。
    // 取消接线本身没动，仍是「listener 先于调用安装」。
    const nativeIdx = src.indexOf("const runNative = (proxyUrl: string): Promise<number> => this.call('download_file_stream'");
    expect(nativeIdx).toBeGreaterThan(-1);
    // Look backwards from the call: the listener must be installed BEFORE the
    // await so a pre-aborted signal still cancels instantly. (The onmessage
    // handler between listener and call is long — give the window room.)
    const before = src.slice(Math.max(0, nativeIdx - 2600), nativeIdx);
    expect(before).toContain("const onAbort = () => {");
    expect(before).toContain("this.call('kill_command', { id: toolCall.id }).catch(() => {});");
    expect(before).toContain('if (signal?.aborted) onAbort();');
    // Look forwards: the cancelled outcome wins over the failure path, and a
    // normal completion removes the listener so a reused signal can't fire a
    // stale kill.
    // Window widened (3600→4400) when S2 mirror retry added lines inside the
    // block; the assertions themselves are unchanged.
    const after = src.slice(nativeIdx, nativeIdx + 4400);
    expect(after).toContain('if (cancelled && code !== 0) {');
    expect(after).toContain("'Download cancelled by user.'");
    expect(after).toContain("signal?.removeEventListener('abort', onAbort);");
  });
});

// ── download_file destination 解析（2026-10-09 真机修复回归）──────────
// 两条下载链都把 outSpec 当「目录」拼 <dir>/<filename>；destination 的各种
// 口味必须全部收敛为目录，且不能把文件落进 `_` 这类消毒垃圾目录。
describe('resolveDownloadOutSpec', () => {
  it('默认与 downloads 落用户下载目录，workspace 落 $PWD', () => {
    expect(resolveDownloadOutSpec('')).toBe('$HOME/Downloads');
    expect(resolveDownloadOutSpec('downloads')).toBe('$HOME/Downloads');
    expect(resolveDownloadOutSpec('workspace')).toBe('$PWD');
  });

  it('~/… 保留 home-relative 语义，不再把 ~ 消毒成 _ 拼出嵌套垃圾目录', () => {
    expect(resolveDownloadOutSpec('~/Downloads')).toBe('$HOME/Downloads');
    expect(resolveDownloadOutSpec('~/Downloads/pics')).toBe('$HOME/Downloads/pics');
    expect(resolveDownloadOutSpec('~')).toBe('$HOME');
  });

  it('文件路径形态取父目录（下载链把 outSpec 当目录用）', () => {
    expect(resolveDownloadOutSpec('~/Downloads/pic.png')).toBe('$HOME/Downloads');
    expect(resolveDownloadOutSpec('/tmp/pics/pic.png')).toBe('/tmp/pics');
    expect(resolveDownloadOutSpec('pics/pic.png')).toBe('$HOME/Downloads/pics');
    expect(resolveDownloadOutSpec('pic.png')).toBe('$HOME/Downloads');
  });

  it('绝对路径与普通子目录名仍按原语义消毒', () => {
    expect(resolveDownloadOutSpec('/tmp/pics')).toBe('/tmp/pics');
    expect(resolveDownloadOutSpec('pics')).toBe('$HOME/Downloads/pics');
    expect(resolveDownloadOutSpec('下载 图片')).toBe('$HOME/Downloads/_____');
  });

  it('shell wrapper 的 outdir 行可被 sh 正确展开（bad substitution 回归）', () => {
    // 老写法 `"${$HOME/Downloads}"` 在 sh 里是 bad substitution，outdir 恒为
    // 空——整条 shell 链从未落成过一个文件。这里锁住「单引号字面量 + eval
    // 二次解析」的形状，并实跑一次展开验证。
    const cmd = buildDownloadCommand('http://example.com/a.zip', '$HOME/Downloads', 4, '', true);
    const outdirLine = cmd.split('; ').find((l) => l.startsWith('outdir='))!;
    expect(outdirLine).toBe("outdir=$(eval echo '$HOME/Downloads')");
    const probe = outdirLine + '; echo "[$outdir]"';
    // spawnSync 直传 argv，不经外层 shell——外层会把 $( ) 和 $outdir 抢先展开
    const res = spawnSync('sh', ['-c', probe], { encoding: 'utf8', env: { ...process.env, HOME: '/tmp/fakehome-probe' } });
    expect(res.stdout).toContain('[/tmp/fakehome-probe/Downloads]');
  });
});

// ── 出口路由统一（修 3/5/6） ──────────────────────────────────────────────
// 每个出口都必须先试首选路由、网络类失败（或被劫持伪装成的成功）再试一次
// 反向路由。以前 web_search / web_public_api / download_file 直接把配好的
// 代理传下去（代理永远优先），web_fetch 走 netRouteProxyPair（直连优先 +
// 兜底）——同一个配置在两个出口得到两种相反的答案。

describe('Tauri egress routing', () => {
  const PROXY = 'http://127.0.0.1:7890';

  it('web_fetch 直连优先，直连网络失败后用代理兜底重试一次', async () => {
    const seen: Array<string | undefined> = [];
    const invoke = async (command: string, args?: Record<string, unknown>) => {
      seen.push(args?.proxyUrl as string | undefined);
      if (seen.length === 1) throw new Error('request: error sending request for url (https://registry.npmmirror.com/x)');
      return 'direct-was-blocked, proxy worked';
    };
    const adapter = new TauriToolAdapter('/ws', '', '', '', invoke, '', PROXY);
    const result = await adapter.execute(toolCall('web_fetch', { url: 'https://registry.npmmirror.com/x' }));
    expect(result.success).toBe(true);
    expect(result.result).toBe('direct-was-blocked, proxy worked');
    expect(seen).toEqual(['', PROXY]);
  });

  it('web_fetch 的代理优先主机（github）先走代理', async () => {
    const seen: Array<string | undefined> = [];
    const invoke = async (_command: string, args?: Record<string, unknown>) => {
      seen.push(args?.proxyUrl as string | undefined);
      return 'ok';
    };
    const adapter = new TauriToolAdapter('/ws', '', '', '', invoke, '', PROXY);
    await adapter.execute(toolCall('web_fetch', { url: 'https://github.com/anthropics/anthropic-cookbook' }));
    expect(seen).toEqual([PROXY]);
  });

  it('环回/内网地址永不走代理（也不会因为兜底被送进代理）', async () => {
    const seen: Array<string | undefined> = [];
    const invoke = async (_command: string, args?: Record<string, unknown>) => {
      seen.push(args?.proxyUrl as string | undefined);
      throw new Error('request: error sending request for url (http://127.0.0.1:5173/api)');
    };
    const adapter = new TauriToolAdapter('/ws', '', '', '', invoke, '', PROXY);
    const result = await adapter.execute(toolCall('web_fetch', { url: 'http://127.0.0.1:5173/api' }));
    expect(result.success).toBe(false);
    // 只试了一次：neutral 主机没有兜底可试，代理从未被使用。
    expect(seen).toEqual(['']);
  });

  it('200 的劫持页被当成网络失败：unlearn 直连并改走代理兜底', async () => {
    const seen: Array<string | undefined> = [];
    const invoke = async (_command: string, args?: Record<string, unknown>) => {
      seen.push(args?.proxyUrl as string | undefined);
      if (seen.length === 1) return '<html><head><title>403 Forbidden</title></head><body><h1>403 Forbidden</h1><hr><center>nginx</center></body></html>';
      return 'the real page body';
    };
    const adapter = new TauriToolAdapter('/ws', '', '', '', invoke, '', PROXY);
    const result = await adapter.execute(toolCall('web_fetch', { url: 'https://example.org/article' }));
    expect(result.success).toBe(true);
    expect(result.result).toBe('the real page body');
    expect(seen).toEqual(['', PROXY]);
  });

  it('web_search 直连优先：代理不再被无条件喂给所有搜索后端', async () => {
    const seen: Array<string | undefined> = [];
    const invoke = async (_command: string, args?: Record<string, unknown>) => {
      seen.push(args?.proxyUrl as string | undefined);
      return '1. Result\n   snippet\n   https://example.org/';
    };
    const adapter = new TauriToolAdapter('/ws', '', '', '', invoke, '', PROXY);
    const result = await adapter.execute(toolCall('web_search', { query: 'rust' }));
    expect(result.success).toBe(true);
    // 修复前这里恒为 [PROXY]：代理一挂，全部搜索后端一起死。直连时 Rust
    // args 里干脆不带 proxyUrl（buildWebSearchArgs 的既有约定）。
    expect(seen).toEqual([undefined]);
  });

  it('web_search 直连全线失败时整轮改走代理', async () => {
    const seen: Array<string | undefined> = [];
    const invoke = async (_command: string, args?: Record<string, unknown>) => {
      seen.push(args?.proxyUrl as string | undefined);
      if (seen.length === 1) throw new Error('Web search failed on all backends (Tavily: request: error sending request)');
      return '1. Result\n   snippet\n   https://example.org/';
    };
    const adapter = new TauriToolAdapter('/ws', 'tvly-1', '', '', invoke, '', PROXY);
    const result = await adapter.execute(toolCall('web_search', { query: 'rust' }));
    expect(result.success).toBe(true);
    expect(seen).toEqual([undefined, PROXY]);
  });

  it('web_public_api 同样按出口面决策，而不是代理永远优先', async () => {
    const seen: Array<string | undefined> = [];
    const invoke = async (_command: string, args?: Record<string, unknown>) => {
      seen.push(args?.proxyUrl as string | undefined);
      return '1 USD = 7.2 CNY';
    };
    const adapter = new TauriToolAdapter('/ws', 'tvly-1', '', '上海', invoke, '', PROXY);
    await adapter.execute(toolCall('web_public_api', { query: '1 usd to cny' }));
    expect(seen).toEqual(['']);
  });

  it('execute_command 的子进程代理来自 command 出口面决策，而非裸配置值', async () => {
    let seen: Record<string, unknown> = {};
    const invoke = async (command: string, args?: Record<string, unknown>) => {
      if (command === 'execute_command') { seen = args ?? {}; return { exitCode: 0, stdout: 'done', stderr: '' }; }
      throw new Error(`unexpected command: ${command}`);
    };
    const adapter = new TauriToolAdapter('/ws', '', '', '', invoke, '', PROXY);
    await adapter.execute(toolCall('execute_command', { command: 'npm install' }));
    expect(seen.proxyUrl).toBe(PROXY);
  });

  it('Skill Hub 走同一决策面：raw.githubusercontent.com 首选代理且带直连兜底', async () => {
    // 只锁「代理传下去 + 反向兜底存在」这条契约；Hub 内部有 6 条候选 URL 的
    // 阶梯，不适合在这里断言调用次数。
    const src = readFileSync(new URL('../TauriToolAdapter.ts', import.meta.url), 'utf8');
    const hubIdx = src.indexOf('fetchSkillBody(repo, nameArg, proxyUrl)');
    expect(hubIdx).toBeGreaterThan(-1);
    const window = src.slice(Math.max(0, hubIdx - 400), hubIdx + 200);
    expect(window).toContain('this.runRouted(');
    expect(window).toContain("netRouteProxyPair('https://raw.githubusercontent.com/', this.proxyUrl)");
  });
});

// ── diagnose_network / switch_package_source 的 GUI 接线 ───────────────────
// 这两个工具此前在 GUI 侧完全没有实现（模型调用得到 Unknown tool），而 GUI 是
// 用户的主战场。CLI 侧的实现不能直接搬：netProbe.ts / sourceSwitcher.ts 在模块
// 作用域 import node:net / node:tls / node:fs，Vite 打包成 __vite-browser-external
// 后 rollup 直接报 "connect is not exported"，整个 WebView 构建失败。

describe('checkGuiProbeTarget（GUI 侧护栏 = SSRF 防线）', () => {
  it('接受公网域名并归一化', () => {
    expect(checkGuiProbeTarget('registry.npmjs.org')).toEqual({ ok: true, url: 'https://registry.npmjs.org/', host: 'registry.npmjs.org' });
    expect(checkGuiProbeTarget('https://Example.COM./x').ok).toBe(true);
  });

  it('拒绝裸 IP / 环回 / 内网 / 非 http 协议', () => {
    // 护栏不能因为「模块搬不动」就放松：它同时是内网扫描器与 SSRF 的唯一防线。
    expect(checkGuiProbeTarget('1.2.3.4')).toMatchObject({ ok: false });
    expect(checkGuiProbeTarget('127.0.0.1')).toMatchObject({ ok: false });
    expect(checkGuiProbeTarget('localhost:8080')).toMatchObject({ ok: false });
    expect(checkGuiProbeTarget('foo.internal')).toMatchObject({ ok: false });
    expect(checkGuiProbeTarget('ftp://example.com')).toMatchObject({ ok: false });
    expect(checkGuiProbeTarget('')).toMatchObject({ ok: false });
    expect(checkGuiProbeTarget('notahost')).toMatchObject({ ok: false });
  });
});

describe('classifyGuiHttpProbe（403 与网络失败必须分开归因）', () => {
  it('正常应答 = 可达', () => {
    expect(classifyGuiHttpProbe({ ok: true })).toMatchObject({ status: 'pass', verdict: 'reachable' });
  });

  it('403/401 判定为「链路通但被拒」，绝不能算网络失败', () => {
    // 403 证明 TLS 握手成功 + 请求往返完成。把它算成网络失败会让模型去换镜像，
    // 而镜像同样会 403——方向整个反了。
    const r = classifyGuiHttpProbe({ ok: false, error: 'HTTP 403 Forbidden' });
    expect(r.verdict).toBe('http-fail');
    expect(r.summary).toContain('链路是通的');
    expect(r.summary).toContain('换镜像无济于事');
  });

  it('5xx 归因为源侧问题而非本机网络', () => {
    expect(classifyGuiHttpProbe({ ok: false, error: 'HTTP 503' }).summary).toContain('源侧问题');
  });

  it('网络类失败标 inconclusive（GUI 无法判定卡在 TCP 还是 TLS）', () => {
    // 这是 GUI 相对 CLI 少的那一档归因能力，必须如实暴露而不是硬凑一个结论。
    const r = classifyGuiHttpProbe({ ok: false, error: 'request: error sending request for url (https://x)' });
    expect(r.verdict).toBe('inconclusive');
    expect(r.summary).toContain('无法判定卡在哪一层');
  });

  it('劫持信号优先于「成功」', () => {
    const r = classifyGuiHttpProbe({ ok: true, hijackSignal: 'blockpage-fingerprint' });
    expect(r.status).toBe('fail');
    expect(r.summary).toContain('链路本身是通的');
  });
});

describe('isReservedProbeIp', () => {
  it('覆盖私网/环回/链路本地/CGNAT/组播，放行公网', () => {
    for (const ip of ['127.0.0.1', '10.1.1.1', '192.168.0.1', '172.16.0.1', '169.254.169.254', '100.64.0.1', '224.0.0.1', '0.0.0.0']) {
      expect(isReservedProbeIp(ip)).toBe(true);
    }
    expect(isReservedProbeIp('104.16.0.1')).toBe(false);
    expect(isReservedProbeIp('not-an-ip')).toBe(false);
  });
});

describe('renderProbeReport（能力自陈 + 置信度下调，GUI/CLI 共用同一渲染器）', () => {
  const base: NetProbeReport = {
    target: 'https://example.org/',
    host: 'example.org',
    verdict: 'reachable',
    reachable: true,
    confidence: 'medium',
    attribution: 'DNS 与 HTTP 两层均正常。',
    steps: [
      { step: 'dns', status: 'pass', ms: 10, summary: 'DNS 正常' },
      { step: 'tcp', status: 'skipped', ms: 0, summary: '未检查：本宿主没有套接字原语' },
      { step: 'tls', status: 'skipped', ms: 0, summary: '未检查：本宿主无法读取对端证书' },
      { step: 'http', status: 'pass', ms: 30, summary: '目标站点给出了正常应答' },
    ],
    capabilities: { dns: true, tcp: false, tls: false, http: true, unavailable: ['TCP：本宿主没有套接字原语', 'TLS：本宿主无法读取对端证书'] },
    realIps: ['104.16.0.1'],
    advice: ['链路基本正常'],
  };

  it('渲染出 skipped 步骤、能力自陈行与 DoH IP', () => {
    const text = renderProbeReport(base);
    expect(text).toContain('[SKIP] TCP');
    expect(text).toContain('[SKIP] TLS');
    expect(text).toContain('能力自陈：');
    expect(text).toContain('104.16.0.1');
    // 有两步未检查就自称 high confidence = 假装检查过。
    expect(text).toContain('置信度=medium');
  });

  it('humanReadable 追加编号修复建议', () => {
    expect(renderProbeReportForHuman(base)).toContain('1. 链路基本正常');
  });
});

describe('GUI 侧 diagnose_network 工具执行', () => {
  it('空 target 直接报错，不进入探测', async () => {
    const invoke = async () => { throw new Error('must not be called'); };
    const result = await new TauriToolAdapter('/ws', '', '', '', invoke).execute(toolCall('diagnose_network', { target: '' }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('target must not be empty');
  });

  it('护栏拒绝内网目标时以工具失败上报，且不发起任何网络请求', async () => {
    let called = 0;
    const invoke = async () => { called += 1; return ''; };
    const result = await new TauriToolAdapter('/ws', '', '', '', invoke).execute(toolCall('diagnose_network', { target: '127.0.0.1:8080' }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('拒绝');
    expect(called).toBe(0);
  });

  it('HTTP 层通过时返回可达结论，并自陈 TCP/TLS 两步未检查', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any) => {
      if (String(url).includes('/resolve')) {
        return new Response(JSON.stringify({ Status: 0, Answer: [{ type: 1, data: '104.16.0.1' }] }), { status: 200 });
      }
      throw new Error('unexpected fetch');
    }) as unknown as typeof fetch;
    try {
      const invoke = async (command: string) => {
        if (command === 'web_fetch_probe') return { statusOk: true, hijackSignal: null, finalUrl: 'https://example.org/' };
        throw new Error(`unexpected command: ${command}`);
      };
      const result = await new TauriToolAdapter('/ws', '', '', '', invoke).execute(toolCall('diagnose_network', { target: 'https://example.org' }));
      expect(result.success).toBe(true);
      const text = String(result.result);
      expect(text).toContain('可达');
      // HTTP 通了但 TCP/TLS 没查：置信度只能是 medium，且能力自陈必须出现。
      expect(text).toContain('[SKIP] TCP');
      expect(text).toContain('[SKIP] TLS');
      expect(text).toContain('能力自陈');
      expect(text).toContain('置信度=medium');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('DoH 全灭时归因到 DNS 层，不把 HTTP 的成功倒推成「四步全过」', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error('doh blocked'); }) as unknown as typeof fetch;
    try {
      const invoke = async (command: string) => {
        if (command === 'web_fetch_probe') return { statusOk: true, hijackSignal: null, finalUrl: 'https://example.org/' };
        throw new Error(`unexpected command: ${command}`);
      };
      const result = await new TauriToolAdapter('/ws', '', '', '', invoke).execute(toolCall('diagnose_network', { target: 'https://example.org' }));
      expect(result.success).toBe(true);
      const text = String(result.result);
      expect(text).toContain('归因=dns-fail');
      expect(text).toContain('DNS 层结论不可用');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('HTTP 层被劫持时归因指向链路中间设备，而不是目标站', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any) => {
      // DoH 返回公网 IP（DNS 正常），HTTP 层交给 invoke 报劫持。
      if (String(url).includes('/resolve')) {
        return new Response(JSON.stringify({ Status: 0, Answer: [{ type: 1, data: '104.16.0.1' }] }), { status: 200 });
      }
      throw new Error('unexpected fetch');
    }) as unknown as typeof fetch;
    try {
      const invoke = async (command: string) => {
        if (command === 'web_fetch_probe') return { statusOk: true, hijackSignal: 'blockpage-fingerprint' };
        throw new Error(`unexpected command: ${command}`);
      };
      const result = await new TauriToolAdapter('/ws', '', '', '', invoke).execute(toolCall('diagnose_network', { target: 'https://example.org', humanReadable: true }));
      expect(result.success).toBe(true);
      const text = String(result.result);
      expect(text).toContain('DNS 正常');
      expect(text).toContain('劫持');
      expect(text).toContain('修复建议');
      expect(text).not.toContain('可达（四步全过）');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('两个新工具出现在 getTools 里（此前 GUI 调用它们只会得到 Unknown tool）', () => {
    const names = new TauriToolAdapter('/ws', '', '', '', async () => '').getTools().map((t) => t.name);
    expect(names).toContain('diagnose_network');
    expect(names).toContain('switch_package_source');
  });
});

describe('GUI 侧 switch_package_source 工具执行', () => {
  const noNet = async () => { throw new Error('must not touch the network'); };

  it('未知生态直接报错', async () => {
    const result = await new TauriToolAdapter('/ws', '', '', '', noNet).execute(toolCall('switch_package_source', { ecosystem: 'apt' }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('未知生态');
  });

  it('默认 session 档：只产出 env 映射，明说不落盘不 spawn', async () => {
    const result = await new TauriToolAdapter('/ws', '', '', '', noNet).execute(toolCall('switch_package_source', { ecosystem: 'npm' }));
    expect(result.success).toBe(true);
    const text = String(result.result);
    expect(text).toContain('npm_config_registry=');
    expect(text).toContain('未写入任何文件');
    expect(text).toContain('未 spawn 任何命令');
    // npm 的 lockfile 陷阱必须出现在给模型的文本里。
    expect(text).toContain('lockfile');
  });

  it('go 档自动补 ,direct 回退', async () => {
    const result = await new TauriToolAdapter('/ws', '', '', '', noNet).execute(toolCall('switch_package_source', { ecosystem: 'go' }));
    expect(String(result.result)).toContain(',direct');
  });

  it('清单内的 T2 源默认关闭：显式点名也拒绝，授权后才放行', async () => {
    // ghfast.top 在清单里但属 t2，AUTO_TRUST_TIERS 不含它。
    const denied = await new TauriToolAdapter('/ws', '', '', '', noNet).execute(toolCall('switch_package_source', { ecosystem: 'github', source: 'https://ghfast.top' }));
    expect(denied.success).toBe(false);
    expect(denied.error).toContain('信任分层');

    const allowed = await new TauriToolAdapter('/ws', '', '', '', noNet).execute(toolCall('switch_package_source', {
      ecosystem: 'github', source: 'https://ghfast.top', enabledTrustTiers: ['t0', 't1', 't2'],
    }));
    expect(allowed.success).toBe(true);
    expect(String(allowed.result)).toContain('sha256');
  });

  it('无环境变量换法的生态（github）明说未做任何改动，不列空的「注入变量」', async () => {
    const result = await new TauriToolAdapter('/ws', '', '', '', noNet).execute(toolCall('switch_package_source', { ecosystem: 'github' }));
    expect(result.success).toBe(true);
    const text = String(result.result);
    expect(text).toContain('没有环境变量换法');
    expect(text).toContain('未写入任何文件');
    expect(text).not.toContain('要生效，请把这些变量注入子进程');
  });

  it('file 档缺 confirm 或仍 dry-run 时被拒，且不做任何改动', async () => {
    // dry_run 缺省为 true：要真写必须 confirm:true 且 dry_run:false。
    for (const args of [{ confirm: true }, { dryRun: false }, {}, { confirm: true, dryRun: true }]) {
      const result = await new TauriToolAdapter('/ws', '', '', '', noNet).execute(toolCall('switch_package_source', { ecosystem: 'npm', scope: 'file', ...args }));
      expect(result.success).toBe(true);
      const text = String(result.result);
      expect(text).toContain('file 级换源被拒绝');
      expect(text).toContain('未做任何改动');
      expect(text).not.toContain('--scope file --confirm');
    }
  });

  it('file 档即使 confirm + 非 dry-run 也不在 GUI 落盘，给出确切 CLI 命令', async () => {
    // 绝不做的事：改 /etc/hosts、装 CA、改系统 DNS、动 /etc/docker。
    const result = await new TauriToolAdapter('/ws', '', '', '', noNet).execute(toolCall('switch_package_source', { ecosystem: 'npm', scope: 'file', confirm: true, dryRun: false }));
    expect(result.success).toBe(true);
    const text = String(result.result);
    expect(text).toContain('CLI');
    expect(text).toContain('--scope file --confirm');
    expect(text).toContain('未做任何改动');
    expect(text).not.toContain('/etc/hosts');
    expect(text).not.toContain('安装 CA');
  });

  it('docker 档在 GUI 下同样被 file scope 挡住并说明原因', async () => {
    const result = await new TauriToolAdapter('/ws', '', '', '', noNet).execute(toolCall('switch_package_source', { ecosystem: 'docker', scope: 'file', confirm: true, dryRun: false }));
    expect(String(result.result)).toContain('daemon.json');
  });

  it('清单外的自配 URL：session 档放行并标 T3，file 档拒绝', async () => {
    const session = await new TauriToolAdapter('/ws', '', '', '', noNet).execute(toolCall('switch_package_source', { ecosystem: 'npm', source: 'https://my-mirror.example.com/npm' }));
    expect(session.success).toBe(true);
    expect(String(session.result)).toContain('T3');

    const file = await new TauriToolAdapter('/ws', '', '', '', noNet).execute(toolCall('switch_package_source', { ecosystem: 'npm', source: 'https://my-mirror.example.com/npm', scope: 'file', confirm: true, dryRun: false }));
    expect(file.success).toBe(false);
    expect(file.error).toContain('T3');
  });

  // 同一个模型会在 CLI 与 GUI 两端调用同一个工具；两端的**准入门禁**一旦漂移，
  // 它就会学到「换到 GUI 就能绕过信任分层」——那是实打实的安全倒退。
  it('准入门禁与 CLI 侧 sourceSwitcher 判定一致（放行/拒绝逐条对齐）', async () => {
    const { NodeToolAdapter } = await import('../../adapter/node/NodeToolAdapter');
    const gui = new TauriToolAdapter('/ws', '', '', '', noNet);
    const cli = new NodeToolAdapter({ workspace: '/ws' });
    // 默认档 source:'auto' 会真的测速，CLI 侧直连公网。这里把 fetch 桩掉，
    // 让两端都在零真实网络下跑——比的门禁，不是网络。
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    // 只比对 session 档：file 档在 GUI 是**永久降级**（返回 success:true + 明确
    // 的「去 CLI 执行」文本，而不是工具错误），语义本就不同，比 success 会误报。
    const cases: Array<Record<string, unknown>> = [
      { ecosystem: 'github', source: 'https://ghfast.top' },
      { ecosystem: 'github', source: 'https://ghfast.top', enabledTrustTiers: ['t0', 't1', 't2'] },
      { ecosystem: 'npm', source: 'https://my-mirror.example.com/npm' },
      { ecosystem: 'apt' },
      { ecosystem: 'npm', source: 'not-a-url' },
      { ecosystem: 'pip' },
      { ecosystem: 'cargo' },
      { ecosystem: 'go' },
    ];
    try {
      for (const args of cases) {
        const g = await gui.execute(toolCall('switch_package_source', args));
        const c = await cli.execute(toolCall('switch_package_source', args));
        expect(g.success).toBe(c.success);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('file 档在 GUI 下一律 success:true + 明确降级文本（不是工具错误，也不是假装成功）', async () => {
    // 与 CLI 的 success 语义不同是刻意的：这是边界而非故障，报错会让失败策略
    // 去重试一个永远不会变的答案。关键是文本必须说清「没写、去 CLI」。
    for (const ecosystem of ['npm', 'cargo', 'docker']) {
      const result = await new TauriToolAdapter('/ws', '', '', '', noNet).execute(toolCall('switch_package_source', { ecosystem, scope: 'file', confirm: true, dryRun: false }));
      expect(result.success).toBe(true);
      const text = String(result.result);
      expect(text).toContain('未做任何改动');
      expect(text).not.toContain('换源完成');
    }
  });
});

describe('benchmarkUrlFor（GUI 与 CLI 共用 shared/mirrorSources 的同一份拼接规则）', () => {
  it('剥掉 cargo 的 sparse+ 前缀并拼上测速路径', () => {
    expect(benchmarkUrlFor('cargo', 'sparse+https://rsproxy.cn/crates.io-index')).toBe('https://rsproxy.cn/crates.io-index/index/config.json');
    expect(benchmarkUrlFor('npm', 'https://registry.npmmirror.com')).toBe('https://registry.npmmirror.com/npm');
  });

  it('对自带路径尾的源合并重叠分段，不再拼出 /npm/npm', () => {
    // 旧行为：base 尾段与 path 首段相同也照样拼，测的是一个不存在的地址，
    // 于是好源被判成死源。现在两端共用 mirrorSources.buildBenchmarkUrl。
    expect(benchmarkUrlFor('npm', 'https://mirrors.cloud.tencent.com/npm/')).toBe('https://mirrors.cloud.tencent.com/npm');
    expect(benchmarkUrlFor('pip', 'https://mirrors.aliyun.com/pypi/simple')).toBe('https://mirrors.aliyun.com/pypi/simple/pip/');
    expect(benchmarkUrlFor('go', 'https://goproxy.cn,direct')).toBe('https://goproxy.cn/github.com/pkg/errors/@v/list');
  });
});

describe('GUI 侧 source:auto 测速（默认档不能跳过）', () => {
  // 按 URL 而不是调用序号分派，并给出明确的延迟差：否则「谁最快」会随机器
  // 调度抖动变成 flaky 断言。
  const DELAY: Record<string, number> = {
    'https://registry.npmmirror.com/npm': 60,
    'https://mirrors.huaweicloud.com/repository/npm': 10,
  };

  it('并发测速全部候选，按「先看有没有回答，再比多快」选出最快可用源', async () => {
    const seen: string[] = [];
    const invoke = async (_command: string, args?: Record<string, unknown>) => {
      const url = String(args?.url);
      seen.push(url);
      const wait = DELAY[url];
      if (wait) await new Promise((r) => setTimeout(r, wait));
      // 华为云：慢且 5xx。腾讯：403 但立刻回 —— 403 证明链路通，不能淘汰。
      if (url.includes('huaweicloud')) throw new Error('HTTP 503');
      if (url.includes('tencent')) throw new Error('HTTP 403');
      return '{}';
    };
    const result = await new TauriToolAdapter('/ws', '', '', '', invoke).execute(toolCall('switch_package_source', { ecosystem: 'npm' }));
    expect(result.success).toBe(true);
    const text = String(result.result);
    // 三家都要被测到（并发，不是串行）
    expect(seen.length).toBe(3);
    expect(text).toContain('测速明细');
    // 403 也算「链路通」，不能因为不是 200 就淘汰掉最快的那个源
    expect(text).toContain('HTTP 403');
    expect(text).toContain('HTTP 503');
    // 有有效响应里最快的胜出。腾讯只回 403（无延迟）——它**本该**因为不是 200
    // 被淘汰，正是这条断言在守「403 = 链路通」的判据：阿里虽然返回 200，
    // 但慢 60ms，排序后落后于腾讯。
    expect(text).toContain('npm_config_registry=https://mirrors.cloud.tencent.com/npm/');
  });

  it('全部候选都拿不到有效响应时，回落首选并提示用 diagnose_network 定位', async () => {
    const invoke = async () => { throw new Error('connection refused'); };
    const result = await new TauriToolAdapter('/ws', '', '', '', invoke).execute(toolCall('switch_package_source', { ecosystem: 'npm' }));
    expect(result.success).toBe(true);
    const text = String(result.result);
    expect(text).toContain('所有候选源测速均未拿到有效响应');
    expect(text).toContain('diagnose_network');
    // 仍然要给出可执行的 env 映射，不能空手而归
    expect(text).toContain('npm_config_registry=');
  });
});

// ── S2 单请求改写：GUI 下载网络失败时换镜像端点 ───────────────────────────
// 直接驱动私有编排 retryDownloadViaMirror（桩替 execute），验证「有镜像才换、
// 换到哪、成功后标注来源」。镜像 URL 不在改写表内，真跑也只递归一层。
describe('download_file · S2 单请求改写（GUI 侧镜像重试）', () => {
  const NPM = 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz';
  const MIRROR = 'https://registry.npmmirror.com/left-pad/-/left-pad-1.3.0.tgz';
  type MirrorHost = {
    retryDownloadViaMirror: (toolCall: { id: string; index: number }, args: Record<string, unknown>, signal?: AbortSignal) => Promise<{ result?: string } | null>;
  };

  function adapterWithStubExecute(calls: ToolCall[], ok: (url: string) => boolean): TauriToolAdapter {
    const adapter = new TauriToolAdapter('/ws', '', '', '', async () => 'x');
    (adapter as unknown as Record<string, unknown>)['execute'] = async (call: ToolCall) => {
      calls.push(call);
      const url = JSON.parse(call.function.arguments).url as string;
      return {
        id: call.id,
        toolName: 'download_file',
        result: JSON.stringify({ kind: 'download', path: '/tmp/left-pad.tgz', size: 14, durationMs: 1, via: 'stub' }),
        success: ok(url),
        duration: 1,
      };
    };
    return adapter;
  }

  it('原站网络失败后换镜像成功，结果带上 rewrite 来源', async () => {
    const calls: ToolCall[] = [];
    const adapter = adapterWithStubExecute(calls, () => true);
    const out = await (adapter as unknown as MirrorHost).retryDownloadViaMirror({ id: 't1', index: 0 }, { url: NPM }, undefined);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!.function.arguments).url).toBe(MIRROR);
    const parsed = JSON.parse(String(out?.result)) as { rewrite?: { from: string; to: string; rule: string } };
    expect(parsed.rewrite).toEqual({ from: NPM, to: MIRROR, rule: 'npm-tarball-to-npmmirror' });
  });

  it('无镜像端点时不做任何改写（返回 null，调用方按原样报错）', async () => {
    const calls: ToolCall[] = [];
    const adapter = adapterWithStubExecute(calls, () => true);
    const out = await (adapter as unknown as MirrorHost).retryDownloadViaMirror({ id: 't1', index: 0 }, { url: 'https://example.com/x.tgz' }, undefined);
    expect(out).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('镜像也失败时返回 null（不假装成功）', async () => {
    const calls: ToolCall[] = [];
    const adapter = adapterWithStubExecute(calls, () => false);
    const out = await (adapter as unknown as MirrorHost).retryDownloadViaMirror({ id: 't1', index: 0 }, { url: NPM }, undefined);
    expect(out).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('已知熔断的主机有镜像时，入口直接切镜像（真实 execute，走 shell 兜底）', async () => {
    const commands: string[] = [];
    const invoke = async (command: string, args?: Record<string, unknown>) => {
      if (command === 'execute_command') {
        commands.push(String(args?.command ?? ''));
        return {
          exitCode: 0,
          stdout: JSON.stringify({ type: 'done', code: 0, path: '/tmp/left-pad-1.3.0.tgz', filename: 'left-pad-1.3.0.tgz', size: 14, via: 'curl' }),
          stderr: '',
        };
      }
      return 'x';
    };
    recordNetFailure(NPM);
    recordNetFailure(NPM);
    try {
      const result = await new TauriToolAdapter('/ws', '', '', '', invoke).execute(toolCall('download_file', { url: NPM, filename: 'left-pad-1.3.0.tgz' }));
      expect(result.success).toBe(true);
      const joined = commands.join('\n');
      expect(joined).toContain('registry.npmmirror.com');
      // 原站根本没被尝试。
      expect(joined).not.toContain('registry.npmjs.org');
      const parsed = JSON.parse(String(result.result)) as { rewrite?: { from: string; to: string; rule: string } };
      expect(parsed.rewrite).toEqual({ from: NPM, to: MIRROR, rule: 'npm-tarball-to-npmmirror' });
    } finally {
      recordNetSuccess(NPM);
    }
  });
});
