# 国内 IM 通道专项：飞书 / 企业微信 / 钉钉

> 配套文档：`docs/channel-gateway-design.md`（总体架构、会话路由、安全模型、渲染降级）
> 本文只讲国内三家的**真实接入机制**与由此产生的设计修订。
> 状态：设计稿；**飞书与钉钉适配器已实现**（`src/adapter/channels/feishu/`、`src/adapter/channels/dingtalk/`，官方 SDK 动态 import，验收 `bun run verify:channel-feishu` / `verify:channel-dingtalk` 走 mock transport）。企业微信仍为设计稿，标注「待实测」的条目在实现前必须真机核对，不要照抄。

## 0. 结论摘要

**好消息：三家现在都提供「无公网 IP 的 WebSocket 长连接」模式**，这正是 pure 的本地优先 gateway 需要的前提
（不需要域名、证书、内网穿透、白名单）。飞书叫「长连接」、钉钉叫「Stream 模式」、企业微信叫「智能机器人长连接」。

**坏消息：三家都带来了四条硬约束**，它们会反向修改主设计（§4）：

1. **单连接语义**——飞书是集群模式不广播、企微新连接会踢掉旧连接 → gateway 必须持有进程互斥锁；
2. **首次回复有时限**（飞书 3 秒 / 企微 5 秒）→ 入站必须「先 ack 占位、后跑 agent」；
3. **流式是「全量替换」而不是增量**（企微 `stream.content`、飞书卡片 update 都是整块内容）→ renderer 要维护累积快照；
4. **各家都有频控**（飞书单卡片 10 次/秒、企微 30 条/分钟/会话）→ 进度更新必须**丢帧**，最终结果才走 outbox 可靠投递。

另：**审批卡片三家都支持**，但都必须配文字降级（回复 `y/n/编号`），因为卡片模板可能未发布、旧卡片回调不支持长连接、群里点不了按钮。

---

## 1. 接入机制对照表

| 维度 | 飞书 / Lark | 企业微信（智能机器人） | 钉钉 |
|:---|:---|:---|:---|
| 应用形态 | 企业自建应用 + 机器人能力 | 企业微信「智能机器人」 | 企业内部应用 + 机器人能力 |
| 入站方式 | **长连接**（`Lark.WSClient`） | **长连接**（官方 WS 协议） | **Stream 模式**（WebSocket） |
| 连接地址 | SDK 内部 | `wss://openws.work.weixin.qq.com` | SDK 内部 |
| 凭证 | App ID + App Secret | **BotID + Secret**（长连接专用） | Client ID (AppKey) + Client Secret |
| 公网需求 | 无 | 无 | 无 |
| 加解密 | 无（建连时鉴权，后续明文） | 无 | 无 |
| 连接数限制 | 每应用最多 50 个连接；**集群模式不广播** | **每机器人同一时刻只能 1 条**，新连接踢旧连接 | 单连接（多实例抢连同理） |
| 首次响应时限 | **3 秒**，超时触发重推 | **5 秒**，超时无法回复 | 回调需及时 ack（SDK 封装）；**具体时限待实测** |
| 事件/消息 ID | `event_id` / `message.message_id` | `msgid`（文档明示「用于事件排重」） | 回调 `msgId` |
| 入站消息类型 | 文本/图片/文件/富文本/语音 | text / image / mixed / voice / file / video（**媒体仅单聊**） | 文本/图片/文件/语音/视频/图文混排 |
| 群聊触发 | 支持（可配 @ 或全量） | 支持，但群聊仅 text/mixed | 支持，**默认仅 @ 回复**（`only_at_reply`） |
| 流式输出 | 卡片流式更新（cardkit），**单卡片 10 次/秒** | `stream` 消息，**全量替换**，10 分钟内必须 `finish` | AI 卡片流式组件（打字机效果） |
| 卡片按钮回调 | `card.action.trigger`，**长连接支持**（旧「消息卡片回传交互」不支持；⚠️ 实现发现疑点，见 §2.4） | `template_card_event` 事件 | 卡片回调，**Stream 支持** |
| markdown 渲染 | **纯文本消息不渲染 markdown，必须用卡片** | 有 markdown 消息类型 | 有 markdown 消息类型 + AI 卡片 |
| 媒体上行 | `im.image.create` / `im.file.create` | 上传临时素材 | 媒体上传下载（默认 10MB / 上限 100MB） |
| 媒体下行 | `im.file.get` + `writeFile` | url + **aeskey 需自行解密**（AES-256-CBC / PKCS#7 / IV=aeskey 前 16 字节，URL 5 分钟有效） | url + 对应字段 |
| 官方 Node SDK | `@larksuiteoapi/node-sdk` ≥1.24.0 | `aibot-node-sdk` | `dingtalk-stream` |
| 主动推送 | `im.message.create` | `aibot_send_msg`（回调后 24h 内可回复） | 机器人发消息 API + 卡片更新 |
| 频率限制 | patch 1000 次/分钟、50 次/秒；单卡片 10 次/秒 | 每会话 **30 条/分钟、1000 条/小时** | 待实测 |
| 权限项 | `im:message`、`im:message:send_as_bot`、`im:resource` 等 | 智能机器人「API 模式」开启 + 长连接凭证 | 企业内机器人发送消息、卡片实例创建与更新、媒体上传下载 |

