# pure update relay

自动更新中继（部署在 Vercel）。职责刻意收窄：**当地址簿，不当存储**。

- `GET /latest.json`（rewrite → `/api/latest`）：从 GitHub Releases 拉最新版
  `latest.json`，把资产 URL 重写为本服务的 `/api/asset` 重定向。应用内
  tauri updater 的 endpoints 指到这里。
- `GET /api/asset?tag=…&name=…`：307 回源 GitHub 公开下载地址（仓库公开，
  无需令牌；文件名白名单前缀防滥用）。

为什么需要它：updater 原端点 `releases.pure.app` 是占位域名；GitHub 直连在
部分网络不可达。Vercel 提供稳定可达的检查地址，二进制仍由 GitHub 承载
（重定向不经手字节，无带宽与体积压力）。

部署：

```bash
cd services/update-relay
vercel deploy --prod
```

然后把 `src-tauri/tauri.conf.json` 的 `plugins.updater.endpoints[0]` 指到
`https://<部署域名>/latest.json`，随下个版本发出去。

 prerelease 说明：`/latest.json` 走 GitHub 的 `releases/latest`（排除
 prerelease）——稳定通道语义；beta 通道将来需要时再加 `?channel=` 分支。
