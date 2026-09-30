# 通道对接与自测指南

面向「把 pure agent 接进聊天工具」的操作者。架构与设计见
[`channel-gateway-design.md`](channel-gateway-design.md)，国内三家平台细节见
[`cn-im-channels.md`](cn-im-channels.md)，投影渲染见
[`channel-projection-design.md`](channel-projection-design.md)。

---

## 1. 前置条件

| 项 | 要求 |
|:---|:---|
| 运行时 | Bun（开发态 `bun run cli gateway`）或编译产物 `./pure gateway` |
| LLM | 先跑 `pure config` 配好 provider 与 API key（写入 `~/.pure/config.json`）；没配 key 时 gateway 启动会直接报错退出 |
| 文件 | 配置与状态都在 `~/.pure/` 下，无需环境变量 |

## 2. 最小配置（webchat，零凭据可测）

写入 `~/.pure/channels.json`：

```jsonc
{
  "enabled": true,
  "gateway": { "host": "127.0.0.1", "port": 18790 },
  "channels": {
    "webchat": {
      "enabled": true,
      "dmPolicy": "open"          // 本机自测用 open 免配对；对外建议删掉这行走默认 pairing
    }
  },
  "bindings": [
    // 让通道会话绑定到某个项目工作区（不配则 default.workspace=null = 只聊天不碰文件）
    { "match": { "channel": "webchat" }, "workspace": "/path/to/your/project", "permissionMode": "PLAN" }
  ]
}
```

启动：

```bash
./pure gateway            # 或开发态：bun run cli gateway
```

看到 `gateway running` 后浏览器打开 **http://127.0.0.1:18790**，输入框发消息即进入 agent
（首次回复可能等数秒：装配 harness、加载记忆）。发一句「帮我列出当前目录的文件」验证工作区链路。

> webchat 自带极简页面 + WebSocket，同一端口同时服务页面与 `/ws`。

## 3. 配对（默认安全门）

`dmPolicy` 缺省为 `pairing`：未配对的人发私信，bot 只回一条配对码，**不会进 agent**。

```bash
pure channels pending          # 查看待批准：显示 配对码 + 来源
pure channels approve <CODE>   # 在本地（能读到 ~/.pure 的人）批准
```

批准后再发消息即进入正常对话。已批准名单在 `~/.pure/channels/peers.json`（0600）。
群聊默认只在 **@机器人** 时响应（`groupPolicy.mentionRequired: true`）。

## 4. 接入飞书 / 钉钉

密钥不写进 channels.json：`*Ref` 指向 `~/.pure/secrets.json` 的同名槽位
（`{"feishu.appSecret": "xxx"}`），文件权限保持 0600。

```jsonc
{
  "channels": {
    "feishu": {
      "enabled": true,
      "accounts": { "main": { "appId": "cli_xxx", "appSecretRef": "feishu.appSecret" } }
    },
    "dingtalk": {
      "enabled": true,
      // robotCode 可省（优先从入站消息取；发图片需要它）；cardTemplateId 缺省时自动降级为只发最终结果
      "accounts": { "main": { "clientId": "ding_xxx", "clientSecretRef": "dingtalk.clientSecret" } }
    }
  }
}
```

| 通道 | 平台侧要做的事 | 公网要求 |
|:---|:---|:---|
| 飞书 | 开放平台建**自建应用**，开「长连接」事件订阅（`im.message.receive_v1`），给机器人 `im:message` 读写与 `im:image` 权限 | **无需公网 IP** |
| 钉钉 | 开放平台建**企业内部应用**，启用机器人 + Stream 模式 | **无需公网 IP** |
| webchat | 无 | 仅本机/内网 |

三家都是 WebSocket 长连接出站，gateway 不需要域名、证书与端口暴露。
改完配置重启 gateway 即生效（缺凭据只 warn 跳过该通道，不影响其它通道）。

## 5. 权限默认值（务必读一遍）

- 渠道来源默认 **PLAN（只读）**：agent 能看不能改。写操作/命令必须由 binding 显式升级
  `permissionMode: "NORMAL"`，且 NORMAL 下每次写都要走审批卡片/文字回复（超时 120s = 拒绝）。
- `toolProfile`: 默认 `readonly`，binding 里可升 `coding`。
- 通道会话默认**不写项目记忆**（`evolutionEnabled: false`）。
- 每 peer 限速 5 条/分钟、每日 50 万 token（`limits` 可调），超限只回提示不进 agent。

## 6. 富输出与投影（表现与桌面端一致）

- 回答含 ```ts / 表格 / ```mermaid / ```chart 等富块且通道能收图时：正文走原生 markdown，
  富块按**桌面端同一渲染管线**逐块截图成 PNG 投递（需本机有 Chrome，懒启动；`PURE_CHROME_PATH`
  可指定路径）。纯文本回答不启动浏览器。
- 没装 Chrome / 渲染失败 / 图超限：自动降级——源码并回正文，内容**永不丢**。
- webchat 页面直接内联显示图片附件；飞书/钉钉发图片消息。

## 7. 命令与文件速查

```bash
pure gateway                                # 启动（单实例：重复启动报 gateway.lock 冲突退出）
pure channels list                          # 查看生效配置与待配对数
pure channels test                          # 校验 channels.json
pure channels pending | approve <code>      # 配对审批
```

| 文件 | 用途 |
|:---|:---|
| `~/.pure/channels.json` | 主配置（校验失败整体拒绝加载，不做部分生效） |
| `~/.pure/secrets.json` | 密钥槽位（`*Ref` 指向这里） |
| `~/.pure/channels/pending-pairings.json` / `peers.json` | 待批准 / 已配对 |
| `~/.pure/channels/outbox.jsonl` | 出站队列（重启后重放，最终消息不丢） |
| `~/.pure/channels/audit.jsonl` | 审计（默认只记 hash/长度/元数据；`PURE_CHANNEL_AUDIT=full` 落原文） |
| `~/.pure/channels/sessions.json` | 会话索引（重启续聊） |

## 8. 常见问题

| 现象 | 原因与处置 |
|:---|:---|
| 启动报 lock 冲突 | 已有一个 gateway 在跑（飞书/钉钉长连接只允许单客户端，重复启动会静默丢消息，属有意拒绝） |
| 私信只回配对码 | 默认 pairing 门，走 §3 批准；或自测时给该通道设 `dmPolicy: "open"` |
| 群里 @ 了没反应 | binding/凭据没配好，或 botOpenId 拿不到时回退「有任何 @ 都响应」也失败；先看 gateway 日志的 `unpaired`/`not routed` 行 |
| 钉钉图片发不出 | 发图片需要 robotCode（入站消息自带或配置兜底）；`photoURL` 是否接受 media_id 待真机核对，若显示占位符需反馈 |
| 富块只贴了源码 | 本机没 Chrome 或块渲染失败（降级说明见 §6）；装 Chrome 或设 `PURE_CHROME_PATH` 后重试 |
| 配置改完没生效 | 校验失败会整体拒绝并在启动时打印行号级错误：`pure channels test` 看详情 |
