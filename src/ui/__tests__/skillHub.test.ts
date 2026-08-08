// src/ui/__tests__/skillHub.test.ts

import { describe, expect, it } from 'bun:test';
import {
  normalizeHubRepo,
  hubIndexUrls,
  normalizeIndex,
  splitSkillMarkdown,
  makeHubSkill,
  sanitizeSkillName,
  DEFAULT_HUB_REPO,
} from '../skillHub';

describe('normalizeHubRepo', () => {
  it('passes through owner/repo', () => {
    expect(normalizeHubRepo('vercel-labs/agent-skills')).toBe('vercel-labs/agent-skills');
  });

  it('extracts owner/repo from a full GitHub URL', () => {
    expect(normalizeHubRepo('https://github.com/vercel-labs/agent-skills')).toBe('vercel-labs/agent-skills');
    expect(normalizeHubRepo('https://github.com/vercel-labs/agent-skills.git')).toBe('vercel-labs/agent-skills');
    expect(normalizeHubRepo('https://github.com/vercel-labs/agent-skills/')).toBe('vercel-labs/agent-skills');
  });

  it('trims whitespace and rejects non-repo strings', () => {
    expect(normalizeHubRepo('  vercel-labs/agent-skills  ')).toBe('vercel-labs/agent-skills');
    expect(normalizeHubRepo('not-a-repo')).toBe('not-a-repo');
    expect(normalizeHubRepo('')).toBe('');
  });
});

describe('hubIndexUrls', () => {
  it('probes skills.sh.json first, then the standard discovery paths', () => {
    const urls = hubIndexUrls('vercel-labs/agent-skills');
    expect(urls[0]).toBe('https://raw.githubusercontent.com/vercel-labs/agent-skills/HEAD/skills.sh.json');
    expect(urls.some((u) => u.includes('.well-known/skills/index.json'))).toBe(true);
  });
});

describe('normalizeIndex', () => {
  it('parses the skills.sh.json grouped format', () => {
    const index = normalizeIndex({
      groupings: [
        { title: 'React', description: 'React skills', skills: ['a', 'b'] },
        { title: 'Empty', description: '', skills: [] },
        { title: 'Design', skills: ['web-design-guidelines'] },
      ],
    });
    expect(index).not.toBeNull();
    expect(index!.groupings.length).toBe(2);
    expect(index!.groupings[0].title).toBe('React');
    expect(index!.groupings[0].skills.map((s) => s.name)).toEqual(['a', 'b']);
    expect(index!.groupings[1].skills[0].name).toBe('web-design-guidelines');
  });

  it('parses the standard index.json V1 format', () => {
    const index = normalizeIndex({
      skills: [
        { name: 'foo', description: 'Foo skill', files: ['SKILL.md'] },
        { name: '', description: 'bad' },
      ],
    });
    expect(index).not.toBeNull();
    expect(index!.skills.length).toBe(1);
    expect(index!.skills[0].name).toBe('foo');
    expect(index!.skills[0].description).toBe('Foo skill');
    expect(index!.skills[0].hasDescription).toBe(true);
  });

  it('parses the standard index.json V2 format (with $schema)', () => {
    const index = normalizeIndex({
      $schema: 'https://skills.sh/schemas/agent-skill.schema.json',
      skills: [
        { name: 'bar', description: 'Bar skill', type: 'builtin', url: 'https://…/bar.zip', digest: 'abc' },
      ],
    });
    expect(index).not.toBeNull();
    expect(index!.skills[0].name).toBe('bar');
  });

  it('returns null for non-object or empty indexes', () => {
    expect(normalizeIndex(null)).toBeNull();
    expect(normalizeIndex('nope')).toBeNull();
    expect(normalizeIndex({ groupings: [] })).toBeNull();
    expect(normalizeIndex({ skills: [] })).toBeNull();
    expect(normalizeIndex({ skills: [{ bad: true }] })).toBeNull();
  });
});

describe('splitSkillMarkdown', () => {
  it('strips frontmatter and returns the body', () => {
    const md = `---\nname: web-design-guidelines\ndescription: Review UI code for compliance.\nmetadata:\n  author: vercel\n---\n\n# Guidelines\n\nDo the thing.`;
    const split = splitSkillMarkdown(md);
    expect(split.description).toBe('Review UI code for compliance.');
    expect(split.body).toContain('# Guidelines');
    expect(split.body).toContain('Do the thing.');
    expect(split.body).not.toContain('name:');
  });

  it('handles markdown without frontmatter', () => {
    const md = '# Plain\n\nNo frontmatter here.';
    const split = splitSkillMarkdown(md);
    expect(split.description).toBeUndefined();
    expect(split.body).toBe(md);
  });

  it('handles CRLF line endings', () => {
    const md = '---\r\ndescription: "Quoted desc"\r\n---\r\n\r\nBody text';
    const split = splitSkillMarkdown(md);
    expect(split.description).toBe('Quoted desc');
    expect(split.body).toBe('Body text');
  });
});

describe('sanitizeSkillName', () => {
  it('keeps safe ids and neutralizes hostile characters', () => {
    expect(sanitizeSkillName('web-design-guidelines')).toBe('web-design-guidelines');
    expect(sanitizeSkillName('foo.bar/baz-1')).toBe('foo.bar/baz-1');
    expect(sanitizeSkillName('bad">x')).toBe('bad__x');
    expect(sanitizeSkillName('a b<c>')).toBe('a_b_c_');
  });
});

describe('makeHubSkill', () => {
  it('builds a persisted HubSkill from a summary and body', () => {
    const skill = makeHubSkill(
      'https://github.com/vercel-labs/agent-skills',
      { name: 'web-design-guidelines', description: 'Review UI', hasDescription: true },
      '# Guidelines body',
      true,
    );
    expect(skill.name).toBe('web-design-guidelines');
    expect(skill.source).toBe('vercel-labs/agent-skills');
    expect(skill.body).toBe('# Guidelines body');
    expect(skill.enabled).toBe(true);
  });

  it('defaults to the shipped hub repo', () => {
    expect(DEFAULT_HUB_REPO).toBe('vercel-labs/agent-skills');
  });
});
