// services/update-relay/api/asset.ts
// 资产重定向：/api/asset?tag=v3.0.3&name=pure_3.0.3_x64-setup.exe → 307 到
// GitHub 公开下载地址（仓库公开，下载 URL 按 tag+name 决定，无需 API 往返）。
// tauri updater 跟随重定向；Vercel 不经手二进制字节。

export const config = { runtime: 'edge' };

const OWNER = 'archerzing-tech';
const REPO = 'pure';
// 文件名白名单前缀：本端点只重定向 release 产物，防止被当任意跳转服务用。
const ALLOWED_PREFIXES = ['pure', 'latest.json'];

export default async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const tag = url.searchParams.get('tag') ?? '';
  const name = url.searchParams.get('name') ?? '';
  if (!/^v?[0-9][A-Za-z0-9.\-]*$/.test(tag) || !/^[A-Za-z0-9._\-]+$/.test(name)) {
    return new Response(JSON.stringify({ error: 'bad tag or name' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (!ALLOWED_PREFIXES.some((p) => name.startsWith(p))) {
    return new Response(JSON.stringify({ error: 'asset not allowed' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
  }
  const target = `https://github.com/${OWNER}/${REPO}/releases/download/${tag}/${name}`;
  return new Response(null, {
    status: 307,
    headers: { location: target, 'cache-control': 'public, s-maxage=3600' },
  });
}
