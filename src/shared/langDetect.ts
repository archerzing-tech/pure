// src/shared/langDetect.ts
// 思考/输出的语言对齐（2026-10-09 用户需求）：提示词里"Match the user's
// language"的教学实测拦不住思考跑英文——教学升机制：每轮按用户最新输入的
// **主要文字**判定语言，把一句显式指令注入提示词。中英混杂按主要文字算：
// 中文夹英文关键词（编程提问的常态）依然是中文。
// 2026-11-06（P3 判定源污染收口）：判定与注入双双搬家——
//   1. 判定源剥注入块：GUI/CLI 的 user 消息前面拼着 <session_memory> /
//      <task_context> / <adaptive_context> 注入块（缓存地基 P1 的通道），
//      detectReplyLanguage 的 2000 字符样本曾被注入块灌满、真人文本根本
//      没进样本。判定前先剥围栏，只看真人自己的话。
//   2. 指令离开 system 尾部：语言指令随 user-turn 注入件走
//      （compileRequestWorkflow 判定 → UserTurnContext.languageDirective），
//      system 回归全静态前缀——语言切换回合不再打断端点前缀缓存。
//      applyLanguageDirective / <user_language> 标记退役。

/** CJK 表意字符（含中文汉字与Extension A）；不细分日文假名——当前用户群
 *  中英为主，真出现假名输入再细分，不过度设计。 */
const CJK_RE = /[㐀-䶿一-鿿豈-﫿]/g;
/** 拉丁词：连续字母段（标识符 useEffect / setState 各算一词）。编程提问里
 *  代码 token 字符长但词少，按词数对比才不被带偏。 */
const LATIN_WORD_RE = /[A-Za-z][A-Za-z0-9_+.\-]*/g;
/** 自然语言英文词：空白分隔出的**纯字母** token（路径 ~/work/config.json、
 *  json 串粘连着标点不成 token，不构成英文证据）。 */
const NATURAL_WORD_RE = /^[A-Za-z][A-Za-z'-]*[A-Za-z]$/;

/** 宿主拼在真人文本前面的注入块围栏（task_context=promptLayers 通道，
 *  session_memory/adaptive_context=缓存地基 P1 的 Harness 首轮注入）。
 *  语言判定只认真人自己的话，这些块一律剥掉。 */
const INJECTION_BLOCK_RE = /<(?:task_context|session_memory|adaptive_context)>[\s\S]*?<\/(?:task_context|session_memory|adaptive_context)>\n*/g;

/** 剥掉 user 消息里拼在前面的注入块，留下真人文本。无块的输入原样返回
 *  （普通回合的常态）。 */
export function stripInjectionBlocks(text: string): string {
  return (text ?? '').replace(INJECTION_BLOCK_RE, '').replace(/^\n+/u, '');
}

/** 用户输入的主要语言：汉字数不少于拉丁词数 → 中文——"中英混杂看主要文
 *  字"的口径（代码、API 名再多也只是点缀）。无汉字时，英文证据必须是
 *  空格分隔的自然语言词组（json/路径片段不成句子，不构成英文证据），
 *  否则默认中文（pure 的默认会话语言）。 */
export function detectReplyLanguage(text: string): 'zh' | 'en' {
  // 只看前 2000 字符：语言判定不需要全文，长粘贴里尾部代码会稀释占比。
  const sample = stripInjectionBlocks(text ?? '').slice(0, 2000);
  const cjk = sample.match(CJK_RE)?.length ?? 0;
  if (cjk === 0) {
    const naturalWords = sample.split(/\s+/).filter((token) => NATURAL_WORD_RE.test(token)).length;
    return naturalWords >= 3 ? 'en' : 'zh';
  }
  const words = sample.match(LATIN_WORD_RE)?.length ?? 0;
  return cjk >= words ? 'zh' : 'en';
}

/** 注入 user-turn 的显式指令（含思考——用户点名思考跑英文是痛点）。 */
export function replyLanguageDirective(lang: 'zh' | 'en'): string {
  return lang === 'zh'
    ? '用户要求用中文来思考与输出。'
    : 'The user expects reasoning and output in English.';
}

