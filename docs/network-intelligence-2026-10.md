# pure 网络智能层设计（Network Intelligence，2026-10-30）

用户定调:pure 是智能体,网络问题应**自主智能解决**——感知、找路、学习、自愈全是 pure 内部动作;
代理只是可选工具(该用才用,直连快就直连),代理配置错误要及时识别;
用户不应看到「正在等待首字返回」「这条路不通换条路再试」这类传输过程;
真失败要报真话:试过什么、为什么失败,不藏着掖着,也不把皮球踢回用户。

## 一、病根(三路调研结论)

### 1. LLM 链是串行试错架构
`chat_stream`(lib.rs:13642)主路失败→发 failover 事件→换反向路跑一次。
撞墙过程本身就是 failover/retrying 文案的来源。两条路各有独立 client 缓存
(`cached_llm_stream_client` 按 route key),竞速条件已具备但从未使用。
连接超时 10s:死代理(如 127.0.0.1:7897 无监听)虽 refused 快,但 TLS 慢/黑洞
场景每次都要白等 10s 才换路。

### 2. 网络智能碎片化,六套机制互不通气
| 机制 | 位置 | 私有规则 |
|---|---|---|
| netRoute 学习表 | shared/netRoute.ts | 成功钉 30min/失败 5min,按 host-class |
| netGuard 熔断 | shared/netGuard.ts | 主机 5min 熔断+镜像引导(仅 web 工具) |
| runRouted 换路 | TauriToolAdapter.ts:833 | 首选→反向→首选三步(仅 web_search/fetch/scrape) |
| GitHub 镜像链 | shared/githubAccel.ts | 5 镜像顺序尝试 |
| fetch 兜底链 | Rust fetchFallback | direct→Jina→Wayback→Firecrawl |
| 引擎竞速 | probe_html_backends | 免费 HTML 搜索引擎并行先到先得 |

健康状态不共享:netRoute 不知道 netGuard 熔断了谁,熔断不回写路由表;
LLM 与 web 两条消费者各用各的决策路径。学习信号只有 LLM 在记。

### 3. 呈现层把过程裸奔给用户
上屏的过程文案 7+ 种:「连接不太顺,正在重试(第 x/y 次)」「这条路不通,换条
线路再试」「线路还是不稳,又换了一条」「等待模型首字返回」「仍在等待模型返回
首个内容…」「已连上模型服务…」「连接探测失败…检查网络或代理后重试」。
浏览器从不播报 TCP 重传;真失败时文案又模糊(「网络连接失败,请检查网络」),
把皮球踢回用户。

## 二、设计:一个路由脑,两类消费者,三层

### L2 路由脑(netRoute.ts 升级,唯一决策点)
- **路径健康表**:destination(host-class:llm-api/web-search/github/镜像源…)×
  route(proxy/direct/镜像成员)→ `{ health: alive|slow|dead, latencyEMA, lastOkAt, deadUntil }`
- **学习信号统一**:LLM 的 served_route/headersMs(已有)、web 工具 runRouted
  结果、netGuard 失败/熔断,全部回写一张表
- **决策出口**:pickRoute(dest)→{primary, backup}。LLM 代理对、web 工具对、
  GitHub 镜像顺序、fetch 兜底顺序全部从表出,不再各自硬编码
- **代理健康探测**:代理 endpoint 是表里一行;启动时+定期(5min)+失败触发
  快探(1s 级)。死代理:全表 proxy 路降级直连,设置页如实标注「代理不可达
  (自 HH:MM)」,对话内不打扰
- 语义反转:**配置里有代理≠优先走代理**。HOST_CLASS_RULES 的 proxy-first
  改为「路由脑按实测健康度与时延决定」;用户可钉死 direct-first 偏好不变

### L1 数据面
- **LLM:预热+单发+快换**。不做请求级双发竞速(同一 prompt 两路同发=双倍
  输入 token 计费)。预热=后台维持两路 TCP+TLS 活性(零费用),请求按
  pickRoute 单发,失败换 backup 重发(现有 3 次重试语义保留)。学习表已知
  死路直接跳过,不再交 10s 连接超时学费
