// src/engine/FileWriteOwnership.ts
// 文件级写所有权（2026-11-23 大屏 A/B 判例）：主线程把地图层交给一个 worker、
// 图表交给另一个，自己写编排层；worker 与主线后来都写 js/map-engine.js，落盘
// 成了「主线 700 行 + worker 480 行」两套内部约定拼接的残片，语法直接报错，
// 模型先花十几轮诊断自己的伤才回到正题。
//
// FileLockManager 只保证不并发交错；两次写先后发生同样会坏。这里补的是
// **执行者维度的版本纪律**，不引入需要过期/释放的租约：
//   · 每条路径记住最后写它的人与版本号；
//   · 同一个执行者反复写自己的文件：零摩擦；
//   · 换人写：必须先读过「对方写下的这一版」——盲写拒绝（拼接就是这么来的），
//     读过再覆盖允许，但结果里明说是接管，模型不会以为那是自己的稿子；
//   · append（分块续写）只对「自己上一版」成立：往别人的文件后面追加内容，
//     在任何情况下都不是续写，直接拒绝。
// 这样既挡住了共写，也不会把「子代理写完、主线再去修」这种正常接力挡住。

export interface WriteVerdict {
  allow: boolean;
  /** 拒绝时给模型看的话。 */
  message?: string;
  /** 允许但需要披露时（接管别人的稿子）附在工具结果后的说明。 */
  note?: string;
}

interface PathMeta {
  lastWriter: string;
  label?: string;
  version: number;
}

const meta = new Map<string, PathMeta>();
/** owner → path → 该执行者读到的版本号 */
const seenVersion = new Map<string, Map<string, number>>();

/** 归一化写路径：只做词法处理，不碰磁盘（新文件还不存在）。 */
export function normalizeWritePath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\.\//, '');
}

/** 执行者读完一条路径后登记「我看到了第几版」。 */
export function notePathRead(path: string, owner: string): void {
  const key = normalizeWritePath(path);
  if (!key) return;
  const current = meta.get(key);
  if (!current) return;
  let perOwner = seenVersion.get(owner);
  if (!perOwner) { perOwner = new Map(); seenVersion.set(owner, perOwner); }
  perOwner.set(key, current.version);
}

/** 写入前判定：能不能写、要不要披露。命中拒绝时不改任何状态。 */
export function notePathWrite(
  path: string,
  owner: string,
  opts: { append: boolean; label?: string },
): WriteVerdict {
  const key = normalizeWritePath(path);
  if (!key) return { allow: true };
  const current = meta.get(key);

  if (!current || current.lastWriter === owner) {
    meta.set(key, { lastWriter: owner, label: opts.label, version: (current?.version ?? 0) + 1 });
    return { allow: true };
  }

  const foreign = current.label || current.lastWriter;
  if (opts.append) {
    return {
      allow: false,
      message: `'${path}' 现在是 ${foreign} 写下的内容，不是你的分块续写对象。往别的执行者刚写的文件后面追加，只会得到两份实现拼接的残片（2026-11-23 大屏判例）。先 read_file 看清它，需要改就用 edit_file 的增量；要整份重写用不带 append 的 write_file。`,
    };
  }

  const seen = seenVersion.get(owner)?.get(key);
  if (seen === undefined || seen < current.version) {
    return {
      allow: false,
      message: `'${path}' 已被 ${foreign} 写过，你还没看过这一版——盲写会把它的内容盖掉或拼在一起（2026-11-23 大屏判例：主线与地图 worker 共写同一文件，落盘成两套实现的残片）。先 read_file 读一遍再决定：改小地方用 edit_file，整份替换再 write_file；也可以先做别的文件。`,
    };
  }

  meta.set(key, { lastWriter: owner, label: opts.label, version: current.version + 1 });
  return {
    allow: true,
    note: `(note: 你覆盖了 ${foreign} 刚写过的这一版；如果只是想改一部分，edit_file 的增量更安全。)`,
  };
}

/** 这条路径当前最后写的人（调试与测试用）。 */
export function lastWriterOf(path: string): PathMeta | undefined {
  return meta.get(normalizeWritePath(path));
}

/** 测试用：清空全部记录。 */
export function resetWriteOwnership(): void {
  meta.clear();
  seenVersion.clear();
}
