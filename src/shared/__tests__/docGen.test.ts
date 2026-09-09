// src/shared/__tests__/docGen.test.ts

import { beforeAll, afterAll, describe, expect, it } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

let docGen: typeof import('../docGen');

beforeAll(async () => {
  GlobalRegistrator.register();
  docGen = await import('../docGen');
});

afterAll(() => GlobalRegistrator.unregister());

describe('generateDocument', () => {
  // Regression: the tool schema puts `format` at the top level of the call
  // args, so a spec-shaped `{ slides: [...] }` carries no format of its own.
  // generateDocument used to dispatch on spec.format and silently return
  // undefined, crashing the caller with "reading 'length'".
  it('generates a pptx when format comes from the tool argument', async () => {
    const bytes = await docGen.generateDocument('pptx', {
      slides: [{ title: '开场', content: ['要点一', '要点二'] }],
    });
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);
    // A real pptx is a zip: PK magic bytes at the front.
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
  });

  it('honors spec.format as a fallback when the argument is missing', async () => {
    const bytes = await docGen.generateDocument(undefined, {
      format: 'docx',
      sections: [{ type: 'heading', text: '标题', level: 1 }],
    });
    expect(bytes.length).toBeGreaterThan(0);
  });

  it('throws an actionable error instead of returning undefined on unknown format', async () => {
    expect(docGen.generateDocument('pdf', { slides: [] })).rejects.toThrow('pptx / docx / xlsx');
  });

  it('rejects a non-object spec', async () => {
    expect(docGen.generateDocument('pptx', null)).rejects.toThrow('spec');
  });
});