---

## 2. 飞书 / Lark

### 2.1 接入步骤

1. 开发者后台创建**企业自建应用**，添加**机器人**能力；
2. 「事件与回调 → 事件订阅」添加 `im.message.receive_v1`，订阅方式选**「使用长连接接收事件」**；
3. 「回调订阅」添加 `card.action.trigger`（新卡片回传交互），同样选**长连接**；
4. 申请权限（收消息 / 以应用身份发消息 / 媒体上下行），创建版本并**发布**（未发布不生效）；
5. 本地运行 gateway 建连成功后，后台的长连接配置才能保存。

> **坑（配置顺序）**：飞书要求「先有长连接在跑，才能在后台保存长连接订阅方式」。
> 所以 `pure channels setup feishu` 的正确交互是：先把凭据写进配置 → 打印「现在去后台保存长连接」→ 让用户完成 →
> 再校验订阅是否生效。文档不写清楚会造成「保存按钮点不动」的经典卡壳。

### 2.2 协议要点

- 长连接由 SDK 提供（`new Lark.WSClient(cfg)` + `wsClient.start({ eventDispatcher })`）；**建连时鉴权，后续推明文**，
  无需处理解密与验签（对比 webhook 模式要 `encryptKey` + challenge 回显）。
- **长连接仅支持企业自建应用**（商店应用不行）；每应用最多 50 个连接。
- **必须 3 秒内处理完成，否则超时重推**；且推送是集群模式——多个客户端只有一个会收到消息。
  → 对我们的含义：① 入站处理必须是「记录 + 立刻 ack + 异步跑 agent」；② 靠重推兜底不能当可靠投递手段，
  必须自己去重（`event_id`）。

### 2.3 能力声明（映射到 `ChannelCapabilities`）

```ts
{
  chatTypes: ['dm', 'group'],
  media: { images: true, audio: true, video: true, files: true },
  streaming: 'card',        // 用卡片流式；纯文本降级时无 markdown 渲染
  markdown: 'full',         // 仅卡片内
  threads: false,           // 话题（thread）支持取决于场景，默认关
  reactions: false,         // 表情回复需额外事件，MVP 不做
  typing: false,            // 飞书无 typing 指示器 → 用「占位卡片"正在处理…"」代替
  editMessages: true,       // im.message.patch / 卡片更新
  buttons: true,            // card.action.trigger 长连接可收（⚠️ 待实测：SDK README 谓长连接不支持回调订阅）
  requiresMentionInGroup: true,
}
```

### 2.4 实现要点

