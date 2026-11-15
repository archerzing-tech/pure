# 4.8.4 启动卡 splash 复盘（2026-11-15）

> 状态：已结案（v4.8.4）。commit 锚：`9678d43` 引入 / 本次修复见本文末「处置」。
> 本文替换仓库根目录下那份临时记录 `recovery-changes.md`（已删除）：那份文档把根因记为
> "尚未完全定位"，并把未实际存在的内联兜底脚本、已撤销的文件回退写成了既成事实。

## 现象

应用启动后停在 boot splash，永远进不了主界面。此前同一台机器可正常使用（10:51 的
`gui_perf.log` 最后一条流式记录就是最后一次可用会话）。

## 根因

`9678d43`（默认约定可升级）把 `src/shared/defaultAgentsMd.ts` 改成：

```ts
const B64 = "PCEtLSBwdXJl…";
export const DEFAULT_AGENTS_MD = Buffer.from(B64, "base64").toString("utf8");
```

这个模块被 `src/ui/chat.ts` 直接 import，因而进入 GUI 的 webview bundle。**浏览器没有
`Buffer`**，模块求值期抛 `ReferenceError`，整个主 chunk 起不来——`main.ts` 一行都没执行，
`splash` 自然不会被撤。

叠了两层掩饰：

1. 6s CSS failsafe 当时写在 `styles.css`，而 `styles.css` 由 `deferredStyles.ts` 动态
   import：主模块挂掉它根本不存在。兜底依赖了它要兜的对象。
2. 错误台账（`errorLedger`）在 `main.ts` 里才安装，模块求值期崩溃时它还没上岗，所以
   `gui_errors.log` 里一条也没有——报障只剩用户口述。

## 证据

- `vite preview` 跑生产 bundle + Chromium：控制台 `ReferenceError: Buffer is not defined`，
  splash 不消失；修复后同一手法：splash 移除、输入框渲染、0 console error。
- 真机（`/Applications/pure.app` 4.8.4）：`gui_perf.log` 出现
  `{"kind":"boot","ms":969,"splash":"dismissed"}`。这一行只在主模块跑到撤场决策时写，
  模块求值期崩溃时为 0 行。

## 处置

1. `defaultAgentsMd.ts` 与生成脚本改回纯字符串字面量（`JSON.stringify`），`agents:sync`
   可复现、零 diff。
2. 6s failsafe 移到 `critical.css`（`index.html` 静态 `<link>`，模块挂了也在）；`styles.css`
   那份删除——两份同名 `@keyframes` 会让后注入的 `styles.css` 静默盖掉 critical 那份，
   单源丢失。
3. 启动取证 `logBootSample`：`splash=dismissed|forced` + 毫秒数，写在撤场决策点而不是
   `requestAnimationFrame` 里（窗口在后台时 rAF 会被节流，否则"没有这一行"会被误判成崩溃）。
4. 10s 强制撤场保留，作为"某个 invoke 永不回包"的最后一道；`withBootTimeout` 那层包装
   删除——它把"卡住"换成"静默用错主题/人格"（`applySoulOverrideFromDisk` 超时会违反
   "覆盖必须在 applySavedCharacterProfile 之前落位"的契约），根因既已修掉，收益不成立。

## 教训

- 构建期能拦住的是 `import 'node:*'`；**Node 全局（`Buffer`/`process`）能溜进浏览器
  bundle**，只在运行期炸。`src/shared/` 里任何进 GUI 图的模块，顶层不许碰这两类东西。
- 兜底不能依赖被兜底的对象：主 chunk 挂掉时，只有 `index.html` 静态加载的
  `critical.css` 还活着。
- 证据要写在"崩不到"的那一侧：崩溃前的日志行必须在崩溃点之前已经落盘。
