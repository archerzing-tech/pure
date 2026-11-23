# 大屏任务真机 A/B：pure 为什么慢且做不出来（2026-11-23）

> 状态：观测记录，未含修复。基线 commit：before `bbecb3c`（我改动前）／after `b1f6588`（写入反馈与记账收口之后）。
> 对照物：freebuff（本机同一个 agent 会话）在完全相同的需求上的一次真实执行。
> 模型：火山引擎 `deepseek-v4-1-flash-261017`；同一台机器、同一份需求原文、同一个空工作区起点。

## 一、方法

- 需求：用户给的「大屏智能监控页面」原文（约 1.6k 字符，含瓦片源优先级、3D 转场、两侧面板）。
- 两臂各自 `git worktree` 出独立代码树，在各自空的 `/tmp/ab-*-ws` 里以**一次性模式**运行：
  `bun <代码树>/src/cli.ts "$(cat 需求.txt)" </dev/null`，硬上限 900s。
- 读数来源：CLI 自身日志（工具行 / turn 计时 / 结束原因）、工作区产物、`.pure-evo/trace.jsonl`。
- 局限先说：没有 token 计量（日志不落 usage）；freebuff 侧的墙钟没有插桩，只有工具调用与产物是可数的；只测 CLI one-shot，GUI 未测。

## 二、硬读数

| 指标 | before `bbecb3c` | after `b1f6588` | freebuff（同题） |
|---|---|---|---|
| 结束状态 | ❌ 400 | ❌ 400 | ✅ 交付可运行页面 |
| 引擎 turn 数 | 8 | 6 | 不适用（无此概念） |
| 总耗时 | 473,937 ms | 288,504 ms | 未插桩 |
| 工具调用数 | 17 | 15 | 12 |
| `write_file` | **0** | 1（8 字节的探针文本） | 8（页面/样式/数据/图表/地图/面板/流程/README） |
| `edit_file` / `str_replace` | 0 | 0 | 4 |
| 产出物 | 0 行业务代码，916K 探测图片与 vendor | 0 行业务代码，800K 探测图片 | 8 个文件，约 45k 字符 |
| 下载/网络探测 | 9 次 | 7 次 | 0 次 |
| 权限失败 | `execute_command` 2 次 | `execute_command` 2 次、delivery review 1 次 | 0 次 |

两臂的共同点比差异更重要：**把全部预算花在环境探测上，一行页面都没写**，最后被同一个 provider 400 打死；`after` 只是少了两次探测，快 40%，但交付物一样是零。

## 三、逐条问题（按对结果的影响排序）

### 1. 读一个「扩展名是图片、内容不是图片」的文件，会让整个请求 400，且归因错

这是两臂共同的死因，已定点复现：

```
$ file /tmp/ab-before-ws/probe/oss.png
/tmp/ab-before-ws/probe/oss.png: XML 1.0 document text, ASCII text   # 395 字节，OSS 错误响应

$ bun <repo>/src/cli.ts "用 read_file 读取 /tmp/img-probe/oss.png，然后只回复文件里是什么内容"
{"path": "/tmp/img-probe/oss.png"}  🔧 read_file: ✓ (3ms)
⏹ Repeated request failures ... Last: "400 The request failed because the image format is not supported by the API."
❌ 4923ms | turn 2
```

对照组：同一命令读一张正常的 256×256 PNG 瓦片 → `read_file ✓ (15ms)`、`✅ 7477ms | turn 2`，模型能正确描述图上的香港地图内容。
即：触发条件不是「读了图片」，而是「按扩展名当图片、却不校验文件签名」。`read_file` 先把坏字节当图片附进请求，下一次请求直接被端点拒绝；这一轮没有降级路径（不退回文本、不提示文件损坏），只有一个「1 次失败即停」的终局。

还有一层：失败案头写的是 `the provider rejected the API credentials (HTTP 401/403)`，而端点原文是 400 图片格式错误。**用户照这条提示去换 key 是白费**——归因把「请求体里有坏图片」讲成了「凭据无效」。

### 2. 非交互模式没有命令通道，agent 只能改用有副作用的探测手段

两臂的 `execute_command` 都是 0ms 失败：

```
🔧 execute_command: ✗ (0ms)
↳ Permission denied: Non-interactive: this operation requires TTY confirmation
```

agent 的应对是合理的：改用 `download_file` / `write_file` 验证网络与写权限，然后 `read_file` 检查下载物。但它恰好走进了第 1 条的地雷——**命令通道被封 → 探测退化为读下载文件 → 读到坏图片 → 400 终局**。这是一条完整的因果链，不是偶发。

### 3. delivery gate 在非交互模式必然判失败

两臂终局都有：

