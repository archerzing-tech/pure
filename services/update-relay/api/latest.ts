// services/update-relay/api/latest.ts
// pure 自动更新中继的目录端点。背景：tauri updater 的 endpoints 原指
// releases.pure.app/latest.json（占位域名，从未存在），应用更新检查因此一直
// 不通。本服务部署在 Vercel 上提供稳定地址：latest.json 目录从 GitHub
// Releases 拉取（仓库公开，无需令牌），资产 URL 重写为中继重定向，下载本身
// 307 回源 GitHub —— Vercel 只当地址簿，不存二进制。
//
// 端点语义（vercel.json 把 /latest.json 重写到这里）：
//   GET /latest.json → tauri updater 兼容的目录 JSON（version/signature/url），
//   url 指向 /api/asset?tag=…&name=…（重定向到 GitHub 公开下载地址）。

export const config = { runtime: 'edge' };

const OWNER = 'archerzing-tech';
const REPO = 'pure';

export default async function handler(request: Request): Promise<Response> {
  const origin = new URL(request.url).origin;
  try {
    // /releases/latest 会排除 prerelease —— 稳定通道语义；beta 走 tag 直查。
    const releaseRes = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'pure-update-relay' },
    });
    if (!releaseRes.ok) {
      return json({ error: `github api ${releaseRes.status}` }, 502);
    }
    const release = (await releaseRes.json()) as {
      tag_name: string;
      assets: Array<{ name: string; browser_download_url: string }>;
    };
    const catalog = release.assets.find((a) => a.name === 'latest.json');
    if (!catalog) {
      return json({ error: 'latest.json asset missing on latest release' }, 404);
    }
    const manifestRes = await fetch(catalog.browser_download_url, {
      headers: { 'user-agent': 'pure-update-relay' },
    });
    if (!manifestRes.ok) {
      return json({ error: `latest.json download ${manifestRes.status}` }, 502);
    }
    const manifest = (await manifestRes.json()) as {
      version?: string;
      platforms?: Record<string, { signature?: string; url?: string }>;
      [key: string]: unknown;
    };
    for (const entry of Object.values(manifest.platforms ?? {})) {
      if (typeof entry.url === 'string' && entry.url) {
        const name = entry.url.split('/').pop() ?? '';
        entry.url = `${origin}/api/asset?tag=${encodeURIComponent(release.tag_name)}&name=${encodeURIComponent(name)}`;
      }
    }
    return new Response(JSON.stringify(manifest, null, 2), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        // 更新检查允许短暂缓存；回源失败时 SWR 继续给上一版目录。
        'cache-control': 'public, s-maxage=300, stale-while-revalidate=3600',
      },
    });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
