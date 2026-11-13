# 性能问题落地计划（2026-11-13）

> 配套报告：`app-performance-review-2026-11-13.md`（问题与量级）。
> 本文只讲**怎么改**：改哪个函数、接口怎么变、旧档怎么兼容、怎么验收、怎么回退。
> 总原则：**每一项都必须能证明「用户点下去看到的画面、交互和等待时间都不变差」**，做不到的进 §5「不做」或 §6「需你点头」。

## 0. UX 不变的四个判据

任何一项改动合并前，必须同时满足：

1. **画面不变**：DOM 结构、类名、动效时长与触发条件不变（CSS 一行都不改）。
2. **交互不变**：按钮位置、点击区域、键盘路径、滚动行为不变。
3. **等待不变差**：首屏与首帧不增加新的同步等待（新增的异步加载只能发生在「首个需要它的内容出现时」）。
4. **数据不丢**：读回语义等价，旧档（无 sidecar / 顶层 `messages` / 双份 base64）仍能打开。

证明方式：每项都有对应单测 + 一条手工回归（§7），不靠「看起来没问题」。

---

## 1. 优先级总表

排序依据 = 收益 ÷ 风险，不是按量级排。P0 全是「纯内部、零 UX 变化」。

| 序 | 项 | 收益 | 改动面 | 风险 | 工作量 |
|---|---|---|---|---|---|
| **P0-1** | A2 快照身份哈希复用 | 省 9.8ms/次保存，线性于字节 | `store.ts` 一个函数 + 调用点 | 低 | 0.5d |
| **P0-2** | A1 保存路径去掉 2 次整份读 | 11.3MB 会话省 ≈16ms CPU + 22MB 读/次 | `lib.rs` 保存段 + 新 sidecar | 低（有旧档回退） | 0.5d |
| **P0-3** | A4 附件随会话回收 | 阻止磁盘无界增长 | `lib.rs` 两个删除命令 | 极低 | 0.2d |
| **P0-4** | A5 活动轨不重挂 | 去掉每拍 O(N) 结构变更 + 动画重启 | `agentActivityPanel.ts` | 低 | 0.3d |
| **P1-1** | A3 `read_file` 首窗读取 | 大文件工具延迟从秒级降到 ms 级 | `lib.rs` 读取段 | 中（编码边界） | 1d |
| **P1-2** | B1 历史图片降级 | **单张截图每轮省 3.74MB 上传** | 新 shared helper + 两处 adapter | 中（模型语义） | 0.5d |
| **P1-3** | B2 快照 IPC 直通 | 每次保存省一次 Rust 序列化 | 新命令 + 前端换调用 | 中（拼接校验） | 1d |
| **P2-1** | B3 `events.jsonl` 轮转 | 单会话从无界到 ≤8MB | 新命令 + 回合末尾触发 | 低 | 0.3d |
| **P2-2** | C1 katex 懒加载 | 首屏少 512KB JS | `markdown.ts` 动态化 | 低 | 0.3d |
| **P2-3** | C3 图片固有尺寸 | 消除恢复/解码时的布局跳动 | `types.ts` + `pasteChip.ts` + 三处 img | 低（视觉改善） | 0.3d |

建议节奏：**P0 一批合并**（互不冲突，可同一次 PR）→ P1-1 单独 → P1-2 单独（唯一动到模型输入的项）→ 其余按需。

---

## 2. P0：零 UX 变化的四项

### A2 快照身份哈希（`src/ui/store.ts:402`）

**改法**：`createSessionSnapshot` 增加可选参数 `priorTranscript`；已有条目**直接复用上一份的 id**，只有新追加的消息才计算新 id。

```ts
export function createSessionSnapshot(
  modelMessages: Message[],
  source: TranscriptDraft[] | StoredMessage[],
  uiState: Partial<SessionUiState> = {},
  statusLines: StatusLineRecord[] = [],
  priorTranscript: readonly TranscriptEntry[] = [],   // 新增，缺省 = 旧行为
): SessionSnapshotV3
```