- 出站：`im.message.create`（纯文本 / 卡片）、`im.message.patch`（更新已发消息）、cardkit 流式更新；
- 审批卡片：卡片里放按钮，回传 `card.action.trigger`。⚠️ **实现时发现的冲突**：官方 SDK README 明确写「长连接仅支持事件订阅，不支持回调订阅」，与本节「长连接可直接收卡片回调」冲突 —— 卡片按钮回调在长连接下是否可达待真机确认。适配器已按设计内置**双轨**（按钮 + 文字 `y/a/n`），所以即使回调不可达，审批仍可用；
- 长回答：卡片容量大，但仍有上限（**具体 JSON 大小上限待实测**）；超出走文件附件或分片；
- 若用户环境不方便建卡片，降级为纯文本 + 「回复 y/n/编号」确认。

---

## 3. 企业微信（智能机器人）

### 3.1 接入步骤

1. 企业微信客户端「工作台 → 智能机器人 → 创建 → 手动创建」；
2. 页面底部「API 模式创建」→ API 配置里连接方式选**「使用长连接」**；
3. 记录 **BotID** 与 **Secret**（Secret 只显示一次）；
4. API 模式二选一：选长连接后，原来的「接收消息回调地址」不再生效（互相踢）。

### 3.2 协议要点（本文三家里面最"裸"的一个）

- WS 地址 `wss://openws.work.weixin.qq.com`；
- 建连后先发订阅帧 `aibot_subscribe{ bot_id, secret }`，成功返回 `errcode: 0`；**订阅有频率保护，不要反复重发**；
- 心跳：`ping`，建议 30 秒一次；断线需指数退避重连；
- 入站：`aibot_msg_callback`（文本/图片/图文混排/语音/文件/视频）、`aibot_event_callback`
  （`enter_chat` / `template_card_event` / `feedback_event` / `disconnected_event`）；
- **每个机器人同一时刻只能一条有效长连接**，新连接订阅成功会踢掉旧连接，旧连接收到 `disconnected_event`
  → 高可用必须**主备**而不是多活；pure 侧用进程锁 + 明确的「已有实例在跑」错误提示；
- **5 秒内必须首次回复**（欢迎语同样是 5 秒内，仅 `enter_chat` 事件可用）；
- 出站命令：`aibot_respond_msg`（含 `stream` 类型）、`aibot_respond_welcome_msg`、
  `aibot_respond_update_msg`（更新模板卡片）、`aibot_send_msg`（主动推送）；
- 流式：**同一次回调的所有流式帧必须用同一个 `req_id`**，`stream.id` 标识一条气泡，**`stream.content` 是全量替换**，
  `finish: true` 结束；从建流起 **10 分钟内**必须 finish（实践建议 5 分钟内收尾、超时回退到 `aibot_send_msg` 异步推送）；
- 频率：每会话 30 条/分钟、1000 条/小时；收到回调后 24 小时内可回复；
- 媒体：`image`/`file`/`video` 结构体带 `aeskey`（**每个 URL 一个密钥**，区别于 webhook 模式统一的 EncodingAESKey），
  AES-256-CBC + PKCS#7 填充到 32 字节倍数、IV 取 aeskey 前 16 字节、下载 URL 5 分钟有效；
- 媒体**仅单聊**支持；群聊只收 text/mixed；
- `from.userid` 默认是加密 userid（除非机器人创建者是超管），需通过自建应用转换接口转明文。

### 3.3 能力声明

```ts
{
  chatTypes: ['dm', 'group'],
  media: { images: true, audio: true, video: true, files: true }, // 仅在 dm 下可用
  streaming: 'stream',      // 新取值：全量替换式流式消息（非 edit、非卡片）
  markdown: 'full',
  typing: false,            // 无 typing → 立即建流当占位
  editMessages: true,       // 通过 stream 续帧实现等价效果
  buttons: true,            // 模板卡片 + template_card_event
  requiresMentionInGroup: true,
}
```

### 3.4 实现要点

- **最紧的时限（5 秒）**：收到消息立刻用回调的 `req_id` 建流（发一条空/「正在处理…」的 stream），
  后续帧继续追加全量内容——占位即 ack。这条必须写死在 renderer 的通道适配里，不能靠 agent 尽快输出；
