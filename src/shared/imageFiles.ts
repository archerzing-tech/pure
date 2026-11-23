// src/shared/imageFiles.ts
// read_file 图片视觉输入（电脑端操作能力 P2，2026-11-08）：模型用 read_file
// 读本机图片时直接走 ToolResult.images 通道（引擎折进下一条 tool 消息，
// W4-2 同款回路）。扩展名→MIME 单源：CLI（NodeToolAdapter）与 GUI
//（TauriToolAdapter）共用；Rust 侧 read_image_file 自带同表，改要同步。

export const IMAGE_MIME_BY_EXT: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
};

/** 路径是否指向一张可视觉读取的图片（按扩展名判定）。 */
export function imageMimeForPath(path: string): string | null {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return IMAGE_MIME_BY_EXT[ext] ?? null;
}

function asciiAt(bytes: Uint8Array, offset: number, sig: string): boolean {
  if (bytes.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (bytes[offset + i] !== sig.charCodeAt(i)) return false;
  }
  return true;
}

/** 按文件头判定图片 MIME；签名不认识就返回 null。
 *
 * 扩展名只说明「打算读成图片」，不保证内容真是图片：下载失败时 4xx/5xx 的
 * 响应体会被原样存成 .png（2026-11-23 大屏 A/B：395 字节 XML 错误页命名
 * oss.png，两臂都把它当图片附进请求，端点回 400 image format is not
 * supported，整轮就此终止）。判据必须是签名，不能是文件名。 */
export function sniffImageMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (asciiAt(bytes, 0, 'GIF87a') || asciiAt(bytes, 0, 'GIF89a')) return 'image/gif';
  if (asciiAt(bytes, 0, 'RIFF') && asciiAt(bytes, 8, 'WEBP')) return 'image/webp';
  if (asciiAt(bytes, 0, 'BM') && bytes.length >= 14) return 'image/bmp';
  return null;
}

/** 图片读取上限：视觉输入直接进模型上下文（base64 膨胀 4/3），比文本的
 *  64MB 上限严得多。超限时给出压缩出路，不静默失败。 */
export const IMAGE_READ_MAX_BYTES = 5 * 1024 * 1024;
