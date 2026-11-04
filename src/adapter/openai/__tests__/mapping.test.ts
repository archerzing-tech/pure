import { describe, expect, it } from 'bun:test';
import { mapMessages } from '../mapping';
import type { Message } from '../../../shared/types';

describe('OpenAI message mapping with image attachments', () => {
  it('maps a user image to an image_url content block without dropping the text', () => {
    const messages: Message[] = [{
      role: 'user',
      content: '[Pasted screenshot/image: shot.png (1 KB)]',
      images: [{ dataUrl: 'data:image/png;base64,AAAA', mimeType: 'image/png', name: 'shot.png', path: '/tmp/shot.png', sizeBytes: 1024 }],
    }];

    expect(mapMessages(messages)).toEqual([{
      role: 'user',
      content: [
        { type: 'text', text: '[Pasted screenshot/image: shot.png (1 KB)]' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ],
    }]);
  });

  it('keeps ordinary text messages on the compact string wire format', () => {
    expect(mapMessages([{ role: 'user', content: 'hello' }])).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('folds tool-message screenshots into a content-parts array (W4-2)', () => {
    const messages: Message[] = [{
      role: 'tool',
      content: 'Screenshot saved: /tmp/shot.png',
      toolCallId: 'call_1',
      toolName: 'browser',
      images: [{ dataUrl: 'data:image/png;base64,BBBB', mimeType: 'image/png', path: '/tmp/shot.png' }],
    }];
    expect(mapMessages(messages)).toEqual([{
      role: 'tool',
      tool_call_id: 'call_1',
      content: [
        { type: 'text', text: 'Screenshot saved: /tmp/shot.png' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,BBBB' } },
      ],
    }]);
  });

  it('keeps tool messages without images on the plain-string shape', () => {
    expect(mapMessages([{ role: 'tool', content: 'ok', toolCallId: 'c2', toolName: 'x' }]))
      .toEqual([{ role: 'tool', tool_call_id: 'c2', content: 'ok' }]);
  });
});