- **web 工具:私有兜底链保留语义,顺序交给路由脑**。runRouted 三步、
  GitHub 镜像链、fetch 兜底链的「顺序」从 pickRoute 出;免费引擎并行竞速
  (probe_html_backends)保留——那是零成本层,竞速正当
- 常量收敛:超时/重试参数收拢 Rust net 常量区,不再散落

### L3 呈现面(呈现纪律)
- **删(过程播报)**:failover 文案族、retrying 第 x/y 次、诊断探测的
  「检查网络或代理后重试」踢皮球尾缀。遥测(observations)保留,pure 内部
  照常记录
- **留(轻话术)**:等待卡呼吸点+「仍在等模型开口——通常是深度思考或服务
  排队,暂未发现连接问题;可随时停止」;升级线只说耗时与停止权
- **真失败(所有路试尽)**:一句人话+可展开明细,模板:「连不上 {目标}。
  已试:直连({真因})、代理({真因})。」真因取自探测结果
  (DNS 解析失败/连接被拒/超时/TLS/429 限流/5xx),不模糊化
- 代理坏:设置页状态标注+首启引导卡,不进对话打断
- netGuard 熔断保留(模型侧自愈,方向正确,用户不可见正是对的)

## 三、分期

- **期1 呈现收敛**(先行,纯 UI 层):删 retrying/failover 上屏(遥测保留)、
  等待 hint 轻话术化、诊断文案真话化。零架构变化,直接止血 —— ✅ 05eab2a v3.4.10
- **期2 路由脑统一**:健康表扩容+代理健康探测+设置页代理状态;
  netRoute→netBrain(向后兼容 localStorage key 迁移) —— ✅ 1b61d9d+cc6516c v3.5.0
  (netRoute 名保留,未改名 netBrain:改名的搬迁成本买不到行为增量)
- **期3 LLM 预热与快换**:Rust 预热池+学习表已知死路直跳 —— ✅ 0c804fa+75a71f9 v3.5.2。
  实施注:死路直跳期2 已落(健康行死期内 pair 翻路),本期的实际施工物=
  ①预热池(warm_llm_routes,30s 循环暖直连/代理两路,零 token,流式中跳过)
  ②「谁快用谁」(headers_ms EMA 双槽归路,快一倍以上且省 ≥500ms 才翻,
  运行期过期抢救双槽做最后一次裁定)。附带:空正文流超时改专属短阶梯
  (2 次即停,不再走 identical-call 5 级阶梯白等 10 分钟,c828c17)
- **期4 web 工具接入**:runRouted/镜像链/兜底链顺序改由路由脑出,错误文案
  统一真话模板。**第一刀:web_fetch/web_scrape 抓取后提炼层** —— ✅ 落地
  (2026-10-30 用户报「汇总任务全量大返回,处理耗时」——20k 字符原文直灌
  主上下文,每轮 THINK 重复 prefill 是耗时真身)。实施注:>8k 字符全文先经
  宿主一次 LLM 调用(disableThinking)压成 ≤2.5k 要点,原文不再进主上下文;
  要点按 URL+入参形态缓存 30min(cap 50,LRU),raw: true 旁路给精确原文,
  提炼失败/回调缺席回退原文(提炼是增强,不许弄丢抓取结果)。模型可见面
  只有 web_scrape(web_fetch 是隐藏兼容别名),raw 参数两个 schema 都带上。
  CLI 侧(NodeToolAdapter)无 LLM 通道,暂不接。同笔附带:聊天 markdown
  本机绝对路径图片经 asset protocol 渲染(assetProtocol 全盘 scope + CSP
  img-src 补 https:),修掉技能配图/本地截图不显示。

## 四、验收口径
- 正常网络:从「hello」到首字,全程零过程文案
- 死代理配置:请求照常成功(直连),设置页出现「代理不可达」标注,对话零打扰
- 真断网:一句真话+试过哪些路+每条真因;恢复后自动继续,不提旧账
- 浏览器能开的网页,web 工具的兜底链最终也能拿到(拿不到时报真因)