- 一段正文结束就 `finish: true` 并换新的 `stream.id`，避免一轮回复全挤在一条气泡里；
- 协议简单（JSON `cmd` 帧 + 30s 心跳），**可以零依赖自己实现**（Node/Bun 内置 WebSocket 即可），
  也可以用官方 `aibot-node-sdk`。建议先用官方 SDK 打通，再评估是否内联（减少依赖 vs 减少维护量）；
- 媒体解密要自己写（AES-256-CBC + PKCS#7），这是三家唯一需要写密码学代码的地方——建议放到
  `src/adapter/channels/wecom/mediaCrypto.ts` 并配单测（用固定向量校验）。

---

## 4. 钉钉

### 4.1 接入步骤

1. 开发者后台创建**企业内部应用**，记录 **Client ID (AppKey)** / **Client Secret (AppSecret)**；
2. 「应用能力」添加**机器人**，填写名称图标；
3. 机器人配置页把**消息接收模式设为 Stream**（无需 HTTP 回调地址）；
4. 申请权限：企业内机器人发送消息、**卡片实例的创建与更新**、媒体文件上传下载；
5. 发布应用版本（未发布则机器人不上线）；之后可私聊或拉群。

### 4.2 协议要点

- `dingtalk-stream` SDK 建立 WS 长连接，可监听三类推送：**机器人消息回调、事件订阅回调、卡片回调**；
- 无需公网回调地址，内网/本地直连；
- **群聊默认仅 @ 回复**（`only_at_reply: true`），私聊始终回复；
- 卡片：**可直接使用钉钉内置的公共 AI 卡片模板，接入时不需要配置任何卡片模板**（这是钉钉相对另外两家的最大便利）；
  想改样式才需要去卡片平台建模板，把 `approval_card_template_id` / `streaming_card_template_id` /
  `streaming_card_key` 填进配置。**模板忘发布 → 建卡失败，返回 `param.templateUnpublished`**；
- 审批卡按钮：回传在 `cardPrivateData.params.action` 里，取值约定
  `allow | approve | approved | accept | agree` = 批准，`deny | denied | reject` = 拒绝；
  用建卡时的 `outTrackId` 定位对应的工具调用，用回调里的会话信息定位聊天；
- 流式：AI 卡片流式组件（打字机效果），逐步更新同一张卡片；
- 媒体：`max_media_bytes` 默认 10MB、上限 100MB；扩展名受限（doc/docx/pdf/rar/xlsx/zip 等）；
- 单聊发不出去 → `chatbotId.notAllow.sendOTO`，说明机器人单聊能力未启用或应用版本未发布；
- **企业内部机器人无法枚举自己加入的全部群聊** → 主动推送必须由用户给出目标（`user:<staffId>` / `group:<openConversationId>`）。

### 4.3 能力声明

```ts
{
  chatTypes: ['dm', 'group'],
  media: { images: true, audio: true, video: true, files: true },
  streaming: 'card',        // AI 卡片流式
  markdown: 'full',
  typing: false,
  editMessages: true,       // 卡片实例更新
  buttons: true,            // Stream 模式可收卡片回调
  requiresMentionInGroup: true,   // 默认 only_at_reply
}
```

### 4.4 实现要点

- **接入成本最低**：内置卡片模板省掉「去卡片平台搭模板再填 ID」这一步（飞书/企微的卡片都需要先有模板或卡片 JSON）；
- 审批卡片的按钮协议不需要自己发明：照 `action` 取值约定实现即可，模板作者不用学新字段；
- 群聊里 @ 触发是默认行为，与 pure 的安全默认值「群里不主动响应」天然一致；
- 主动推送能力（发到当前会话之外）需要权限与目标枚举限制，MVP 不做，留给后续的「定时任务通知」场景；
- **出站图片**：`sessionWebhook` 只支持文本/Markdown/卡片，图片必须走机器人 OpenAPI —— 上传媒体拿 `media_id` 后按会话形态分发（单聊 `oToMessages/batchSend` 用消息里的 `senderStaffId`，群聊 `groupMessages/send` 用 `openConversationId`），因此 transport 会记住每个会话的元信息（待真机核对项见 §7）。

