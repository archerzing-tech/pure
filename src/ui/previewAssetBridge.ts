// 宿主侧预览资源桥（2026-11-20）：```html 卡里的加载器把跨域瓦片/模型请求
// postMessage 过来，这里用 Rust 的通用缓存命令取回并落盘，再把 asset:// URL
// 回给卡。卡只拿到一个本地 URL——不用担心沙箱不透明源、CORS 或 WebView 代理，
// 已缓存的资源第二次预览直接离线可用。
//
// 只接受本进程发过 token 的卡：token 随卡源码注入，用来挡住同页其他 iframe
// 的误用；真正的越权面（内网/本机地址）在 Rust 侧拒绝。请求并发由卡内加载器
// 限到 8，这里只做同 URL 去重，避免一张全景图被十几家瓦片同时拉一遍。

import { isPreviewAssetUrl } from '../shared/previewAssets';
import { netRouteProxyPair, recordProxyProbe } from '../shared/netRoute';
import { effectiveProxyUrl } from '../shared/proxy';
import { isTauriRuntime, tauriInvoke } from '../shared/tauri';
import { assetUrlFor } from './assetUrl';
import { loadConfig } from './config';

interface PreviewAssetRequest {
  channel: 'pure-preview-asset';
  token: string;
  id: number;
  url: string;
  source: Window;
}

interface PreviewAssetResult {
  assetUrl?: string;
  error?: string;
}

const issuedTokens = new Set<string>();
const inflight = new Map<string, Promise<string>>();
let bridgeInstalled = false;

function freshToken(): string {
  const bytes = new Uint8Array(8);
  try {
    crypto.getRandomValues(bytes);
  } catch {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return 'pca-' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 一次卡片 hydration 发一个 token；加载器源码里带的就是它。 */
export function issuePreviewCardToken(): string {
  installPreviewAssetBridge();
  const token = freshToken();
  issuedTokens.add(token);
  // 会话里卡片数量有限；超出上限时丢最早的一个，避免无限增长。
  if (issuedTokens.size > 400) {
    const oldest = issuedTokens.values().next().value;
    if (oldest) issuedTokens.delete(oldest);
  }
  return token;
}

function installPreviewAssetBridge(): void {
  if (bridgeInstalled) return;
  if (typeof window === 'undefined') return;
  bridgeInstalled = true;
  window.addEventListener('message', (event: MessageEvent) => {
    const request = parseRequest(event);
    if (!request) return;
    if (!request.url || !isPreviewAssetUrl(request.url)) {
      reply(request, { error: 'not an external preview asset URL' });
      return;
    }
    let task = inflight.get(request.url);
    if (!task) {
      task = cachePreviewAsset(request.url);
      inflight.set(request.url, task);
      task.then(
        () => inflight.delete(request.url),
        () => inflight.delete(request.url),
      );
    }
    task.then(
      (assetUrl) => reply(request, { assetUrl }),
      (err: unknown) => reply(request, { error: err instanceof Error ? err.message : String(err) }),
    );
  });
}

function parseRequest(event: MessageEvent): PreviewAssetRequest | null {
  const source = event.source;
  if (!source || source === window) return null;
  const data = event.data as Partial<PreviewAssetRequest> | null;
  if (!data || data.channel !== 'pure-preview-asset') return null;
  if (typeof data.token !== 'string' || !issuedTokens.has(data.token)) return null;
  if (typeof data.id !== 'number' || typeof data.url !== 'string') return null;
  return { channel: 'pure-preview-asset', token: data.token, id: data.id, url: data.url, source: source as Window };
}

function reply(request: PreviewAssetRequest, result: PreviewAssetResult): void {
  try {
    request.source.postMessage({
      channel: 'pure-preview-asset-reply',
      token: request.token,
      id: request.id,
      ok: Boolean(result.assetUrl),
      assetUrl: result.assetUrl,
      error: result.error,
    }, '*');
  } catch {
    // iframe 已被重渲染移除：没有接收方，缓存本身仍然有效。
  }
}

/** 先按路由脑的首选路线取，失败换兜底路线重试——与地图瓦片同一条链路。 */
async function cachePreviewAsset(url: string): Promise<string> {
  if (!isTauriRuntime()) throw new Error('preview asset cache needs the desktop app');
  const config = loadConfig();
  const pair = netRouteProxyPair(url, config ? effectiveProxyUrl(config.proxy) : '');
  const fetchOnce = async (proxyUrl: string): Promise<string> => {
    const path = await tauriInvoke<string>('cache_preview_asset', { url, proxyUrl });
    return assetUrlFor(path);
  };
  try {
    const assetUrl = await fetchOnce(pair.proxyUrl);
    if (pair.proxyUrl) recordProxyProbe(pair.proxyUrl, true);
    return assetUrl;
  } catch (err) {
    if (pair.proxyUrl) recordProxyProbe(pair.proxyUrl, false);
    if (!pair.fallbackProxyUrl || pair.fallbackProxyUrl === pair.proxyUrl) throw err;
    const assetUrl = await fetchOnce(pair.fallbackProxyUrl);
    recordProxyProbe(pair.fallbackProxyUrl, true);
    return assetUrl;
  }
}