内部：

```ts
const priorByIndex = new Map(priorTranscript.map(e => [e.modelMessageIndex, e]));
// 指纹只用长度 + 首尾 64 字符 + toolCallId：对图片 base64 是 O(1)，不再 stringify 整条消息
const fingerprint = (role: string, content: string, toolCallId?: string): string =>
  `${role}:${content.length}:${content.slice(0, 64)}:${content.slice(-64)}:${toolCallId ?? ''}`;

// 命中复用：同 index + 同 role + 同指纹 → 直接沿用旧 id
const prior = priorByIndex.get(draft.modelMessageIndex);
const priorId = prior && prior.role === message.role
  && fingerprint(prior.role, prior.content ?? '', prior.toolCallId) === fingerprint(message.role, message.content ?? '', message.toolCallId)
  ? prior.id
  : undefined;
```

- `occurrenceKey` 只在**没命中复用**时才计算（用同一个指纹字符串，不再 `JSON.stringify(message)`），重复消息仍按 occurrence 递增，去重语义不变。
- `TranscriptEntry` 不需要新增字段：指纹由 `role/content/toolCallId` 现场推导，旧快照读进来同样可用。
- `chat.ts` 的 `doPersistSession` 把上一份快照的 `transcript` 传进来（已经在内存里，无额外成本）。

**为什么 UX 不变**：id 只用于内部去重/锚点，且**已有条目的 id 一个都不变**（这是选「复用」而不是「换哈希算法」的原因——换算法会让老会话的 id 全部漂移，事件日志里按 id 的关联会断）。

**验收**：`src/ui/__tests__/store.test.ts` 加两条：
- 同一批消息构建两次 → `transcript.map(e => e.id)` 深度相等；
- 追加一条消息 → 前 N 条 id 不变，第 N+1 条是新 id。

**回退**：不传 `priorTranscript` 即回到旧行为，一行开关。

### A1 保存路径去掉 2 次整份读（`src-tauri/src/lib.rs:15210`）

**改法**：新增会话级小 sidecar `meta.json`（几十字节），承载 `revision` / `model` / `provider`；保存时不再解析 `session.json`。

```rust
// ~/.pure/sessions/<id>/meta.json
struct SessionMetaSidecar { revision: u64, model: String, provider: String }

fn session_meta_path(id: &str) -> PathBuf;
fn read_session_meta(id: &str) -> Option<SessionMetaSidecar>;   // 读失败/缺文件 → None
fn write_session_meta(id: &str, meta: &SessionMetaSidecar) -> Result<(), String>; // tmp + rename，不 fsync
```

`save_session_impl` 里三处替换：

```rust
// 旧：let existing_revision = load_stored_session_revision(&session_id).unwrap_or(0);
let stored = read_session_meta(&session_id);                    // 小文件，一次
let existing_revision = stored.as_ref().map(|m| m.revision)
    .unwrap_or_else(|| load_stored_session_revision(&session_id).unwrap_or(0)); // 旧档一次性回退

// 旧：let existing = load_stored_session_model_provider(&session_id);
let existing = stored
    .map(|m| (Some(m.model).filter(|s| !s.is_empty()), Some(m.provider).filter(|s| !s.is_empty())))
    .unwrap_or_else(|| load_stored_session_model_provider(&session_id));
```

写盘顺序：`session.json` 的 `tmp → sync_all → rename` **成功之后**再写 `meta.json`。这样即使 meta 写失败，下一次保存走旧解析回退，语义不变（旧档兼容矩阵见 §8）。

`load_session_impl` 不改（它本来就要解析整份）；`load_last_session` 同理。

**为什么 UX 不变**：决定性的数据（快照、revision 语义、model/provider 覆盖）都没变，只是把「读回来再解析」换成了「读一个几十字节的副本」。副作用是首次更新旧会话时会多写一个 `meta.json`（磁盘多 60 字节）。

