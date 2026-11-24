// src/shared/__tests__/pageBaselineCheck.test.ts
// 页面底线自检（2026-11-24 对拍落地刀）：感知非闸门，判据机械可判。
// 「宁缺勿滥」是本通道的生命线——误报会教会模型忽略整个通道，
// 所以每条跳过路径（渐变/低透明/不成对/命名色）都有用例锁住。

import { describe, expect, it } from 'bun:test';
import {
  formatBaselineFindings,
  isPageDeliverable,
  pageBaselineCheck,
} from '../pageBaselineCheck';

describe('isPageDeliverable', () => {
  it('accepts html/htm/css, rejects everything else', () => {
    expect(isPageDeliverable('index.html')).toBe(true);
    expect(isPageDeliverable('page.htm')).toBe(true);
    expect(isPageDeliverable('theme.CSS')).toBe(true);
    expect(isPageDeliverable('app.ts')).toBe(false);
    expect(isPageDeliverable('data.json')).toBe(false);
    expect(isPageDeliverable('readme.md')).toBe(false);
  });
});

describe('pageBaselineCheck — aria 底线', () => {
  it('interactive page without any aria-/role= marks a hard finding', () => {
    const html = '<html><body><form><input name="e"><button>go</button></form></body></html>';
    const out = pageBaselineCheck('login.html', html);
    const hit = out.find((f) => f.message.includes('aria-'));
    expect(hit?.severity).toBe('hard');
  });

  it('aria-label presence clears the finding', () => {
    const html = '<form><input aria-label="邮箱"><button>go</button></form>';
    expect(pageBaselineCheck('login.html', html).some((f) => f.message.includes('aria-'))).toBe(false);
  });

  it('role= also counts as a mark', () => {
    const html = '<div role="dialog"><button>ok</button></div>';
    expect(pageBaselineCheck('x.html', html).some((f) => f.message.includes('aria-'))).toBe(false);
  });

  it('static page (no interactive tags) never marks the aria finding', () => {
    const html = '<html><body><p>纯文本主页</p></body></html>';
    expect(pageBaselineCheck('home.html', html).some((f) => f.message.includes('aria-'))).toBe(false);
  });
});

describe('pageBaselineCheck — 焦点环', () => {
  it('outline:none without :focus-visible marks a hard finding', () => {
    const html = '<style>button:focus { outline: none; }</style><button>go</button>';
    const hit = pageBaselineCheck('x.html', html).find((f) => f.message.includes('focus-visible'));
    expect(hit?.severity).toBe('hard');
  });

  it(':focus-visible replacement clears the finding', () => {
    const html = '<style>button:focus { outline: none } button:focus-visible { outline: 2px solid }</style><button>go</button>';
    expect(pageBaselineCheck('x.html', html).some((f) => f.message.includes('focus-visible'))).toBe(false);
  });
});

describe('pageBaselineCheck — reduced-motion', () => {
  it('animation without prefers-reduced-motion marks a soft finding', () => {
    const html = '<style>.a { animation: rise .6s; transition: all .2s; }</style>';
    const hit = pageBaselineCheck('x.html', html).find((f) => f.message.includes('reduced-motion'));
    expect(hit?.severity).toBe('soft');
  });

  it('reduced-motion media query clears the finding', () => {
    const html = '<style>.a { animation: rise .6s } @media (prefers-reduced-motion: reduce) { .a { animation: none } }</style>';
    expect(pageBaselineCheck('x.html', html).some((f) => f.message.includes('reduced-motion'))).toBe(false);
  });
});

describe('pageBaselineCheck — 对比度', () => {
  it('2.85:1 pair marks hard; 4.48:1 pair marks soft', () => {
    const css = '.a { color: #999999; background: #ffffff } .b { color: #777777; background: #ffffff }';
    const out = pageBaselineCheck('t.css', css);
    expect(out.some((f) => f.severity === 'hard' && f.message.includes('#999999'))).toBe(true);
    expect(out.some((f) => f.severity === 'soft' && f.message.includes('#777777'))).toBe(true);
  });

  it('var() references are resolved one level via custom properties', () => {
    const css = ':root { --ink: #999999; --paper: #ffffff } .c { color: var(--ink); background-color: var(--paper) }';
    expect(pageBaselineCheck('t.css', css).some((f) => f.severity === 'hard')).toBe(true);
  });

  it('gradient backgrounds are skipped (unreadable, 宁缺勿滥)', () => {
    const css = '.g { color: #999999; background: linear-gradient(#000, #111) }';
    expect(pageBaselineCheck('t.css', css)).toEqual([]);
  });

  it('low-alpha colors are skipped', () => {
    const css = '.f { color: rgba(0,0,0,.3); background: #ffffff }';
    expect(pageBaselineCheck('t.css', css)).toEqual([]);
  });

  it('unpaired color (no background in same block) is skipped', () => {
    const css = '.p { color: #999999 }';
    expect(pageBaselineCheck('t.css', css)).toEqual([]);
  });

  it('high-contrast pairs produce no findings', () => {
    const css = '.ok { color: #111111; background: #ffffff }';
    expect(pageBaselineCheck('t.css', css)).toEqual([]);
  });

  it('html checks come from inline <style> blocks', () => {
    const html = '<style>.z { color: #999999; background: #ffffff }</style>';
    expect(pageBaselineCheck('t.html', html).some((f) => f.severity === 'hard')).toBe(true);
  });
});

describe('formatBaselineFindings', () => {
  it('returns empty string for no findings', () => {
    expect(formatBaselineFindings([])).toBe('');
  });

  it('renders hard-first lines with the section header', () => {
    const out = formatBaselineFindings([
      { severity: 'soft', message: '软问题' },
      { severity: 'hard', message: '硬问题' },
    ]);
    expect(out).toContain('[页面底线自检] 2 项');
    expect(out.indexOf('硬问题')).toBeLessThan(out.indexOf('软问题'));
    expect(out).toContain('感知非闸门');
  });

  it('caps at 8 findings with a truncation note', () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ severity: 'soft' as const, message: `问题${i}` }));
    const out = formatBaselineFindings(many);
    expect(out).toContain('其余 3 条略');
    expect(out).toContain('问题7');
    expect(out).not.toContain('问题8');
  });
});
