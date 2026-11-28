// `gui:build` 的统一入口。存在的唯一原因是 updater 签名：基座
// tauri.conf.json 里 `bundle.createUpdaterArtifacts: true`，本地机器没有
// `TAURI_SIGNING_PRIVATE_KEY` 时，安装包已经打到磁盘之后 tauri 才报
// `A public key has been found, but no private key`，把一次成功的打包变成
// exit 1——CI 上永远看不见（那里有私钥），本地每次都要自己判断「这算成功吗」。
//
// mac 侧早有同类开关（scripts/build-gui-mac.sh 的 PURE_SKIP_UPDATER_SIGN=1，
// 用 --config 覆盖 createUpdaterArtifacts），Windows 没有对应入口，于是这个
// 包装把那个开关补成跨平台的：开关打开时注入同一份 --config，其余参数原样透传
// （`bun run gui:build -- --bundles nsis` 之类照旧可用）。
//
// 直接跑 CLI 的 JS 入口而不是 `bun run tauri`：Windows 上 bun 解析到 bun.cmd，
// Node 拒绝把含 cmd 特殊字符的参数交给 .cmd 垫片（'args[5]' contains a cmd.exe
// special character，正是 --config 那串 JSON），于是开关一开就炸在启动前。
// 顺带省掉一层 shell 垫片——仓库里 vite 也走 node 直连入口的同一套做法。
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const skipUpdaterSign = process.env.PURE_SKIP_UPDATER_SIGN === '1';
const tauriCli = fileURLToPath(new URL('../node_modules/@tauri-apps/cli/tauri.js', import.meta.url));

const args = [tauriCli, 'build'];
if (skipUpdaterSign) {
  args.push('--config', JSON.stringify({ bundle: { createUpdaterArtifacts: false } }));
}
args.push(...process.argv.slice(2));

const result = spawnSync(process.execPath, args, { stdio: 'inherit' });

if (result.error) {
  console.error(`Failed to run tauri build: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