**验收**（`cargo test --lib`）：
- 旧档（无 meta）保存一次 → 文件正确 + 生成 meta；再保存一次 → 不再触发旧解析（用 `#[cfg(test)]` 的读计数器断言 0 次）；
- revision 落后仍返回 `stale session revision`（现有测试应保持绿）。

**回退**：删掉 meta 读取分支即恢复旧路径；meta.json 是纯附加文件，回退后会被忽略。

### A4 附件随会话回收（`src-tauri/src/lib.rs:15752` 与 `delete_all_sessions`）

```rust
fn drop_session_attachments(session_id: &str) {
    let dir = attachments_dir().join(safe_session_component(session_id));
    let _ = fs::remove_dir_all(dir);   // best-effort，失败不影响删除语义
}
```
- `delete_session`：删完会话目录后调用一次；
- `delete_all_sessions`：清空后直接 `remove_dir_all(attachments_dir())`。

**为什么 UX 不变**：被删的会话不可能再打开，附件本来就没有第二个引用点（缩略图已经内联在快照里）。**注意**：只有 `path` 指向 `~/.pure/attachments/` 内的文件才随会话删除；用户原始文件绝不碰（`path_policy` 已有 workspace 约束，这里只删应用自己的目录）。

**验收**：Rust 单测「删除会话后 `<attachments>/<hex(id)>` 不存在，其它会话目录不受影响」。

### A5 活动轨不重挂（`src/ui/agentActivityPanel.ts:157`）

```ts
const wantOrder = ordered.map(a => a.callId);
const wanted = new Set(wantOrder);

// 第 1 趟：先把缺失的卡建出来（建卡逻辑照旧，仍只在新卡上加 --entering），
// 保证下面排序时 rows 已覆盖 wantOrder。
for (const activity of ordered) ensureRow(activity);

// 第 2 趟：只在顺序真的变了时才动结构
const orderChanged = wantOrder.length !== lastOrder.length
  || wantOrder.some((id, i) => id !== lastOrder[i]);
if (orderChanged) {
  // 最小移动：已是目标顺序的节点原地不动，只有错位的才 insertBefore
  let cursor: ChildNode | null = list.firstChild;
  for (const id of wantOrder) {
    const node = rows.get(id)!.row;
    if (node === cursor) cursor = cursor.nextSibling;
    else list.insertBefore(node, cursor);
  }
  // 本会话已不存在的卡（例如切了会话）一并清掉
  for (const [id, entry] of rows) if (!wanted.has(id)) { entry.row.remove(); rows.delete(id); }
  lastOrder = wantOrder;
}
// 顺序没变 → 完全不动结构，只走下面已有的「先比较再写」文本 patch
```

**为什么 UX 不变**：卡片顺序、内容、类名、entering 动画的触发条件全部保持现状；变化的只是「同样的结果用更少的 DOM 操作达到」。顺序没变时节点永不摘挂 → 呼吸/重试脉冲不再被打断（这本身是动效修复）。

**验收**：`src/ui/__tests__/agentActivityPanel.test.ts` 加一条：同一份 activities 连续 update 两次 → 第二次 `MutationObserver` 记录的子节点变更数为 0；顺序不变时卡片的 `animation-name` 不变。

---

## 3. P1：有行为边界的两项

### A3 `read_file` 首窗读取（`src-tauri/src/lib.rs:1331`）

现状：`fs::read` 整份（≤64MB）→ `extract_file_text`（PDF inflate / zip 解析）→ `lines().collect()` 全行索引 → 只返回 2k 行 / 32k 字符。

**改法**：先判「是否需要容器解析」，需要才整份读。

