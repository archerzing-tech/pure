// src/shared/pageBaselineCheck.ts
// 页面交付物底线自检（2026-11-24 pure vs Claude 对拍落地刀）。
//
// 判例：同题三案对拍里 Claude 的静态校验抓得住「配色数学」（dataviz 校验器
// PASS/FAIL），而 pure 的大屏交付 aria 标注为零（T2 有 17 处、T3 归零——
// 任务一大底线就滑）。这类「机械可判的交付底线」不该指望模型记得查：按
// 「判据须常驻决策点、机械注入是唯一可靠通道」把它做成写文件时的感知手脚，
// 发现附加在 write_file 返回体里——pure 只做感知，修不修由模型裁决
// （自愈裁决权归模型判例），绝不拦截写入（快照是脚手架不是闸门，同判）。
//
// v1 检查面（全部机械可判，宁缺勿滥——误报会教会模型忽略本通道）：
//   1. 交互面 HTML 无任何 aria-/role= 标注（硬）
//   2. outline 被抹掉且无 :focus-visible 替代——键盘用户失去焦点位置（硬）
//   3. 有 animation/transition 但无 prefers-reduced-motion 降级（软）
//   4. 同一规则块内显式成对的 color+background 对比度：
//      <3:1 硬（连大文本底线都不到）、<4.5:1 软（正文阅读吃力）。
//      只解一层 var() 引用；渐变/图片背景/低透明度/命名色一律跳过——
//      解析不了的不报，是本通道「宁缺勿滥」的另一半。
//
// CVD（色觉障碍下的系列色区分度）挂在账上：需要「哪些颜色是系列色」的
// 语义信息，CSS 静态分析分不出来，等有显式调色板输入面再做。

export interface BaselineFinding {
  /** 硬=低于公认底线（ WCAG 3:1 / 键盘可达性灭失）；软=可能有问题 */
  severity: 'hard' | 'soft';
  /** 中文一句话：证据 + 为什么是问题。不写劝导语——发现即事实。 */
  message: string;
}

const BASELINE_CAP = 8;
const CONTRAST_CAP = 6;

/** 本检查覆盖的交付物：HTML（含内联 <style>）与独立 CSS。 */
export function isPageDeliverable(path: string): boolean {
  return /\.(html?|css)$/i.test(path);
}

interface Rgba { r: number; g: number; b: number; a: number }

/** 解析 #rgb / #rrggbb / rgb() / rgba()。命名色不做（表太大且歧义）。 */
function parseColor(raw: string): Rgba | null {
  const s = raw.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
  if (hex) {
    const h = hex[1];
    if (h.length === 3) {
      return {
        r: parseInt(h[0] + h[0], 16), g: parseInt(h[1] + h[1], 16), b: parseInt(h[2] + h[2], 16), a: 1,
      };
    }
    return {
      r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1,
    };
  }
  const fn = /^rgba?\(([^)]+)\)$/.exec(s);
  if (fn) {
    const parts = fn[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    if (parts.length >= 3 && parts.slice(0, 3).every((n) => Number.isFinite(n))) {
      return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 };
    }
  }
  return null;
}

/** WCAG 相对亮度：sRGB 分量线性化后按 2.2 权重合成。 */
function luminance(c: Rgba): number {
  const lin = (v: number) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

function contrastRatio(a: Rgba, b: Rgba): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** 值不可判读（渐变/图片/透明/继承/低透明度）→ 不报，宁缺勿滥。 */
function parseableSolid(raw: string): Rgba | null {
  const s = raw.trim();
  if (/gradient\(|url\(|transparent|inherit|currentColor/i.test(s)) return null;
  const c = parseColor(s);
  if (!c || c.a < 0.5) return null;
  return c;
}

/** 解一层 var() 引用；定义表里找不到就原样返回（后续 parseableSolid 兜底跳过）。 */
function resolveVars(value: string, vars: Map<string, string>): string {
  return value.replace(/var\((--[\w-]+)(?:\s*,[^)]+)?\)/g, (all, name: string) => vars.get(name) ?? all);
}

/** 收集全部 CSS 自定义属性定义（同名后者覆盖——v1 不做作用域）。 */
function collectCssVars(css: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const m of css.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+)[;}]/g)) vars.set(m[1], m[2].trim());
  return vars;
}

