// src/channels/rasterize/chromeCandidates.ts
// Platform candidate lists for finding a usable Chrome/Chromium. Zero node
// imports (no path/fs/os) — imported by the browser tool and therefore in the
// WebView bundle (see cdpSession.ts for why that matters). The lists are
// literal strings with separators baked in; no join() needed. env reads are
// guarded with a typeof check because the WebView has no `process`.

const MAC_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
];

const LINUX_CANDIDATES = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
];

const WIN_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

const WHICH_NAMES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];

/** 平台候选表单源：browser 工具（tools/impl/browser.ts）经 runtime 原语探测
 * 时传的是**全平台并集**——impl 层不碰 process.platform（WebView 里没有
 * process），exists 探测天然平台盲：别的平台的路径在本机自然 miss。env 读
 * 取带 typeof 防御，宿主端之外静默跳过。 */
export function allChromeCandidates(): { paths: string[]; whichNames: string[] } {
  const envPaths = typeof process !== 'undefined'
    ? [process.env.PURE_CHROME_PATH, process.env.CHROME_PATH].filter((p): p is string => Boolean(p))
    : [];
  return {
    paths: [...envPaths, ...MAC_CANDIDATES, ...LINUX_CANDIDATES, ...WIN_CANDIDATES],
    whichNames: [...WHICH_NAMES],
  };
}