```rust
// 1) 用前 8KB 做 magic 判定（与 extract_file_text 同判据：PK\x03\x04 / %PDF / {\rtf / NUL 占比）
fn looks_container(head: &[u8], ext: &str) -> bool;

// 2) 纯文本：流式读，够 head_lines 或 32k 字符就停
fn read_text_head(full: &Path, head_lines: usize) -> io::Result<String> {
    let file = File::open(full)?;
    let mut reader = BufReader::new(file).take(HEAD_BUDGET_BYTES);   // 512KB 上限
    // 逐行累积：达到 min(head_lines, READ_FILE_HEAD_MAX_CHARS) 立即返回
    // 末尾若切在多字节边界，丢掉最后一个不完整字符（不产生 U+FFFD）
}

// 3) 显式 start_line/end_line：同样流式跳过 + 读到 end_line 停（不再整份读后切片）
```

- 容器格式（pdf/docx/xlsx/pptx/odt）：保留整份提取，但加提取预算 `MAX_EXTRACT_CHARS = 200_000`，超出即停并追加一句「已达提取上限，可用行范围或 search_files 继续」的脚注（当前是无声地全量提取后丢弃 99%）。
- `head_lines = None`（撤销快照、artifact 预览等内部调用）：**完全保持旧行为**整份读，不做任何改变。

**为什么 UX 不变**：模型拿到的仍是「前 2000 行 / 32k 字符 + 原有脚注」，行号语义、截断文案一字不改（`slice_read_file_text` 的既有单测继续锁住）。变的是「为了这 32k 我们读了多少磁盘、分配了多少内存」。

**验收**：
- 既有 `slice_read_file_text` 系列单测全绿（语义未变）；
- 新增：`read_text_head` 用一个 10MB 临时文件 + 计数 `Read` 实现，断言读取字节 ≤ 512KB；
- 新增：多字节边界截断（中文/emoji 跨窗口）不产生 `\u{FFFD}`。

**风险与回退**：编码判定（GB18030/Big5）在前 8KB 可能判错——Rust 侧复用现有 `decode_text_bytes`（`lib.rs:2949`，UTF-8 strict → GB18030 → Big5 → lossy）的降级链，只在「magic 不像容器」时启用首窗；判错最坏结果是回退到整份读（加一行 fallback），不会给错文本。

### B1 历史图片降级（新增 `src/shared/imageContext.ts`）

**改法**：在「组装请求」的最后一刻裁剪，不动磁盘、不动内存里的会话数据。

```ts
/** 只有最近 keepTurns 条「带图消息」保留原图 dataUrl；
 *  更早的降级为 thumbDataUrl；只剩图且无内容的旧消息补一句文本占位。 */
export function trimHistoricalImages(messages: Message[], keepTurns = 2): Message[];
```

接入点只有两处（映射入口，各一行）：
- `src/adapter/openai/mapping.ts`（`messages.map(...)` 之前）
- `src/adapter/deepseek/DeepSeekAnthropicAdapter.ts`（同一位置）

降级后的消息形态：`{ ...image, dataUrl: image.thumbDataUrl ?? '' }`；`dataUrl` 为空时该图不入请求，若整条消息因此为空则替换为 `“[较早的截图已折叠，原件仍在本机附件目录]”`。

**为什么 UX 不变**：转写气泡里的图本来就渲染缩略图（P0-4 已落地），用户看到的画面一个像素都不变；磁盘快照不变。变化的只有「发给模型的历史图清晰度」——模型仍能看到那张图（缩略图），只是不再每轮付 3.74MB。

**风险控制**：
- 开关放配置（例如 `config.context.historicalImages: 'trim' | 'full'`，默认 `trim`），出问题一个开关回退；
- 只对「已不是最后一轮」的图片生效，当前轮用户刚发的图永远原样发送；
- 新增一条肉眼可查的日志（`perfLog`）记录每轮裁剪掉多少字节，便于真机核对。

**验收**：新增 `src/shared/__tests__/imageContext.test.ts`：3 条带图消息 → 只有最后 2 条保留 `dataUrl`；`thumbDataUrl` 缺失时不崩、退化为省略；无图消息原样返回（引用相等，避免无谓拷贝）。