---

## 5. 三家对主设计的修订

### 5.1 必须新增：单连接进程锁

三家都是「一个应用一条连接」语义，且多客户端时行为不同但都不安全（飞书随机一个收到、企微踢连接）。
**gateway 启动时必须抢占 `~/.pure/channels/gateway.lock`**（写入 pid + 启动时间，启动时检查存活），
第二个实例直接报错退出：

```
pure gateway: 已有实例在运行（pid 12345，已连接 telegram, feishu）。
多实例会导致消息随机丢失或被平台踢下线，已拒绝启动。
```

这条不做，用户很容易在「忘了已经开着一个」的情况下静默丢消息，且**极难排查**。

### 5.2 必须新增：先 ack 占位、后跑 agent

飞书 3 秒 / 企微 5 秒的首次回复时限，决定了 renderer 的**首帧策略**：

```
收到入站事件（<1s）
  → 立刻发占位（企微：建 stream；飞书/钉钉：发「正在处理…」卡片或打字中状态）
  → 同时启动去重检查与 binding 解析
  → agent 开始跑，占位被后续流式帧/卡片更新覆盖
```

推论：**gateway 启动时就应该把已配置 workspace 的 Harness 预装配好**（记忆 embedder、MCP 连接、技能扫描都不在首条消息的关键路径上）；
冷启动的第一条消息如果超过 3–5 秒，只能先发一个泛化的占位文案，不能让用户看着空白。

### 5.3 必须修订：`streaming` 取值加 `'stream'`

主设计写的是 `'none' | 'edit' | 'card'`。企微的 `stream` 消息既不是 edit 也不是卡片，而是
**全量替换式流式消息**（`stream.id` 关联、`content` 全量、`finish` 结束）。新增取值：

```ts
streaming: 'none' | 'edit' | 'card' | 'stream';
```

并且**三家在渲染语义上都是「全量替换」**：renderer 内部维护「累积文本快照 + 上次已发送内容 + 节流时间戳」，
每次把快照整体写入，而不是把 delta 追加过去。这与 GUI 的增量渲染是两套模型，必须在 renderer 里统一，
不能把 GUI 的 delta 逻辑直接搬过来。

### 5.4 必须修订：进度更新「丢帧」，最终结果「可靠投递」

频控（飞书单卡片 10 次/秒、企微 30 条/分钟/会话）意味着：
- **进度/流式帧**：只保留最新快照，到点才发一次（默认 1 次/秒，可配），中间帧直接丢弃——队列会积压并触发限流；
- **最终结果 / 审批请求 / 错误**：写 outbox，失败重试 + 重启重放，**不可丢**。

即 renderer 里是「可丢的合并通道」，outbox 是「不可丢的投递队列」，两者不能混用同一条队列。

### 5.5 必须新增：卡片 + 文字双轨审批

三家的卡片按钮回调都能走长连接，但都有失效场景（钉钉模板未发布、飞书旧卡片不支持长连接回调、
群里按钮点不动、用户终端不支持交互）。所以审批必须**双轨**：

- 有 `buttons: true` → 发审批卡片（标题=哪个会话、工具名、参数摘要、批准/拒绝按钮）；
- 同时**永远**在卡片正文里给出文字指令：`回复 y 批准 / n 拒绝 / a 本次会话总是允许`；
- 卡片下发失败（如 `param.templateUnpublished`）→ 自动降级为纯文字审批，并在日志里说明原因。

这条与纯 CLI 的 `y / a / n` 语义对齐，用户三种表面（GUI 弹窗 / CLI 终端 / IM 卡片文字）学一次就够。

### 5.6 会话路由的补充：群聊触发词

