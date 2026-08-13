import { describe, expect, it } from 'bun:test';
import { makeResearchPayload, parseResearchResult, parseWebSearchText } from '../research';

describe('research result contracts', () => {
  it('parses structured researcher sources with content', () => {
    const payload = makeResearchPayload('researcher_docs', 'React useActionState', [
      { title: 'React docs', snippet: 'API reference', url: 'https://react.dev/reference', content: 'Details' },
    ], { library: 'React', topic: 'useActionState', version: '19' });
    const sources = parseResearchResult(payload);
    expect(sources).toEqual([
      { title: 'React docs', snippet: 'API reference', url: 'https://react.dev/reference', content: 'Details' },
    ]);
  });

  it('keeps legacy formatted web search text readable', () => {
    const sources = parseWebSearchText('1. React docs\nAPI reference\nhttps://react.dev/reference');
    expect(sources).toEqual([{ title: 'React docs', snippet: 'API reference', url: 'https://react.dev/reference' }]);
    expect(parseResearchResult('1. React docs\nAPI reference\nhttps://react.dev/reference')).toEqual(sources);
  });
});