---

## 4. P2：收益明确但可以等

### B2 快照 IPC 直通（`lib.rs` 新增命令）

现状：`invoke` 在 JS 侧 stringify 一次 → Rust `serde_json::Value` 解析 → `to_string_pretty(整份)` 再序列化一次。

**改法**：新增 `save_session_json`，前端把快照**已经序列化好的字符串**直接传过来，Rust 只拼装、不重排：

```rust
#[tauri::command]
async fn save_session_json(
    session_id: String, snapshot_json: String, revision: u64,
    message_count: usize, title: String,
    workspace: Option<String>, model: Option<String>, provider: Option<String>,
) -> Result<usize, String>
```

- `debug_assertions` 下用 `serde_json::from_str::<serde_json::Value>(&snapshot_json)` 校验一次（发布版跳过）；
- 文件内容用字符串拼装：`{"message_count":..,"updated_at":..,"workspace":<json>,"model":..,"provider":..,"snapshot":<snapshot_json>}`，`workspace` 用 `serde_json::to_string(&workspace)` 转义，`snapshot_json` 本身是完整 JSON 值，直接拼接是安全的；
- 旧命令保留不动（CLI/测试仍在用），前端只换 GUI 这一处调用。

**为什么 UX 不变**：落盘字节与读回语义等价（有等价性测试锁住），只是少了一次 11MB 的重新序列化。

**验收**：Rust 单测「同一份 snapshot 分别走 `save_session` 与 `save_session_json`，`load_session` 读回后深度相等」；`store.test.ts` 断言保存后 `lastPersistedSnapshotBytes` 仍是真实字节数（P0-2 的闸门依赖它）。

### B3 `events.jsonl` 轮转（`lib.rs`）

```rust
#[tauri::command]
async fn compact_session_events(session_id: String, keep_bytes: Option<u64>) -> Result<u64, String>;
```
- 读尾 `keep_bytes`（默认 4MB）→ 从第一个整行开始 → 写 tmp → rename；
- 触发点：回合结束时（`chat.ts` 的 `finishTurn`）若本次回合追加超过 8MB，调用一次；不设定时器。

**为什么 UX 不变**：事件日志的消费侧本来就只读尾部、且跳过坏行；轮转只删掉「已经被快照折叠」的老行。

**验收**：Rust 单测「轮转后首行完整、末行完整、总大小 ≤ keep_bytes + 单行」。

### C1 katex 懒加载（`src/ui/markdown.ts:13`）

```ts
let katexModule: { renderToString: typeof import('katex').default.renderToString } | null = null;
async function ensureKatex(): Promise<void> { katexModule ??= (await import('katex')).default; }
```
- `renderMarkdown`（已是 async）在进入解析前：`if (/[\\$]/.test(text)) await ensureKatex();`
- 扩展内部把 `katex.renderToString` 换成 `katexModule!.renderToString`；
- 静态 CSS 保留（29KB，样式不能延迟，否则公式会闪版）。

**为什么 UX 不变**：没有公式的内容零变化；有公式时首次渲染多一次模块加载（本地包，几十 ms），且发生在这条消息第一次上屏时——与现在「整包预加载但公式仍要渲染」的用户感知一致。

**验收**：`markdown.test.ts` 公式用例在调用前 `await ensureKatex()`；新增断言「不含 `$` 的文本不触发 import（用 mock 计数）」。

### C3 图片固有尺寸（`types.ts` + `pasteChip.ts`）

- `MessageImage` 增加 `width?: number; height?: number`，缩略图生成时一并记录；
- 气泡/工具结果里的 `<img>` 写 `width`/`height` 或 `style.aspectRatio`，并加 `loading="lazy" decoding="async"`。

**为什么 UX 不变**：尺寸一致时不产生任何视觉差异，只是「先占位再加载」，消除恢复会话时的跳动（属改善）。

---

## 5. 明确不做（避免反复讨论）

