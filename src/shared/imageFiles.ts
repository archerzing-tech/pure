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

/** 图片读取上限：视觉输入直接进模型上下文（base64 膨胀 4/3），比文本的
 *  64MB 上限严得多。超限时给出压缩出路，不静默失败。 */
export const IMAGE_READ_MAX_BYTES = 5 * 1024 * 1024;