三家群聊默认行为不完全一致（钉钉默认仅 @；飞书/企微可配）。统一到 binding 的
`mentionRequired: true`（默认），**并且**群聊里永远先做一次「是否 @ 我」判定再决定要不要进 agent——
这既是体验问题，也是成本与安全边界（群里陌生人随便说话不该烧 token）。

---

## 6. 依赖与实现选型建议

| 通道 | 推荐实现 | 理由 | 备选 |
|:---|:---|:---|:---|
| 飞书 | `@larksuiteoapi/node-sdk`（WSClient + EventDispatcher + cardkit） | 鉴权、重连、事件分发、卡片流式全封装；飞书协议细节多，自己实现不划算 | 裸 WS（不建议） |
| 钉钉 | `dingtalk-stream` | 官方 SDK，Stream 帧协议与 ack 由它处理 | 裸 WS（协议未公开完整，不建议） |
| 企业微信 | 官方 `aibot-node-sdk` 先行；稳定后评估内联 | 协议简单（JSON `cmd` 帧 + 30s 心跳），有内联价值；但**媒体 AES 解密要自己写** | 裸 WS（可行，但需覆盖重连/踢连接/心跳） |

新增依赖一律需要理由（仓库约定）：**这三个 SDK 只在 gateway 进程里加载**，
不进入 CLI/GUI 的其他路径（动态 import，`pure channels` 未启用时零成本）。

---

## 7. 待实测核对清单（实现前必须逐条验证）

不要凭本文数字写死代码，以下条目需真机核对：

- [ ] 飞书：长连接下 `im.message.receive_v1` 重推的**实际间隔与去重键**（`event_id` 是否稳定）；卡片 JSON 大小上限。
- [ ] 飞书：`card.action.trigger` 走长连接时，卡片按钮回调是否**真的送达**（SDK README 称长连接不支持回调订阅，与设计相反）、以及按钮回调的**响应时限**（与事件一样是 3 秒？）。
- [ ] 飞书：`im.message.receive_v1` 的 `mentions[]` 如何识别「@ 的是本机器人」—— 当前实现需 `botOpenId`（配置项），拿不到时回退「有任何 @ 就算」，会造成被 @ 别人时也响应。
- [ ] 钉钉：机器人回调的**首次响应时限**；`sessionWebhook` 的时效与在 Stream 模式下的可用性；markdown 消息与卡片的长度上限。
- [ ] 钉钉：群聊 `only_at_reply` 关闭后的行为；卡片内置模板的具体变量名（与自建模板的差异）。
- [ ] 企微：`stream` 建流后未 `finish` 的**实际**超时行为（文档 10 分钟 vs 实践 6 分钟/5 分钟安全线）；
      一分钟 30 条上限是「计数帧」还是「计数气泡」（决定节流值）。
- [ ] 企微：图片/文件在**群聊**下是否真的完全不可用；加密 userid 转明文的接口与所需权限。
- [ ] 三家：媒体下载 URL 的有效期差异（企微 5 分钟已确认）与并发下载限制。
- [ ] 三家：`typing` 均不可用，确认「占位消息」策略在客户端上的观感（是否有更好的原生状态位）。
- [x] 飞书 / 钉钉：**出站图片附件上传**已接入 —— 飞书走 `im.image.create` 拿 `image_key` 再发 `msg_type: image`；钉钉走 `media/upload` 拿 `media_id`，再用机器人 OpenAPI 发 `sampleImageMsg`（单聊 `oToMessages/batchSend`，群聊 `groupMessages/send`）。适配器的 `canDeliverImages` 由 transport 是否实现 `sendImage` 决定，富块按「通道投影优先，`richOutput` 单块光栅化（```chart / ```svg）兜底」把 PNG 真投递；没有 `sendImage` 的 transport（如单测替身）仍诚实降级为文本。
  **待真机核对**：钉钉图片发送需 `robotCode`（入站消息体自带，配置项 `robotCode` 兜底）；`sampleImageMsg.photoURL` 是否接受 `media_id` 以真机为准 —— 社区有「填 `media_id` 只显示占位符、必须公网 URL」的报告，若属实则需自行托管 PNG 或改用卡片内嵌图。
