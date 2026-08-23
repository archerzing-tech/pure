# 长文本提交与临时文件附件设计

## 目标

当用户直接输入或粘贴的文本达到 350 个 Unicode code point 时，不把全文继续塞入模型 prompt，而是保存为当前会话的应用临时文件，并在输入区显示文本文件 chip。发送时 Agent 只收到文件路径引用，使用现有 `read_file` 工具按需读取内容；用户仍可点击 chip 查看完整文本。

## 数据流

```text
输入/粘贴文本
  → PasteChipManager.addLongText / consumePaste
  → ~/.pure/tmp/<session-id>/pasted-*.txt|md|json|csv
  → 输入区文件 chip
  → composeMessageWithAttachments()
  → 文件路径 + “请先 read_file”指令
  → Agent read_file
  → 工具结果进入模型上下文
```

## 阈值与回退

- 阈值：350 个 Unicode code point，而不是 UTF-16 code unit，避免中英文和 emoji 统计差异。
- Tauri Windows/macOS：调用 Rust `save_paste_file`，文件写入应用临时空间。
- 浏览器开发模式：没有应用文件空间时保留内存内容作为 fallback，并在 prompt 中显式标注；不能静默丢失文本。
- 文本附件引用文件路径时不再内联全文；只有没有路径的浏览器 fallback 才带有限制地内联内容。
- 文件名由应用生成并带随机后缀，避免同秒提交覆盖。

## UI 与会话

- 输入区沿用 `pasteChip.ts` 的文件 chip 和 viewer。
- 发送后输入区附件被清空，但会话持久化应保存附件元数据（name/path/kind/size/truncated），供 transcript 卡片和 session restore 使用。
- viewer 读取文件时限制最大展示字符数；临时文件过期或读取失败时显示明确错误，不阻塞后续对话。

## 生命周期

临时文件按 session 归档，并由后续 TTL/session 清理策略回收；正在被会话 transcript 引用的文件不能被立即删除。浏览器 fallback 的内存附件在发送/移除/会话切换时释放引用，避免长会话累积大字符串。

## 测试要求

- 阈值边界、Unicode 计数、唯一文件名。
- 发送 prompt 只含路径引用，不含已保存长文本。
- Tauri 保存成功/失败和浏览器 fallback。
- chip 查看、文件过期提示、session restore 元数据。
- Windows/macOS 路径与临时目录行为。
