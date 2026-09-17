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

  it('removes every warm-up blob, not just the first', () => {
    // PowerShell writes one when the host starts and another when a module is
    // auto-loaded mid-command, so more than one can land in the same stream.
    expect(stripPowerShellStartupProgress(`${WARMUP}${WARMUP}bad`)).toBe('bad');
    expect(stripPowerShellStartupProgress(`${WARMUP}bad${WARMUP}`)).toBe('bad');
  });

  it('leaves a truncated blob alone rather than cutting into real output', () => {
    expect(stripPowerShellStartupProgress('#< CLIXML\n<Objs><AV>Preparing modules for first use.</AV>')).toBe(
      '#< CLIXML\n<Objs><AV>Preparing modules for first use.</AV>',
    );
  });

  it('keeps a CLIXML blob that carries a real error record', () => {
    expect(stripPowerShellStartupProgress(WARMUP_WITH_ERROR)).toBe(WARMUP_WITH_ERROR);
  });

  it('keeps CLIXML that is neither warm-up nor an error (unknown shape)', () => {
    const unknown = '#< CLIXML\n<Objs Version="1.1.0.1"><Obj S="information" RefId="0" /></Objs>';
    expect(stripPowerShellStartupProgress(unknown)).toBe(unknown);
  });
});