```
🧪 Delivery gate — review: active
! review: 代码审查因工具、网络、权限或验证环境限制未完成
  ↳ Permission denied: Non-interactive: this operation requires TTY confirmation
⛔ 项目暂不交付
```

即使产物写完了，`-p` 模式也没有任何批准路径（没有 auto-approve 的 review 通道）。一次性模式与交付闸的契约互相矛盾。

### 4. 默认行为是「先证明前提成立」，不是「先交付再验证前提」

before 的 17 次调用里：2 次 `execute_command`（0ms 失败）、1 次 `list_files`、9 次 `download_file`、3 次 `read_file`、1 次 `discover_tools`、1 次 `bash_executor`——全部是环境/网络/工具可用性探测，0 次产物写入。它在验证：瓦片源哪个能连、vendored 库能不能拉、`oss.png` 到底是什么、有没有浏览器截图能力、有没有 3D 场景技能。

freebuff 侧的同一任务：0 次网络探测、0 次能力探测，直接把「OSM China → OSS → France HOT → 自建」写成四级降级配置交出去，用代码满足「国内网络不可依赖」这条需求，而不是先证明哪一条通。

**这就是「为什么 pure 慢」的核心答案：它的慢不在生成，而在动手之前先花掉大半回合做可行性取证；而这些取证动作本身带副作用（下载、读图），会把任务从「慢」推向「失败」。**

### 5. 启动成本与工具面噪音

- `--help` 不被识别：会被当成空 prompt 进入 REPL；stdin 关闭后在 25s 观察窗内进程仍不退出（需信号结束）。
- 启动即连 MCP 并扫描述：`rea__inspect_analysis_view` 的工具描述 **14,631 字符**（策略上限 2000），`rea__inspect_web_network_capture` 2,042 字符，两者都只是 medium 告警、照常进工具表。工具总数 34 个，这笔描述开销每轮都付。

## 四、第二轮（修复后，同日）

修复项：`read_file` 改按文件签名判图（坏图片按文本读）、`classifyFailure` 的 401/403 只在独立 token 处算数、新增 image 失败类与对应止损文案、非交互模式把命令通道/交付闸不可用写进开工前的 envFacts、`PURE_USAGE_REPORT=1` 打印本回合聚合用量。

### 读数

| 指标 | pure（修复后） | freebuff（同题重跑） |
|---|---|---|
| 结束状态 | 900s 看门狗终止（未收尾） | 交付完成 |
| 总耗时 | ≥900s | 223s |
| 工具调用 | 128（browser 47 / edit_file 31 / read_file 18 / code_searcher 11 / write_file 9 / list_files 5 / code_editor 4 / execute_command 3） | 12 |
| 产出 | 7 个文件 148,227 字节 | 7 个文件约 43k 字节 |
| 400 图片失败 | **不再出现** | — |
| 命令通道探测 | 1 次（0ms 被拒后转静态推演） | 0 次 |
| 下载/网络探测 | 0 次 | 0 次 |

两处修复都验证过：坏图片现在回文本（模型读出 `NoSuchBucket` 并说明「这个 png 只有后缀」）；问「命令可用吗」时模型直接答「不可用：本次运行是非交互模式……所以命令一律被直接拒绝」，不再靠试错发现。

### 新一轮暴露的问题：并行 worker 与主线程共写同一文件

这次没有 400，它开始真的写页面，然后自述：

> 「剩下的四个文件里，`data/geo.js` 和 `map-engine.js` 共同组成地图层……因此我把前两个交给一个 worker，第三个交给另一个 worker；`app.js` 是编排层，由我写。」

随后：

> 「文件行数与我的写入量对不上：实际 1180 行，而我写的大约 700 行。那个负责地图的 worker 很可能后来也写了同一个文件，造成内容重复。」
> 「从 745 行往后，是地图 worker 写的另一半实现，与我写的 IIFE 拼接在了一起。它们基于不同的内部约定……完全不兼容。」

`js/map-engine.js` 因此变成两个版本拼接、语法报错的残片。它想用 `execute_command` + `node -e` 截断文件，命令通道拒绝（0ms），只能改用 `edit_file` 重写整份引擎，再重新跑浏览器验证——诊断与重写吃掉了大半个 15 分钟预算。这不是模型幻觉：文件本身确实是拼接产物。

**这是「为什么 pure 问题多」最直接的一条：并行写入没有文件级所有权，主线程与子 agent 可以同时写同一个文件，产物是拼接的，而模型必须先花回合把自己的伤诊断出来。**

### 用量

