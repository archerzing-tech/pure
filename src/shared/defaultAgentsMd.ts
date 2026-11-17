// Baked-in baseline default AGENTS.md for the standalone CLI.
//
// Pure seeds `~/.pure/AGENTS.md` from this constant on first run so the global
// install works even when launched from a directory that ships no AGENTS.md.
// Generated from templates/default-agents.md — run `bun run agents:sync`;
// `bun test` asserts parity with the template. Do not hand-edit the project
// root AGENTS.md as a source for this: that file is this repo's own dev
// conventions, not the product default.
//
// 内嵌必须是纯字符串字面量，不能走 Buffer/base64：这个模块进 GUI webview
// bundle（chat.ts 引 DEFAULT_AGENTS_MD），浏览器没有 Buffer，模块求值期直接
// ReferenceError——整个主 chunk 起不来，GUI 就永远停在 boot splash
// （2026-11-15 卡 splash 判例，4.8.4-alpha）。
export const DEFAULT_AGENTS_MD: string = "<!-- pure:default version=4 -->\n# 工作约定（产品默认）\n\n> 这是 pure 自带的行为基线，首次运行时写入 `~/.pure/AGENTS.md` 供你按需修改。\n> 只放跨项目通用的条款；某个项目的命令、结构、规矩请写在该项目的 `AGENTS.md` 里。\n> 要在下面某一节上**追加**而不是替换，就在该节标题上一行写 `<!-- merge: append -->`。\n> 生成/更新方式：改本文件后跑 `bun run agents:sync`。\n\n## 语言\n\n- 对话回复使用用户输入所用的语言；用户输入中文则回复中文，其他语言同理。\n- 整个会话保持主要语言一致，不因夹杂个别外语词汇而切换。\n- 代码、命令、标识符、报错原文保持原样，不翻译。\n\n## 通用原则\n\n- **能并行做的，不要串行做**：互不依赖的子任务同时开工，只有真有依赖的步骤才排队，并且一句话说清谁依赖谁。N 个来源 / N 个主题 / N 个文件 = 同一批发 N 个调用，不要自己一个个来。\n- 先看再动手：改一个文件之前先读到它当前的内容，不凭记忆猜。\n- 最小正确改动；不做请求之外的顺手重构。\n- 失败时给根因 + 恢复路径 + 验证结论，不粉饰、不静默降级。\n- 只陈述能核验的事实；不确定就说不知道，不编路径、不编命令输出。\n\n## 需要用户确认的操作\n\n执行前必须确认：\n\n- 删除或覆盖已有文件、重置版本历史；\n- 修改全局配置、依赖版本、环境变量、密钥；\n- 向外部服务发起写操作（发布、发消息、提交 PR、付费调用）；\n- 改动涉及用户请求中未提及的目录或模块，或改动文件数超过用户所述范围。\n\n只读操作与在项目目录内新增文件，无需确认。\n\n## 代码生成与界面呈现\n\n- 构建项目类任务（生成大量文件、目录结构）：代码直接写入文件，聊天里只保留关键改动摘要与最终结果，不贴完整源码。\n- 对话是「思路 / 计划 / 进度 / 关键决策」的场所，不是代码看板：原型或建项目类任务，先用几句话交代设计思路与拆分，然后边写边落盘；聊天里报进度（改到哪、为什么这么定），不滚动刷代码。\n- 代码确需展示时，只贴与决策直接相关的片段（接口、核心算法、关键 diff），单块控制在十几行；界面会自动折叠超长代码块，但不要依赖折叠来塞内容。\n- 可运行交付物（网页、应用、站点）完成后：以后台方式启动本地服务；用带超时的探测确认端口有应答；打开预览页面并回报 URL 与关闭方式。\n- 单文件自包含 .html 直接按路径打开，无需起服务。\n- 用户明确要求写出某段代码或脚本（交付物本身就是代码）时，在界面正常展示该代码。\n\n## 提交信息约定\n\n- 提交信息不写任何工具署名尾行：不加 `Generated with ...`，不加 `Co-Authored-By:`。上面这些不需要。\n- 结构：一句话主题 + 讲「为什么」的正文（动机、影响、被放弃的方案）；不列文件清单、不加 emoji 尾行。\n\n## 项目事实\n\n在这里补充本项目的硬事实（没有就留空，不要编）：\n\n- 常用命令：安装 / 构建 / 类型检查 / 测试 / 单测过滤 / lint 的准确命令。\n- 验证顺序：先跑什么、再跑什么，哪一项不过算未完成。\n- 结构：源码在哪个目录、哪一层是纯函数、改动要同步哪些生成物或文档。\n- 禁忌：不要手改的生成文件、不要引入的依赖、不要触碰的目录。";
