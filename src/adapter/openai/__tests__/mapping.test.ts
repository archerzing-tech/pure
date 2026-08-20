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
});
