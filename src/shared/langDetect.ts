// src/shared/langDetect.ts
// 思考/输出的语言对齐（2026-10-09 用户需求）：提示词里"Match the user's
// language"的教学实测拦不住思考跑英文——教学升机制：每轮按用户最新输入的
// **主要文字**判定语言，把一句显式指令挂到 system prompt 尾部（可替换标记，
// 续跑重注入时幂等替换不堆积）。中英混杂按主要文字算：中文夹英文关键词
// （编程提问的常态）依然是中文。

/** CJK 表意字符（含中文汉字与Extension A）；不细分日文假名——当前用户群
 *  中英为主，真出现假名输入再细分，不过度设计。 */
const CJK_RE = /[㐀-䶿一-鿿豈-﫿]/g;
/** 拉丁词：连续字母段（标识符 useEffect / setState 各算一词）。编程提问里
 *  代码 token 字符长但词少，按词数对比才不被带偏。 */
const LATIN_WORD_RE = /[A-Za-z][A-Za-z0-9_+.\-]*/g;
/** 自然语言英文词：空白分隔出的**纯字母** token（路径 ~/work/config.json、
 *  json 串粘连着标点不成 token，不构成英文证据）。 */
const NATURAL_WORD_RE = /^[A-Za-z][A-Za-z'-]*[A-Za-z]$/;

/** 用户输入的主要语言：汉字数不少于拉丁词数 → 中文——"中英混杂看主要文
 *  字"的口径（代码、API 名再多也只是点缀）。无汉字时，英文证据必须是
 *  空格分隔的自然语言词组（json/路径片段不成句子，不构成英文证据），
 *  否则默认中文（pure 的默认会话语言）。 */
export function detectReplyLanguage(text: string): 'zh' | 'en' {
  // 只看前 2000 字符：语言判定不需要全文，长粘贴里尾部代码会稀释占比。
  const sample = (text ?? '').slice(0, 2000);
  const cjk = sample.match(CJK_RE)?.length ?? 0;
  if (cjk === 0) {
    const naturalWords = sample.split(/\s+/).filter((token) => NATURAL_WORD_RE.test(token)).length;
    return naturalWords >= 3 ? 'en' : 'zh';
  }
  const words = sample.match(LATIN_WORD_RE)?.length ?? 0;
  return cjk >= words ? 'zh' : 'en';
}

/** 挂进 system prompt 的显式指令（含思考——用户点名思考跑英文是痛点）。 */
export function replyLanguageDirective(lang: 'zh' | 'en'): string {
  return lang === 'zh'
    ? '用户要求用中文来思考与输出。'
    : 'The user expects reasoning and output in English.';
}

const LANG_TAG_RE = /\n<user_language>[\s\S]*?<\/user_language>/;

/** 把语言指令挂到 system prompt 尾部；已有标记先剥再挂——续跑重注入幂等，
 *  不会一行行堆。 */
export function applyLanguageDirective(systemPrompt: string, directive: string): string {
  return `${systemPrompt.replace(LANG_TAG_RE, '')}\n<user_language>${directive}</user_language>`;
}

/** 引擎装配用：从一段消息史里找最后一条真人用户消息（internal 是宿主代劳
 *  的续跑/修复轮，语言不代表用户）。 */
export function lastHumanUserText(messages: ReadonlyArray<{ role: string; content: string; internal?: boolean }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user' && !m.internal) return m.content;
  }
  return '';
}
