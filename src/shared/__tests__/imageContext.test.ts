import { describe, expect, it } from 'bun:test';
import { FOLDED_IMAGE_NOTE, setHistoricalImagePolicy, trimHistoricalImages } from '../imageContext';
import type { Message } from '../types';

const full = (name: string, bytes: number) => ({
  dataUrl: `data:image/png;base64,${name}${'A'.repeat(bytes)}`,
  thumbDataUrl: `data:image/png;base64,thumb-${name}`,
  mimeType: 'image/png',
  path: `~/.pure/attachments/s/${name}.png`,
});

function userWithImage(name: string, content = `看这张 ${name}`): Message {
  return { role: 'user', content, images: [full(name, 8)] };
}

describe('historical image trimming (P1-2)', () => {
  it('keeps the newest image turns and folds older ones to thumbnails', () => {
    const messages: Message[] = [
      userWithImage('one'),
      { role: 'assistant', content: '收到' },
      userWithImage('two'),
      userWithImage('three'),
    ];

    const out = trimHistoricalImages(messages, { enabled: true, keepRecentUserImages: 2 });

    expect(out[0].images?.[0].dataUrl).toContain('thumb-one');
    expect(out[2].images?.[0].dataUrl).toContain('data:image/png;base64,two');
    expect(out[3].images?.[0].dataUrl).toContain('data:image/png;base64,three');
    // 模型上下文之外的东西一个都不动。
    expect(out[1]).toBe(messages[1]);
  });

  it('returns the original array when nothing is old enough to fold', () => {
    const messages: Message[] = [userWithImage('one'), userWithImage('two')];
    expect(trimHistoricalImages(messages, { enabled: true, keepRecentUserImages: 2 })).toBe(messages);
  });

  it('drops legacy images without a thumbnail and leaves a note instead of a dangling reference', () => {
    const legacy: Message = {
      role: 'user',
      content: '这几张图里有什么',
      images: [{ dataUrl: 'data:image/png;base64,OLD', mimeType: 'image/png' }],
    };
    const out = trimHistoricalImages([legacy, userWithImage('two'), userWithImage('three')], {
      enabled: true,
      keepRecentUserImages: 2,
    });

    expect(out[0].images).toBeUndefined();
    expect(out[0].content).toContain(FOLDED_IMAGE_NOTE);
    expect(out[0].content).toContain('这几张图里有什么');
  });

  it('never touches tool screenshots — only user uploads fold', () => {
    const toolImage: Message = { role: 'tool', content: 'screenshot', toolCallId: 'c1', images: [full('shot', 8)] };
    const messages: Message[] = [userWithImage('one'), toolImage, userWithImage('two'), userWithImage('three')];
    const out = trimHistoricalImages(messages, { enabled: true, keepRecentUserImages: 2 });
    expect(out[1]).toBe(toolImage);
  });

  it('can be switched off (old behaviour: every historical image keeps its bytes)', () => {
    const messages: Message[] = [userWithImage('one'), userWithImage('two'), userWithImage('three')];
    expect(trimHistoricalImages(messages, { enabled: false })).toBe(messages);
  });

  it('honours the host policy default', () => {
    setHistoricalImagePolicy({ enabled: false });
    try {
      const messages: Message[] = [userWithImage('one'), userWithImage('two'), userWithImage('three')];
      expect(trimHistoricalImages(messages)).toBe(messages);
    } finally {
      setHistoricalImagePolicy({ enabled: true });
    }
  });
});
