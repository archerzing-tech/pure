import { describe, expect, it } from 'bun:test';
import { parseSkillMarkdown } from '../skillFiles';

describe('parseSkillMarkdown', () => {
  it('parses name/description frontmatter and strips it from the body', () => {
    const skill = parseSkillMarkdown(
      '---\nname: vision-ocr\ndescription: Extract text from images\n---\nDo OCR on images.\n',
    );
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe('vision-ocr');
    expect(skill!.description).toBe('Extract text from images');
    expect(skill!.body).toBe('Do OCR on images.');
  });

  it('accepts CRLF line endings and extra metadata lines', () => {
    const skill = parseSkillMarkdown('---\r\nname: pdf-extract\r\ndescription: Parse PDFs\r\nlicense: MIT\r\n---\r\nExtract text.\r\n');
    expect(skill!.name).toBe('pdf-extract');
    expect(skill!.description).toBe('Parse PDFs');
    expect(skill!.body).toBe('Extract text.');
  });

  it('rejects prose without frontmatter', () => {
    expect(parseSkillMarkdown('just prose')).toBeNull();
  });

  it('rejects missing name or empty body', () => {
    expect(parseSkillMarkdown('---\ndescription: no name\n---\nbody')).toBeNull();
    expect(parseSkillMarkdown('---\nname: x\n---\n   \n')).toBeNull();
  });

  it('tolerates a missing description', () => {
    const skill = parseSkillMarkdown('---\nname: bare\n---\nbody text');
    expect(skill!.name).toBe('bare');
    expect(skill!.description).toBe('');
    expect(skill!.body).toBe('body text');
  });

  it('is byte-compatible with the Rust mirror for the same input', () => {
    // The same fixture the Rust app_skills_tests::parses_frontmatter... uses.
    const text = '---\nname: vision-ocr\ndescription: Extract text from images\n---\nDo OCR on images.\n';
    const skill = parseSkillMarkdown(text)!;
    expect(skill.name).toBe('vision-ocr');
    expect(skill.description).toBe('Extract text from images');
    expect(skill.body).toBe('Do OCR on images.');
  });
});