| 想法 | 不做理由 |
|---|---|
| `index.json` 无变化时跳过写 | 收益 ~0.2ms/次（24KB），但 `updated_at` 每次都变，跳过会让侧栏排序停在旧值——行为风险大于收益 |
| 给转写行加 `content-visibility` / `contain` | `styles.css:1937/1979/2560` 记录了 WKWebView 下「滚回来变空白」的实测回归，红线 |
| 继续削 `backdrop-filter` | 常驻 chrome 已全部去掉；剩下 25 处都在浮层，屏上时间短，收益不可测 |
| 快照改增量/分片协议 | 收益上限最大，但要同时改 Rust 写、TS 读、恢复、导出、事件投影，属于独立立项，不在本轮 |
| 给活动轨做虚拟列表 | 卡片上限就是本轮派发的 agent 数（个位数），虚拟化只会引入滚动 bug |

---

## 6. 需要你点头的一项

**C2 超长文本闸门**：单条 >120k 字符的助手回复，现在整段 `marked` 解析（偶发一帧 100ms 级卡顿）。修法是「超阈值先渲染纯文本 + 一个『按 Markdown 渲染』按钮」。这是本轮唯一会改变用户可见界面的改动，默认**不做**；你点头我再排。

---

## 7. 验收与手工回归

自动化（每项合并前）：

```bash
bun run typecheck
bun test                      # 重点：store / markdown / agentActivityPanel / readFileHead / imageContext
cargo test --lib              # 247 个既有用例，新增项见各节验收
```

手工回归（改完 P0+P1 后跑一遍，用真实大数据）：

1. 打开 `session_1794109757707_1`（11.3MB，含 1 张截图）→ 连续发 3 轮 → 看 `session.json` 大小是否不再增长、保存是否不再有可感停顿；
2. 同会话滚动到顶再到底 → 无空白行、无跳动（这条同时验证 A5 与「不做 content-visibility」的结论）；
3. 4 路并发子 agent 任务 → 活动轨卡片顺序正确、呼吸动画不闪；
4. 打开一个 40MB 日志文件让模型 `read_file` → 工具卡出结果的时间应显著短于修改前，且返回内容与修改前逐字一致（用同一文件对比 diff）；
5. 旧会话（无 `meta.json`）保存一次后重开 → 工作区、模型、标题、消息数全部不变。

## 8. 旧档兼容矩阵（A1 引入的 sidecar）

| 磁盘状态 | 读取 | 保存 |
|---|---|---|
| 有 `session.json` + `meta.json`（新） | 直接读 meta，零放大 | 写 session → 写 meta |
| 有 `session.json`，无 `meta.json`（旧） | 走一次旧解析（现有逻辑），无副作用 | 旧解析 → 写 session → **补写** meta |
| 只有 `meta.json`（异常） | 视为无会话（`session.json` 不存在 → `Ok(None)`），与现在一致 | 正常新建 |
| `meta.json` 损坏 | 当作不存在，回退旧解析 | 覆盖为合法值 |

---

## 9. 一句话总结

**先做 P0 四项**（A2 身份哈希、A1 去读放大、A4 附件回收、A5 活动轨不重挂）——它们全部是「同样的结果、更少的字节搬运」，可以一次性合并、零 UX 变化；**再做 P1**（A3 大文件首窗、B1 历史图片降级），这两项才真正动到「工具延迟」和「每轮上传量」；**B2/B3/C1/C3 按需**；C2 需要你确认。

## 10. 落地记录（2026-11-13）