- [ ] 三家：`mermaid` / `puml` 的出图依赖**目标机器上有 Chrome**（懒启动 + 裸 CDP，不下载 Chromium）；没有则降级为文本。macOS 已验证（`bun run verify:channel-diagrams`），Windows / Linux 的 Chrome 路径探测（`src/channels/rasterize/headlessChrome.ts` 候选列表 + `PURE_CHROME_PATH`）待实机核对。
- [ ] 三家：**通道投影**（`src/channels/projection/`，设计见 `docs/channel-projection-design.md`）与 mermaid/puml 共用同一 Chrome 依赖（懒启动、串行队列、空闲关闭）；有富块+能发图+有 Chrome 时正文走原生 markdown、富块按桌面端同管线逐块截图投递，无 Chrome 或纯文本回答自动降级，失败块源码并回正文不丢内容。macOS 已验证（`bun run verify:channel-projection`），Windows / Linux Chrome 路径待实机核对。
- [ ] 钉钉：AI 卡片流式需要卡片实例 OpenAPI + 卡片模板 id；当前 `cardTemplateId` 未配置时自动降级为「只发最终结果」，按钮也降级为文字双轨。

---

## 8. 落地顺序建议

**推荐：飞书 → 钉钉 → 企业微信**（按「体验 → 省事 → 省依赖」权重）

| 顺序 | 通道 | 首发理由 | 主要代价 |
|:---|:---|:---|:---|
| 1 | **飞书** | SDK 最成熟（鉴权/重连/事件分发/卡片流式一体）；卡片流式 + 按钮回调一套齐全；企业客户覆盖广；3 秒时限虽紧但与占位策略配合良好 | 卡片 JSON 需自己拼；有「先建连才能保存订阅方式」的配置顺序坑 |
| 2 | **钉钉** | **内置公共卡片模板**，零卡片配置，接入最快；Stream SDK 官方成熟 | 群聊默认仅 @；主动推送受群枚举限制 |
| 3 | **企业微信** | 5 秒时限最紧（占位策略最关键）；媒体需自行 AES 解密；每机器人单连接（需主备） | 协议要自己维护帧/心跳；加密 userid 转换 |

**若目标是「最快端到端跑通」**：钉钉更省事（内置卡片模板），可作为 Phase 1 的先行验证通道；
**若目标是「企业场景第一个可用」**：飞书。

三家共用同一份 `ChannelAdapter` 接口与 renderer，因此**顺序不影响架构**，只影响先写哪个适配器——
这也是本设计把能力声明与渲染降级做成数据表的直接收益：第二个通道的边际成本 ≈ 一个适配器文件 + 一份凭证配置。

---

## 9. 对主文档的具体修改项（**已应用**）

下表记录本文结论落到 `docs/channel-gateway-design.md` 的改动，均已同步，两份文档保持一致：

| 主文档位置 | 修改 |
|:---|:---|
| §4.2 `ChannelCapabilities.streaming` | 增加 `'stream'` 取值（企微） |
| §4.2 `ChannelCapabilities` | 增加 `requiresMentionInGroup`（三家群聊都有 @ 语义） |
| §5.2 AgentSession | 增加「gateway 启动时预装配已配置 workspace 的 Harness」（3–5 秒首响时限的直接推论） |
| §6.3 审批回路 | 改为「卡片 + 文字双轨」，明确卡片失败时的降级与日志 |
| §7 渲染矩阵 | 明确「全量替换」语义；增加「进度帧可丢 / 结果帧不可丢」的双队列区分 |
| §8 通道选型 | 本文替代该表的国内部分；个人微信维持「默认关闭」结论 |
| §9 配置 | `channels.json` 增加 `streaming.throttleMs` / `streaming.ackPlaceholder` / `streaming.cardFallbackToText` / `groupPolicy.mentionRequired` |
| §10 路线图 | Phase 2 的内容按 §8 顺序细化；gateway 进程锁提到 Phase 0（它是正确性问题，不是优化） |
