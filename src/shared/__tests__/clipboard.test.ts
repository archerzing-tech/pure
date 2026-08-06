import { describe, expect, it } from 'bun:test';
import { copyTextToClipboard } from '../clipboard';

describe('copyTextToClipboard', () => {
  it('writes non-empty text through the provided clipboard writer', async () => {
    let copied = '';
    const result = await copyTextToClipboard('draft text', {
      writeText: async (text) => { copied = text; },
    });
    expect(result).toBe(true);
    expect(copied).toBe('draft text');
  });

  it('ignores an empty draft without touching the clipboard', async () => {
    let called = false;
    const result = await copyTextToClipboard('', {
      writeText: async () => { called = true; },
    });
    expect(result).toBe(false);
    expect(called).toBe(false);
  });

  it('returns false when the clipboard writer fails outside a DOM', async () => {
    const result = await copyTextToClipboard('draft text', {
      writeText: async () => { throw new Error('denied'); },
    });
    expect(result).toBe(false);
  });
});
