// src/adapter/memory/__tests__/PromptComposer.test.ts
// v0.10 — PromptComposer injects retrieved memories into the <session_memory>
// section (Adapter Layer 设计文档 §12.4 / Harness 设计文档 §3.8).

import { describe, it, expect } from 'bun:test';
import { PromptComposer } from '../PromptComposer';

const composer = new PromptComposer();

describe('PromptComposer.compose', () => {
  it('returns the template unchanged when no memory is provided', () => {
    const template = 'You are pure.';
    expect(composer.compose({ template })).toBe(template);
  });

  it('returns the template unchanged for empty memory arrays', () => {
    const template = 'You are pure.';
    expect(composer.compose({ template, memory: { preferences: [], errorPatterns: [] } })).toBe(template);
  });

  it('injects preferences and error patterns into an existing <session_memory> section', () => {
    const template = 'Base prompt.\n\n<session_memory>\nplaceholder\n</session_memory>\n\nFooter.';
    const out = composer.compose({
      template,
      memory: {
        preferences: ['User prefers the TypeScript language'],
        errorPatterns: ['Error X fixed by Y'],
      },
      project: '/ws/proj',
    });
    expect(out).toContain('Project: /ws/proj');
    expect(out).toContain('User preferences:');
    expect(out).toContain('- User prefers the TypeScript language');
    expect(out).toContain('Known error patterns:');
    expect(out).toContain('- Error X fixed by Y');
    expect(out).not.toContain('placeholder');
    // Surrounding template text survives
    expect(out).toContain('Base prompt.');
    expect(out).toContain('Footer.');
  });

  it('appends a <session_memory> block when the template has none', () => {
    const out = composer.compose({
      template: 'No memory section here.',
      memory: { preferences: ['User prefers tabs'], errorPatterns: [] },
    });
    expect(out).toContain('No memory section here.');
    expect(out).toContain('<session_memory>');
    expect(out).toContain('- User prefers tabs');
    expect(out).toContain('</session_memory>');
  });

  it('only emits sections that have content', () => {
    const out = composer.compose({
      template: 't',
      memory: { preferences: [], errorPatterns: ['E'] },
    });
    expect(out).not.toContain('User preferences:');
    expect(out).toContain('Known error patterns:');
  });

  it('emits proven procedures ahead of preferences and error patterns', () => {
    const out = composer.compose({
      template: 'Base.',
      memory: {
        preferences: ['User prefers tabs'],
        errorPatterns: ['Error X'],
        procedures: ['When facing Y, run npm test first'],
      },
    });
    expect(out).toContain('Proven procedures (apply when the situation matches):');
    expect(out.indexOf('Proven procedures')).toBeGreaterThan(out.indexOf('User preferences:'));
    expect(out.indexOf('Proven procedures')).toBeGreaterThan(out.indexOf('Known error patterns:'));
    expect(out).toContain('- When facing Y, run npm test first');
  });

  it('returns the template unchanged when only procedures are absent', () => {
    const out = composer.compose({
      template: 'Base.',
      memory: { preferences: [], errorPatterns: [], procedures: [] },
    });
    expect(out).toBe('Base.');
  });
});