/** 对比度检查：同一规则块内显式成对的 color + background(-color)。 */
function checkContrast(css: string, out: BaselineFinding[]): void {
  const vars = collectCssVars(css);
  const seen = new Set<string>();
  const worst: { ratio: number; sel: string; fg: string; bg: string }[] = [];
  for (const block of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = block[1].trim().split(/[,\n]/).pop()!.trim().slice(0, 40);
    const body = block[2];
    const fgRaw = /(?:^|;)\s*color\s*:\s*([^;]+)/.exec(body);
    const bgRaw = /background(?:-color)?\s*:\s*([^;]+)/.exec(body);
    if (!fgRaw || !bgRaw) continue;
    const fg = parseableSolid(resolveVars(fgRaw[1], vars));
    const bg = parseableSolid(resolveVars(bgRaw[1], vars));
    if (!fg || !bg) continue;
    const key = `${fg.r},${fg.g},${fg.b},${fg.a}|${bg.r},${bg.g},${bg.b},${bg.a}`;
    if (seen.has(key)) continue;
    seen.add(key);
    worst.push({ ratio: contrastRatio(fg, bg), sel: selector, fg: fgRaw[1].trim(), bg: bgRaw[1].trim() });
  }
  worst.sort((a, b) => a.ratio - b.ratio);
  for (const w of worst.slice(0, CONTRAST_CAP)) {
    const ratioText = `${w.ratio.toFixed(2)}:1`;
    if (w.ratio < 3) {
      out.push({ severity: 'hard', message: `${w.sel} 文字 ${w.fg} 对背景 ${w.bg} 对比度 ${ratioText} < 3:1（大文本底线都不到）` });
    } else if (w.ratio < 4.5) {
      out.push({ severity: 'soft', message: `${w.sel} 文字 ${w.fg} 对背景 ${w.bg} 对比度 ${ratioText} < 4.5:1（正文阅读吃力）` });
    }
  }
}

/** HTML 内联 <style> 段拼接（行内 style 属性 v1 不查：无法定位声明块）。 */
function extractInlineCss(html: string): string {
  let css = '';
  for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) css += `\n${m[1]}`;
  return css;
}

/**
 * 页面交付物底线自检。只感知不拦截；空数组 = 本通道无发现。
 * 误报会教会模型忽略整个通道——每条判据都按「机械可判」准入。
 */
export function pageBaselineCheck(path: string, content: string): BaselineFinding[] {
  if (!isPageDeliverable(path)) return [];
  const isCss = /\.css$/i.test(path);
  const isHtml = /\.html?$/i.test(path);
  const css = isCss ? content : isHtml ? extractInlineCss(content) : '';
  const out: BaselineFinding[] = [];

  if (isHtml) {
    const interactive = /<\s*(script|form|input|button|select|textarea)\b/i.test(content);
    const a11yMarks = (content.match(/aria-|role=/gi) ?? []).length;
    if (interactive && a11yMarks === 0) {
      out.push({
        severity: 'hard',
        message: '交互页面无任何 aria-/role= 标注：表单控件与动态区域对屏幕阅读器不可见',
      });
    }
    if (/outline\s*:\s*(none|0)\b/i.test(content) && !/:focus-visible/i.test(content)) {
      out.push({
        severity: 'hard',
        message: 'outline 被抹掉且没有 :focus-visible 替代：键盘用户失去焦点位置',
      });
    }
  }

  if (css) {
    if (/animation\s*:|transition\s*:/i.test(css) && !/prefers-reduced-motion/i.test(css)) {
      out.push({
        severity: 'soft',
        message: '页面有 animation/transition 但未提供 prefers-reduced-motion 降级',
      });
    }
    checkContrast(css, out);
  }

  return out;
}

/** 组装附加到 write_file 返回体的中文小节。空数组返回空串（零成本）。
 *  硬发现排在前面（截断发生在排序之后——硬发现不允许被软发现挤出预算）。 */
export function formatBaselineFindings(findings: BaselineFinding[]): string {
  if (findings.length === 0) return '';
  const ranked = [...findings].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'hard' ? -1 : 1));
  const shown = ranked.slice(0, BASELINE_CAP);
  const lines = shown.map((f) => `- ${f.severity === 'hard' ? '硬' : '软'}|${f.message}`);
  if (findings.length > BASELINE_CAP) lines.push(`- …其余 ${findings.length - BASELINE_CAP} 条略`);
  return `\n[页面底线自检] ${findings.length} 项（感知非闸门）：\n${lines.join('\n')}`;
}
