// src/ui/__tests__/pasteChip.test.ts

import { describe, expect, it } from 'bun:test';
import {
  PASTE_FILE_THRESHOLD,
  guessPasteName,
  imageExtOf,
  fileIconOf,
  composeMessageWithAttachments,
  classifyUploadFile,
  isDocFileName,
  UPLOAD_LIMITS,
  type PasteAttachment,
} from '../pasteChip';

function att(name: string, content: string): PasteAttachment {
  return { id: 'a1', name, size: content.length, content, path: '/tmp/x/' + name, kind: 'text', dataUrl: '' };
}

function imgAtt(name: string, path: string): PasteAttachment {
  return { id: 'i1', name, size: 1024 * 1024, content: '', path, kind: 'image', dataUrl: 'data:image/png;base64,AAAA' };
}

describe('classifyUploadFile (upload limits)', () => {
  it('accepts text files', () => {
    expect(classifyUploadFile('readme.md', 'text/markdown', 100)).toBe('text');
    expect(classifyUploadFile('main.py', 'text/x-python', 100)).toBe('text');
  });

  it('accepts images within the cap and rejects oversized ones', () => {
    expect(classifyUploadFile('shot.png', 'image/png', 1024)).toBe('image');
    expect(classifyUploadFile('big.png', 'image/png', UPLOAD_LIMITS.MAX_IMAGE_BYTES + 1)).toBeNull();
  });

  it('accepts document files by extension or mime', () => {
    expect(classifyUploadFile('report.pdf', 'application/pdf', 1024)).toBe('doc');
    expect(classifyUploadFile('plan.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 1024)).toBe('doc');
    expect(isDocFileName('表格.xlsx')).toBe(true);
    expect(isDocFileName('notes.txt')).toBe(false);
  });

  it('rejects archives, executables, and unknown binaries', () => {
    expect(classifyUploadFile('archive.zip', 'application/zip', 1024)).toBeNull();
    expect(classifyUploadFile('setup.exe', 'application/octet-stream', 1024)).toBeNull();
    expect(classifyUploadFile('data.bin', 'application/octet-stream', 1024)).toBeNull();
  });

  it('rejects any file over the size cap regardless of type', () => {
    expect(classifyUploadFile('big.txt', 'text/plain', UPLOAD_LIMITS.MAX_UPLOAD_BYTES + 1)).toBeNull();
    expect(classifyUploadFile('big.pdf', 'application/pdf', UPLOAD_LIMITS.MAX_UPLOAD_BYTES + 1)).toBeNull();
  });
});
describe('guessPasteName', () => {
  it('uses the 350 code-point boundary consistently', () => {
    expect(PASTE_FILE_THRESHOLD).toBe(350);
    expect([...('😀'.repeat(350))].length).toBe(350);
  });

  it('detects JSON payloads', () => {
    expect(guessPasteName('{"a": 1, "b": [1,2,3]}')).toMatch(/\.json$/);
    expect(guessPasteName('[{"x":1},{"x":2}]')).toMatch(/\.json$/);
  });

  it('detects markdown fences and headings', () => {
    expect(guessPasteName('```ts\nconst a = 1\n```')).toMatch(/\.md$/);
    expect(guessPasteName('# Title\n\nsome body')).toMatch(/\.md$/);
  });

  it('detects uniform CSV/TSV tables', () => {
    expect(guessPasteName('a,b,c\n1,2,3\n4,5,6')).toMatch(/\.csv$/);
    expect(guessPasteName('a\tb\n1\t2\n3\t4')).toMatch(/\.csv$/);
  });

  it('falls back to .txt for plain prose', () => {
    expect(guessPasteName('just some plain pasted text across\nmultiple lines here')).toMatch(/\.txt$/);
  });

  it('produces names with a timestamp prefix', () => {
    expect(guessPasteName('hello world')).toMatch(/^pasted-\d{8}-\d{6}\.txt$/);
  });
});

describe('composeMessageWithAttachments', () => {
  it('passes text through unchanged when there are no attachments', () => {
    expect(composeMessageWithAttachments('hello', [])).toBe('hello');
    expect(composeMessageWithAttachments('', [])).toBe('');
  });

  it('references saved text files without inlining their body', () => {
    const a = att('long.txt', 'SECRET LONG BODY');
    const out = composeMessageWithAttachments('review this', [a]);
    expect(out).toContain('/tmp/x/long.txt');
    expect(out).toContain('read_file');
    expect(out).not.toContain('SECRET LONG BODY');
  });

  it('uses an explicit memory fallback when a text file has no path', () => {
    const a = { ...att('long.txt', 'FALLBACK BODY'), path: '' };
    const out = composeMessageWithAttachments('', [a]);
    expect(out).toContain('浏览器开发模式内存回退');
    expect(out).toContain('FALLBACK BODY');
  });
  it('appends each attachment after a marker with name and size', () => {
    const a = att('pasted-x.txt', 'file body');
    const out = composeMessageWithAttachments('please review', [a]);
    expect(out).toContain('please review');
    expect(out).toContain('[粘贴文件: pasted-x.txt');
    expect(out).not.toContain('file body');
    expect(out.indexOf('[粘贴文件')).toBeGreaterThan(-1);
  });

  it('joins multiple attachment references in order', () => {
    const a1 = att('one.txt', 'ONE');
    const a2 = att('two.csv', 'TWO');
    const out = composeMessageWithAttachments('hi', [a1, a2]);
    expect(out.indexOf('/tmp/x/one.txt')).toBeLessThan(out.indexOf('/tmp/x/two.csv'));
    expect(out).not.toContain('ONE');
    expect(out).not.toContain('TWO');
  });

  it('skips empty parts so a bare attachment message still composes', () => {
    const a = att('x.log', 'log data');
    const out = composeMessageWithAttachments('   ', [a]);
    expect(out).not.toContain('log data');
    expect(out).toContain('/tmp/x/x.log');
  });

  it('references images by path instead of inlining binary', () => {
    const a = imgAtt('shot.png', '/tmp/sess/shot.png');
    const out = composeMessageWithAttachments('look at this', [a]);
    expect(out).toContain('look at this');
    expect(out).toContain('[粘贴图片/截图: shot.png');
    expect(out).toContain('/tmp/sess/shot.png');
    expect(out).not.toContain('base64,AAAA');
  });

  it('images without a saved path still get the marker', () => {
    const a = imgAtt('shot.png', '');
    const out = composeMessageWithAttachments('', [a]);
    expect(out).toContain('[粘贴图片/截图: shot.png');
  });

  it('references dropped binary files by path without inlining bytes', () => {
    const a: PasteAttachment = {
      id: 'b1', name: 'archive.zip', size: 2048, content: '',
      path: '/tmp/sess/archive.zip', kind: 'binary', dataUrl: '', mime: 'application/zip', openOnClick: true,
    };
    const out = composeMessageWithAttachments('inspect this', [a]);
    expect(out).toContain('[粘贴文件: archive.zip');
    expect(out).toContain('/tmp/sess/archive.zip');
  });
});

describe('fileIconOf', () => {
  it('chooses recognizable icons by file type', () => {
    expect(fileIconOf('photo.png', 'image')).toBe('🖼️');
    expect(fileIconOf('report.pdf', 'binary')).toBe('📕');
    expect(fileIconOf('app.ts', 'text')).toBe('💻');
    expect(fileIconOf('archive.bin', 'binary')).toBe('📦');
  });
});

describe('imageExtOf', () => {
  it('maps common MIME types to extensions', () => {
    expect(imageExtOf('image/png')).toBe('png');
    expect(imageExtOf('image/jpeg')).toBe('jpg');
    expect(imageExtOf('image/gif')).toBe('gif');
    expect(imageExtOf('image/webp')).toBe('webp');
    expect(imageExtOf('image/svg+xml')).toBe('svg');
  });

  it('defaults to png for unknown or missing MIME', () => {
    expect(imageExtOf('')).toBe('png');
    expect(imageExtOf('application/pdf')).toBe('png');
    expect(imageExtOf('image/')).toBe('png');
  });
});

describe('attachment presentation metadata', () => {
  it('keeps distinct file kinds available for visual styling', () => {
    const text = att('notes.md', 'hello');
    const image = imgAtt('screen.png', '/tmp/screen.png');
    const binary: PasteAttachment = {
      id: 'b1', name: 'archive.zip', size: 2048, content: '', path: '/tmp/archive.zip',
      kind: 'binary', dataUrl: '', mime: 'application/zip', openOnClick: true,
    };
    expect(text.kind).toBe('text');
    expect(image.kind).toBe('image');
    expect(binary.kind).toBe('binary');
    expect(fileIconOf(text.name, text.kind)).toBe('📝');
    expect(fileIconOf(image.name, image.kind)).toBe('🖼️');
    expect(fileIconOf(binary.name, binary.kind)).toBe('🗜️');
  });
});

describe('paste threshold', () => {
  it('exposes the 350 code-point cutoff the manager compares against', () => {
    expect(PASTE_FILE_THRESHOLD).toBe(350);
  });
});
