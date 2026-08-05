// src/ui/__tests__/toolRow.test.ts

import { describe, expect, it } from 'bun:test';
import { shouldExpandToolRowInitially, shouldUseTerminalPanel } from '../toolRow';

describe('tool row expansion policy', () => {
  it('expands every execution row by default', () => {
    expect(shouldExpandToolRowInitially('execute_command')).toBe(true);
    expect(shouldExpandToolRowInitially('git_status')).toBe(true);
    expect(shouldExpandToolRowInitially('write_file')).toBe(true);
    expect(shouldExpandToolRowInitially('read_file')).toBe(true);
    expect(shouldExpandToolRowInitially('web_search')).toBe(true);
  });

});

describe('tool row terminal panel policy', () => {
  it('uses terminal panels for file, list, and shell tools only', () => {
    expect(shouldUseTerminalPanel('read_file')).toBe(true);
    expect(shouldUseTerminalPanel('write_file')).toBe(true);
    expect(shouldUseTerminalPanel('edit_file')).toBe(true);
    expect(shouldUseTerminalPanel('execute_command')).toBe(true);
    expect(shouldUseTerminalPanel('list_files')).toBe(true);
    expect(shouldUseTerminalPanel('web_search')).toBe(false);
  });
});
