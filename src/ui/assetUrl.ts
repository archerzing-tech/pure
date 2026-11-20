// scheme-less 本机绝对路径(/Users/… 或 C:\…)在 WebView 里按同源相对 URL
// 解析(tauri://localhost/Users/…)必然 404——「主题风格一览」会话里技能
// 生成的配图全死在这。转 asset protocol 后经 asset://localhost(macOS/Linux)
// 或 http://asset.localhost(Windows)加载,CSP img-src 两形态都已放行。
// 只转「像本机绝对路径」的形状(POSIX / 开头但排除 //host、Windows 盘符开头);
// 浏览器 dev / 转换不可用时原样返回。直读 __TAURI_INTERNALS__ 是同步唯一路
// (renderer 是同步钩子,dynamic import 给不了),与 store.ts 的运行时探测同源。
//
// 独立成模块是为了预览资源桥也能用它，同时避免 markdown ⇄ bridge 的循环依赖；
// markdown 继续 re-export，老调用点无需改。
export function assetUrlFor(src: string): string {
  if (!/^\/(?!\/)/.test(src) && !/^[a-z]:[\\/]/i.test(src)) return src;
  const internals = typeof window !== 'undefined'
    ? (window as unknown as { __TAURI_INTERNALS__?: { convertFileSrc?: (path: string, protocol?: string) => string } }).__TAURI_INTERNALS__
    : undefined;
  const convert = internals?.convertFileSrc;
  if (!convert) return src;
  try {
    return convert(src);
  } catch {
    return src;
  }
}