| 项 | 状态 | 落地位置 | 验证 |
|---|---|---|---|
| P0-1 A2 快照 id 复用 | ✅ 已合入 | `store.ts`（`transcriptFingerprint` / `priorTranscript` / `lastSavedTranscript`）、`chat.ts:9145` | `store.test.ts` 新增 3 条；全量 `bun test` 5371 通过 |
| P0-2 A1 去读放大 | ✅ 已合入 | `lib.rs` `SessionMetaSidecar` + `read/write_session_meta`，`save_session_impl` 改读 sidecar | 新增 Rust 单测（用「session.json 自称 revision 99」反证不再整份解析） |
| P0-3 A4 附件回收 | ✅ 已合入 | `cleanup_session_files` / `cleanup_all_session_files` | 新增 Rust 单测（只删本会话附件目录） |
| P0-4 A5 活动轨不重挂 | ✅ 已合入 | `agentActivityPanel.ts` 成员裁剪 + cursor 最小移动 | `agentActivityPanel.test.ts` 新增 3 条（含 MutationObserver 零变更断言） |
| P1-1 A3 首窗读取 | ✅ 已合入（**范围调整，见下**） | `read_file_impl` + `read_text_range_prefix` / `needs_full_extraction` / `strip_line_terminator` | 新增 3 条 Rust 单测（与全量切片逐字比对、深位窗口、容器/二进制拒绝） |
| P1-2 B1 历史图片降级 | ✅ 已合入 | 新 `src/shared/imageContext.ts`；`openai/mapping.ts`、`DeepSeekAnthropicAdapter.ts` 各一行接入；`config.trimHistoricalImages` 开关；`main.ts` 接线 | 新增 `imageContext.test.ts` 6 条 + `mapping.test.ts` 1 条线格式断言 |
| P2-1 B2 IPC 直通 | ⏳ 未做 | — | — |
| P2-2 B3 events 轮转 | ⏳ 未做 | — | — |
| P2-3 C1 katex 懒加载 | ⏳ 未做 | — | — |
| P2-4 C3 图片固有尺寸 | ⏳ 未做 | — | — |
| C2 超长文本闸门 | ⏸ 待确认（会改可见界面） | — | — |

### A3 的范围调整（为什么没按原文做 512KB 首窗）

原计划是「head 模式也只读 512KB 前缀」。落地时发现两个会让输出产生偏差的硬约束：

1. **脚注要报告整份文件的真实行数**（`以上是前 N 行，文件共 M 行`），而 M 是对 `text.trim()` 之后的行数——尾部的空白行被 trim 掉了，前缀读法算不出 M；
2. **编码判定与 trim 都是全局语义**：`decode_text_bytes`（UTF-8 strict → GB18030 → Big5）要看整份字节才能定编码，`text.trim()` 还会把首行前导空格吃掉——前缀与外挂解码在这些边界上可能与整份不一致。

因此落地改成三件**输出可证等价**的事：

- **显式行范围（start+end）流式读**：跳过前 `from` 行不解码不保留，读到 `to` 就停；碰到首行、文件尾、容器格式、二进制（含 NUL / PDF / zip / OLE）一律回退整份读取。实测 40MB 日志第 50 万行窗口：**1965ms → 69ms**，输出与旧路径逐字相同（debug 构建，release 会更快）。
- **head 模式不再把整份文本 collect 成 `Vec<&str>`**：4M 行日志原本额外吃 ~32MB，现在只保留要输出的那几行，行数与头部槽位一次扫描算完，输出逐字不变。
- **容器格式（pdf/docx/xlsx/pptx/odt）保持整份提取**：给它们加提取预算会改变返回文案，属于可见行为变化，等单独确认。

如果后续确实要压 head 模式的磁盘读，正确做法是先让脚注的「总行数」变成可选（或改成「至少 M 行」），把 trim/编码语义写进合同，再上流式解码——否则就是在用「偶尔少一行 / 错一个字符」换 IO。

### B1 默认开启的影响面

- 用户可见：**零变化**（气泡本来就渲染缩略图；快照与 `~/.pure/attachments/` 不动）。
- 模型可见：超过最近 2 条带图用户消息的截图变成缩略图。评测基线（`eval:baseline`）里涉及多图会话的样本可能需要重跑基线；需要旧行为时把 `trimHistoricalImages` 设为 `false` 即完全回退。
