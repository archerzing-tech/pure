# Tauri resources（随安装包递送的资源）

CLI 侧车不放这里——它在 `../binaries/`（构建链写入：`scripts/build-gui-mac.sh`、
`.github/workflows/release.yml`），安装后 `gateway_start` 的头号候选就是它。

本 README 是 `tauri.conf.json` 里 `bundle.resources` 的 `resources/*` glob 占位。
**不要删**：glob 匹配不到任何文件时 tauri 构建直接失败，当初 `binaries/*` 就是
因为目录里没有可提交的占位而被摘掉，Windows 安装包从此不再带 CLI——这正是
「Windows 点启动起不来」那一串故障的起点。
