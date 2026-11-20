// src/shared/powershellEncoding.ts
// PowerShell 5.1 会话级编码前导——execute_command 工具与用户 hook 共用的
// 唯一源（与 Rust powershell_command_wrapped 同刀，两侧文本必须一致，由
// NodeToolAdapter 的全串 toBe 测试与 Rust 行索引测试双面锁住）。
// 为什么在 spawn 处治而不是靠教：PS 5.1 的 Set-Content/Add-Content/Out-File
// 缺省按系统 ANSI 代码页落盘（zh-CN = GBK/cp936），模型写中文内容时字节
// 落盘即坏，事后补教学救不回已写坏的文件——这是物理默认值，归系统手脚管。
export const POWERSHELL_ENCODING_LINES: readonly string[] = [
  // Console 编码治 native exe 的 stdout/stdin ANSI 乱码；stdin/stdout 被重
  // 定向时设句柄可能抛「句柄无效」——catch 兜住，编码前导绝不能弄死命令本身。
  `try { [Console]::InputEncoding = [Text.UTF8Encoding]::new($false) } catch { }`,
  `try { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false) } catch { }`,
  // PS→native 管道的编码：中文经管道喂给外部程序时不按 ANSI 出。
  `$OutputEncoding = [Text.UTF8Encoding]::new($false)`,
  // 文件 cmdlet 缺省编码兜到 UTF-8。$PSDefaultParameterValues 只填缺省参数：
  // 命令里显式写了 -Encoding 的不受影响（显式意图永远赢）。PS 5.1 的 'utf8'
  // 带 BOM（5.1 没有 utf8NoBOM，保住中文优先于去 BOM）；pwsh 7 下同一句
  // 即无 BOM——两代宿主同句两面都对。
  `$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'`,
  `$PSDefaultParameterValues['Set-Content:Encoding'] = 'utf8'`,
  `$PSDefaultParameterValues['Add-Content:Encoding'] = 'utf8'`,
];
