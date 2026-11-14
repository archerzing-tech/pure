// src/shared/__tests__/powershellOutput.test.ts
// The CLIXML strip must remove PowerShell's module warm-up noise WITHOUT
// hiding real error output — a hook or a command that failed has to keep its
// stderr, or the model and the user would read an empty reason.

import { describe, expect, it } from 'bun:test';
import { stripPowerShellStartupProgress } from '../powershellOutput';

const WARMUP = '#< CLIXML\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">'
  + '<Obj S="progress" RefId="0"><MS><I64 N="SourceId">1</I64><PR N="Record">'
  + '<AV>Preparing modules for first use.</AV><AI>0</AI><Nil /><PI>-1</PI><PC>-1</PC><T>Completed</T><SR>-1</SR><SD> </SD>'
  + '</PR></MS></Obj></Objs>';

const WARMUP_WITH_ERROR = '#< CLIXML\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">'
  + '<S S="Error">boom: the hook refused</S></Objs>';

describe('stripPowerShellStartupProgress', () => {
  it('leaves ordinary output untouched', () => {
    expect(stripPowerShellStartupProgress('bad\n')).toBe('bad\n');
    expect(stripPowerShellStartupProgress('')).toBe('');
  });

  it('empties the warm-up-only CLIXML blob', () => {
    expect(stripPowerShellStartupProgress(WARMUP)).toBe('');
    // Surrounding whitespace (PowerShell appends a CRLF) does not defeat it.
    expect(stripPowerShellStartupProgress(`\r\n${WARMUP}\r\n`)).toBe('');
  });

  it('keeps the command output around the warm-up blob', () => {
    // A hook writing its reason to stderr right after PowerShell starts used
    // to hand back the blob alone — the reason itself must survive, whichever
    // order PowerShell interleaved the two in.
    expect(stripPowerShellStartupProgress(`${WARMUP}\r\nbad\n`)).toBe('bad');
    expect(stripPowerShellStartupProgress(`bad\n${WARMUP}\n`)).toBe('bad');
    expect(stripPowerShellStartupProgress(`bad\n${WARMUP}\nalso bad\n`)).toBe('bad\nalso bad');
  });

  it('recognizes the blob without the #< CLIXML header line', () => {
    // Windows runners regularly deliver the document without the header, so
    // matching on the header alone left the blob in place (observed in the
    // v2.2.6-alpha release run).
    const headerless = WARMUP.replace('#< CLIXML\n', '');
    expect(stripPowerShellStartupProgress(headerless)).toBe('');
    expect(stripPowerShellStartupProgress(`hook said: no\n${headerless}`)).toBe('hook said: no');
  });

  it('removes every warm-up blob, not just the first', () => {
    // PowerShell writes one when the host starts and another when a module is
    // auto-loaded mid-command, so more than one can land in the same stream.
    expect(stripPowerShellStartupProgress(`${WARMUP}${WARMUP}bad`)).toBe('bad');
    expect(stripPowerShellStartupProgress(`${WARMUP}bad${WARMUP}`)).toBe('bad');
    expect(stripPowerShellStartupProgress(`${WARMUP.replace('#< CLIXML\n', '')}${WARMUP}`)).toBe('');
  });

  it('removes a #< CLIXML header the document never followed', () => {
    // The wrapper goes out in two pieces: powershell.exe writes the header when
    // the stream is redirected, the document when the record is serialized. The
    // v2.2.6-alpha release run captured the header alone — the warm-up document
    // it belongs to never arrived — and it still reached the caller as a veto
    // reason, so the header has to stand on its own as a cut.
    expect(stripPowerShellStartupProgress('#< CLIXML')).toBe('');
    expect(stripPowerShellStartupProgress('#< CLIXML\r\n')).toBe('');
    expect(stripPowerShellStartupProgress('hook said: no\n#< CLIXML\n')).toBe('hook said: no');
    // A header doubled in front of one document leaves the outer one stranded.
    expect(stripPowerShellStartupProgress(`#< CLIXML\n${WARMUP}`)).toBe('');
  });

  it('cuts a warm-up document the stream truncated', () => {
    // The release run delivered documents both ways: PowerShell was serializing
    // the record while the process exited, so the closing tag never made it.
    // An unclosed document is still the wrapper alone — whatever the command
    // wrote sits in front of it and is asserted to survive.
    const truncated = '#< CLIXML\n<Objs><AV>Preparing modules for first use.</AV>';
    expect(stripPowerShellStartupProgress(truncated)).toBe('');
    expect(stripPowerShellStartupProgress(`hook said: no\n${truncated}`)).toBe('hook said: no');
  });

  it('never swallows an unrelated CLIXML shape that precedes a warm-up blob', () => {
    // An unknown document is left whole (see below); a later truncated warm-up
    // document may not eat it on the way out, so the body is tempered.
    const unknown = '#< CLIXML\n<Objs Version="1.1.0.1"><Obj S="information" RefId="0" /></Objs>';
    const truncated = '#< CLIXML\n<Objs><AV>Preparing modules for first use.</AV>';
    expect(stripPowerShellStartupProgress(`${unknown}\nhook said: no\n${truncated}`)).toBe(`${unknown}\nhook said: no`);
  });

  it('unwraps the text of an error record instead of keeping the XML blob', () => {
    // Windows 判例 2026-11-14 任务 2：PS 5.1 在 stderr 被重定向时把真实报错
    // 序列化成 CLIXML——模型收到的是一整段 <Objs> 标记。抽取 <S S="…"> 记录
    // 的文本（与 Rust unwrap_clixml 同刀），错误内容不丢、包裹层不剩。
    expect(stripPowerShellStartupProgress(WARMUP_WITH_ERROR)).toBe('boom: the hook refused');
  });

  it('unwraps stream records, decodes _xHHHH_ escapes and XML entities', () => {
    // 与 Rust clixml_tests::unwraps_error_nodes_and_decodes_escapes 同判例。
    const envelope = '#< CLIXML\n'
      + '<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">'
      + '<S S="Error">所在位置 行:1 字符: 1_x000D__x000A_+ &lt;bad&gt;</S>'
      + '<S S="Info">info line</S>'
      + '</Objs>';
    expect(stripPowerShellStartupProgress(envelope))
      .toBe('所在位置 行:1 字符: 1\r\n+ <bad>\ninfo line');
  });

  it('keeps the command output ahead of an error envelope', () => {
    expect(stripPowerShellStartupProgress(`bad\n${WARMUP_WITH_ERROR}`)).toBe('bad\nboom: the hook refused');
  });

  it('keeps a truncated error record visible as-is (no </S>, nothing to extract)', () => {
    // 截断的 error envelope 抽不出完整记录 → 保守透传，错误字节至少可见。
    const truncated = '#< CLIXML\n<Objs><S S="Error">boom: cut off mid-record';
    expect(stripPowerShellStartupProgress(truncated)).toBe(truncated);
  });

  it('drops a trailing progress envelope stuck after an error record', () => {
    // 与 Rust keeps_real_error_and_drops_trailing_progress_envelope 同判例：
    // 错误在前、引擎 progress envelope 粘尾——错误抽取，progress 包丢弃。
    const raw = `#< CLIXML\n<Objs><S S="Error">real failure</S></Objs>`
      + `#< CLIXML\n<Objs><Obj S="progress" RefId="0"><MS><I64 N="SourceId">1</I64>`
      + `<PR N="Record"><AV>Preparing modules for first use.</AV><AI>0</AI>`
      + `<Nil /><PI>-1</PI><PC>-1</PC><T>Completed</T><SR>-1</SR><SD> </SD>`
      + `</PR></MS></Obj></Objs>`;
    expect(stripPowerShellStartupProgress(raw)).toBe('real failure');
  });

  it('keeps CLIXML that is neither warm-up nor an error (unknown shape)', () => {
    const unknown = '#< CLIXML\n<Objs Version="1.1.0.1"><Obj S="information" RefId="0" /></Objs>';
    expect(stripPowerShellStartupProgress(unknown)).toBe(unknown);
  });
});