火山引擎这条线不返回 `usage`（`PURE_USAGE_REPORT=1` 打出 `provider reported none`），只能报估算：一句「只回复两个字：收到。」的转写估算 **11,969 token / 3 条消息**——即每轮固定重发约 1.2 万 token 的系统提示与工具 schema。两臂的上下文成本差别主要在这个固定项乘以轮数，不在产物本身。

## 五、这次 A/B 能证明什么、不能证明什么

能证明：
- 同一需求、同一模型下，pure 一次性模式在两臂都没能交付，且失败点是一个可稳定复现的输入类型问题（坏图片文件）。
- 耗时构成里，环境探测占绝对多数调用；`after` 相对 `before` 少了 2 次探测、快 40%，但没有改变「零交付」这个结果。
- 命令通道/交付闸在非交互模式下不可用，是有日志的直接证据。

不能证明：
- 不能把 473.9s 与 freebuff 的耗时直接相比（freebuff 侧未插桩）。
- 不能断言 GUI 模式下同样失败（未测；GUI 有 TTY 等价的确认路径与图片渲染）。
- 不能从这次运行推出 token 层面的成本结构（日志不落 usage）。

## 六、复现步骤

```bash
# 1) 起 before 代码树
git worktree add /tmp/pure-before bbecb3c
ln -sfn "$PWD/node_modules" /tmp/pure-before/node_modules

# 2) 两臂各在空目录跑同一份需求（900s 上限）
mkdir -p /tmp/ab-before-ws /tmp/ab-after-ws
(cd /tmp/ab-before-ws && bun /tmp/pure-before/src/cli.ts "$(cat /tmp/pure-ab-prompt.txt)" </dev/null > /tmp/ab-before.log 2>&1)
(cd /tmp/ab-after-ws  && bun "$PWD/src/cli.ts"              "$(cat /tmp/pure-ab-prompt.txt)" </dev/null > /tmp/ab-after.log  2>&1)

# 3) 最小复现（坏图片）
head -c 200 /tmp/ab-before-ws/probe/oss.png   # XML 错误页
bun "$PWD/src/cli.ts" "用 read_file 读取 /tmp/img-probe/oss.png，然后只回复文件里是什么内容"

# 4) 对照（正常图片）
bun "$PWD/src/cli.ts" "用 read_file 读取 /tmp/img-probe/tile.png，然后只回复你看到了什么"
```

留存：`--help` 观察日志在 `/tmp/pure-help.log`；两臂日志 `/tmp/ab-before.log` / `/tmp/ab-after.log`；定点复现 `/tmp/img-probe.log`（正常图）与 `/tmp/img-probe2.log`（坏图）。

## 七、修复方向（按决策边界归类）

- ✅ 读文件按**文件签名**判定图片（TS `sniffImageMime` / Rust `detect_image_mime`）；签名不匹配按文本读，不再把坏字节附进请求。
- ✅ 归因：401/403 只在独立 token 处算数（request id 里的 403 不再被当状态码）；新增 `image` 失败类，止损文案明确「不是 key、不是上下文长度」。
- ✅ 非交互模式开工前把命令通道与交付闸的不可用写进 envFacts；实测探测次数从「先失败再绕路」降到 1 次。
- ✅ **文件级写所有权**（`engine/FileWriteOwnership.ts`，接线在 `ToolExecutionCoordinator`）：记录每条路径的最后写入者与版本。同一执行者反复写零摩擦；换人写必须先 `read_file` 看过对方那一版，否则拒绝并说明；往别人文件后面 `append` 无论读没读都拒绝（那不是续写、是拼接）；读过再覆盖允许，但在结果里明说「你覆盖了谁的这一版」。身份由 `ctx.writeOwner/writeOwnerLabel` 提供，子代理取 `agentId` 与角色名，主线默认 `main`。局限：键是词法归一化路径，绝对/相对两种写法不会被认成同一个路径。
- ✅ 非交互模式的交付闸有了可执行的确认路径：闸发起的调用带 `hostAuthorized`（宿主手脚，跳过交互确认），打印一行「验证命令以本次运行的授权执行」；模型自己发起的命令照旧被非交互闸拒绝。落地后实测：`review` 降级完成、`audit` 通过、`verify` 通过、`✅ 项目允许交付`，14s 结束。
- ✅ 顺带修掉两条让闸「必然不交付」的前置缺陷：① 闸用的是回合开始前的 profile，本回合新建的 package.json 不在其中 → 闸前重新 `discoverWorkspace`；② `read_file` 默认带行号 gutter，`package.json` 被读成非 JSON、scripts 全空 → 清单读取统一传 `lineNumbers: false`；③ 非递归清单只列到 `test/` 目录时不再判「没有测试文件」。
- ⬜ 启动期工具描述超限的处理升级（14.6k 字符的描述不该只是 medium 告警）。
