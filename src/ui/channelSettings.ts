// src/ui/channelSettings.ts
// 设置 → 频道页的频道卡片（手风琴式）：飞书 / 钉钉 / QQ / WebChat 的接入配置。
// 单一事实源是 ~/.pure/channels.json（gateway 读的就是它），本页用 Tauri 的
// read_file/write_file 直接编辑该文件；密钥不进 localStorage/channels.json，
// 走 Rust secret_set/secret_get 落在 ~/.pure/secrets.json（0600）——
// 与 CLI/gateway 的 appSecretRef/clientSecretRef 约定同源，零翻译层。
//
// 一键开通（2026-11-07）：凭据表单收敛成一个粘贴框——用户从平台控制台整段
// 复制（两行/JSON/裸值都认，解析与 CLI configure_channel 共享同一纯函数），
// 提交前先经 Rust channel_verify 向平台 token 端点真实探活（WebView 直 fetch
// 平台会被 CORS 拦，探测必须住 Rust；同款判例见 gatewaySettings 的 runTest）。
// 探活不过一个字节都不落盘；通过了才写盘，gateway 侧的 watch 在几秒内热载，
// 不再需要「改完配置手动重启网关」。展开体还带本通道的待批准配对列表——
// 批准直接改盘上 pending/peers 文件，PairingGate 按 mtime 跨进程增量重读，
// gateway 无需重启即生效（零命令行）。
import { isTauriRuntime, loadTauriCore } from '../shared/tauri';
import { homeDir, join } from '@tauri-apps/api/path';
import { parseCredentialPaste } from '../shared/channelCredentials';
import { t } from '../shared/i18n';

export interface ChannelAccountDraft {
  appId: string;
  appSecret: string;
  clientId: string;
  clientSecret: string;
  robotCode: string;
  cardTemplateId: string;
}

type Draft = Partial<ChannelAccountDraft>;

interface ChannelSpec {
  id: 'feishu' | 'dingtalk' | 'qq' | 'webchat';
  name: string;
  icon: string;
  fields: { key: keyof ChannelAccountDraft; label: string; placeholder: string; secret?: boolean }[];
  guide: string[];
  status: 'implemented' | 'planned';
  /** 一键开通形态的元数据（fields 为空的通道必带）。 */
  onboarding?: {
    /** 平台控制台里这对凭据的名字（教用户去哪里复制）。 */
    fieldsLabel: string;
    /** 开通后用户下一步做什么（首次私信配对）。 */
    nextStep: string;
    /** 平台控制台直达链接——「去哪拿凭据」的快捷按钮指到这。 */
    consoleUrl: string;
  };
}

const SECRETS_KEY: Partial<Record<ChannelSpec['id'], string>> = {
  feishu: 'feishu.appSecret',
  dingtalk: 'dingtalk.clientSecret',
  qq: 'qq.appSecret',
};

const SPECS: ChannelSpec[] = [
  {
    id: 'feishu',
    name: '飞书 / Lark',
    icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h6l10 10v6h-6L4 10z"/></svg>',
    fields: [],
    guide: [
      '开放平台 → 创建企业自建应用 → 添加「机器人」能力',
      '事件与回调 → 订阅方式选「长连接」→ 添加事件 im.message.receive_v1',
      '权限管理：开通 im:message、im:message:send_as_bot、im:resource（图片）',
      '版本管理 → 创建版本并发布（未发布事件不会推送）',
    ],
    status: 'implemented',
    onboarding: {
      fieldsLabel: 'App ID + App Secret',
      nextStep: '在飞书里给机器人发条消息，首次会收到配对码——在下方批准即可开始对话',
      consoleUrl: 'https://open.feishu.cn/app',
    },
  },
  {
    id: 'dingtalk',
    name: '钉钉',
    icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M8 12h8M12 8v8"/></svg>',
    fields: [
      { key: 'robotCode', label: 'Robot Code（可选，发图片需要）', placeholder: 'ding_xxx' },
      { key: 'cardTemplateId', label: '卡片模板 ID（可选，缺省只发最终结果）', placeholder: '' },
    ],
    guide: [
      '开放平台 → 创建企业内部应用 → 开启「机器人」',
      'Stream 模式推送（无需公网 IP）',
    ],
    status: 'implemented',
    onboarding: {
      fieldsLabel: 'Client ID (AppKey) + Client Secret (AppSecret)',
      nextStep: '在钉钉里给机器人发条消息，首次会收到配对码——在下方批准即可开始对话',
      consoleUrl: 'https://open-dev.dingtalk.com/',
    },
  },
  {
    id: 'qq',
    name: 'QQ',
    icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M9 10h.01M15 10h.01M8.5 14.5a5 5 0 0 0 7 0"/></svg>',
    fields: [],
    guide: [
      'QQ 开放平台 → 创建机器人 → 复制 AppID / AppSecret（整段复制即可）',
      ' websocket 长连接接入（无需公网 IP），群聊默认仅 @ 触发',
      '沙箱环境先试单聊（C2C），群消息需上线审核后全量可用',
    ],
    status: 'implemented',
    onboarding: {
      fieldsLabel: 'AppID + AppSecret',
      nextStep: '在 QQ 里加机器人为好友并发条消息，首次会收到配对码——在下方批准即可开始对话',
      consoleUrl: 'https://q.qq.com/',
    },
  },
  {
    id: 'webchat',
    name: 'WebChat',
    icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 9h12M6 13h8"/></svg>',
    fields: [],
    guide: ['自带页面 + WebSocket，零凭据；gateway 启动即开'],
    status: 'implemented',
  },
];

interface ChannelsFile {
  enabled?: boolean;
  gateway?: { host?: string; port?: number };
  channels?: Record<string, { enabled?: boolean; dmPolicy?: string; accounts?: Record<string, Record<string, unknown>> }>;
  bindings?: unknown[];
  [k: string]: unknown;
}

async function readChannelsFile(): Promise<ChannelsFile> {
  if (!isTauriRuntime()) return {};
  const core = await loadTauriCore();
  if (!core) return {};
  try {
    const pureHome = await pureHomeDir();
    const raw = await core.invoke<string>('read_file', { workspace: pureHome, path: 'channels.json' });
    return JSON.parse(raw) as ChannelsFile;
  } catch {
    return {};
  }
}

async function writeChannelsFile(cfg: ChannelsFile): Promise<void> {
  if (!isTauriRuntime()) throw new Error('write_file requires the Tauri runtime');
  const core = await loadTauriCore();
  if (!core) throw new Error('write_file requires the Tauri runtime');
  const pureHome = await pureHomeDir();
  await core.invoke('write_file', { workspace: pureHome, path: 'channels.json', content: JSON.stringify(cfg, null, 2) + '\n' });
}

async function pureHomeDir(): Promise<string> {
  return join(await homeDir(), '.pure');
}

async function secretGet(key: string): Promise<string> {
  const core = await loadTauriCore();
  if (!core || !isTauriRuntime()) return '';
  try {
    const v = await core.invoke<string | null>('secret_get', { key });
    return v ?? '';
  } catch {
    return '';
  }
}

async function secretSet(key: string, value: string): Promise<void> {
  const core = await loadTauriCore();
  if (!core || !isTauriRuntime()) throw new Error('secret_set requires the Tauri runtime');
  await core.invoke('secret_set', { key, value });
}

export function renderChannelSettings(host: HTMLElement, onChange: () => void): void {
  void onChange;
  host.replaceChildren();

  const wrap = document.createElement('div');
  wrap.className = 'channel-cards';
  host.appendChild(wrap);

  // 手风琴状态：同时只展开一张卡（undefined = 全收起）。
  let expandedId: string | undefined;

  async function renderAll(): Promise<void> {
    const cfg = await readChannelsFile();
    cfg.channels = cfg.channels ?? {};
    wrap.replaceChildren();
    for (const spec of SPECS) {
      wrap.appendChild(await buildCard(spec, cfg, () => {
        expandedId = undefined;
        void renderAll();
      }));
    }
  }

  async function buildCard(spec: ChannelSpec, cfg: ChannelsFile, onDone: () => void): Promise<HTMLElement> {
    const entry = cfg.channels![spec.id] ?? {};
    const account = Object.values(entry.accounts ?? {})[0] ?? {};
    const secretKey = SECRETS_KEY[spec.id];
    const enabled = entry.enabled === true;
    const expanded = expandedId === spec.id;

    const card = document.createElement('div');
    card.className = `channel-card${expanded ? ' channel-card-open' : ''}${spec.status === 'planned' ? ' channel-card-planned' : ''}`;

    // ── 头部（始终可见）：图标 + 名称 + 徽标 + 开关 + 展开箭头 ──
    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'channel-card-head';
    head.setAttribute('aria-expanded', String(expanded));

    const icon = document.createElement('span');
    icon.className = 'channel-card-icon';
    icon.innerHTML = spec.icon;
    const name = document.createElement('span');
    name.className = 'channel-card-name';
    name.textContent = spec.name;

    const badge = document.createElement('span');
    badge.className = `channel-badge ${enabled ? 'channel-badge-on' : 'channel-badge-off'}`;
    badge.textContent = spec.status === 'planned'
      ? t('channel.planned')
      : enabled ? t('channel.badgeOn') : t('channel.badgeOff');
    if (spec.status !== 'planned' && secretKey) {
      void secretGet(secretKey).then((v) => {
        // 已启用 + 密钥在位 = 开通完成态（一键开通只产生这种组合——凭据
        // 探活通过才落盘）。仅「凭据已设」的旧态保持原样不动。
        if (enabled && v) {
          badge.textContent = t('channel.badgeActive');
        } else if (v && !badge.textContent?.includes('·')) {
          badge.textContent += ` · ${t('channel.badgeSecretSet')}`;
        }
      });
    }

    const chevron = document.createElement('span');
    chevron.className = 'channel-chevron';
    chevron.textContent = '▾';

    head.append(icon, name, badge, chevron);

    // 启用开关单独一层：点它不触发展开/收起。
    const toggleWrap = document.createElement('label');
    toggleWrap.className = 'toggle';
    const enabledInput = document.createElement('input');
    enabledInput.type = 'checkbox';
    enabledInput.checked = enabled;
    if (spec.status === 'planned') enabledInput.disabled = true;
    toggleWrap.append(enabledInput, Object.assign(document.createElement('span'), { className: 'toggle-slider' }));
    enabledInput.addEventListener('click', (e) => e.stopPropagation());
    toggleWrap.addEventListener('click', (e) => e.stopPropagation());
    enabledInput.addEventListener('change', () => {
      void (async () => {
        await updateChannelEntry(cfg, spec.id, (e) => { e.enabled = enabledInput.checked; });
        badge.className = `channel-badge ${enabledInput.checked ? 'channel-badge-on' : 'channel-badge-off'}`;
        badge.textContent = enabledInput.checked ? t('channel.badgeOn') : t('channel.badgeOff');
      })();
    });
    head.appendChild(toggleWrap);

    head.addEventListener('click', () => {
      if (spec.status === 'planned') return;
      expandedId = expanded ? undefined : spec.id;
      void renderAll();
    });
    card.appendChild(head);

    // ── 展开体：开通步骤 + 一键开通粘贴框 + 可选字段 + 待批准配对 + 完成 ──
    if (expanded) {
      const body = document.createElement('div');
      body.className = 'channel-card-body';

      const guide = document.createElement('div');
      guide.className = 'channel-guide';
      for (const g of spec.guide) {
        const line = document.createElement('div');
        line.className = 'channel-guide-line';
        line.textContent = `· ${g}`;
        guide.appendChild(line);
      }
      body.appendChild(guide);

      // ── 一键开通（粘贴框形态）：解析共享纯函数 → Rust 探活 → 写盘。
      // 探活不过不写盘；写完网关 watch 自动热载，全程无手动重启。 ──
      const onboarding = spec.onboarding;
      if (onboarding && secretKey && spec.status === 'implemented') {
        const onboard = document.createElement('div');
        onboard.className = 'channel-onboard';

        const titleRow = document.createElement('div');
        titleRow.className = 'channel-onboard-title';
        const title = document.createElement('span');
        title.textContent = t('channel.pasteTitle');
        // 「去哪拿凭据」快捷按钮：直达平台控制台（open_path 开系统浏览器，
        // mcpOAuthFlow 同款通道）。
        const consoleBtn = document.createElement('button');
        consoleBtn.type = 'button';
        consoleBtn.className = 'channel-console-btn';
        consoleBtn.textContent = t('channel.consoleBtn');
        consoleBtn.addEventListener('click', () => {
          void (async () => {
            const core = await loadTauriCore();
            if (!core || !isTauriRuntime()) return;
            try {
              await core.invoke('open_path', { path: onboarding.consoleUrl });
            } catch (err) {
              console.error('[pure] open console failed:', err);
            }
          })();
        });
        titleRow.append(title, consoleBtn);
        onboard.appendChild(titleRow);

        const pasteInput = document.createElement('textarea');
        pasteInput.className = 'setting-input channel-paste-input';
        pasteInput.rows = 2;
        pasteInput.placeholder = t('channel.pastePlaceholder');
        pasteInput.autocomplete = 'off';
        pasteInput.spellcheck = false;
        onboard.appendChild(pasteInput);

        const hint = document.createElement('div');
        hint.className = 'channel-guide-line';
        hint.textContent = `${onboarding.fieldsLabel} · ${t('channel.pasteHint')}`;
        onboard.appendChild(hint);

        const row = document.createElement('div');
        row.className = 'channel-onboard-row';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'setting-btn primary';
        btn.textContent = t('channel.onboardBtn');
        const statusLine = document.createElement('span');
        statusLine.className = 'channel-onboard-status';
        row.append(btn, statusLine);
        onboard.appendChild(row);

        const setLine = (text: string, tone: 'ok' | 'err' | 'busy' | 'idle'): void => {
          statusLine.textContent = text;
          statusLine.className = `channel-onboard-status${tone === 'ok' ? ' channel-onboard-ok' : tone === 'err' ? ' channel-onboard-err' : ''}`;
        };

        onboard.appendChild(row);
        btn.addEventListener('click', () => {
          void (async () => {
            const core = await loadTauriCore();
            if (!core || !isTauriRuntime()) {
              setLine(`${t('channel.saveFailed')}: Tauri runtime required`, 'err');
              return;
            }
            const parsed = parseCredentialPaste(pasteInput.value, spec.id as 'feishu' | 'dingtalk' | 'qq');
            if (!parsed?.primary || !parsed?.secondary) {
              setLine(t('channel.onboardParseFail'), 'err');
              return;
            }
            btn.disabled = true;
            setLine(t('channel.onboarding'), 'busy');
            try {
              // 探活先行：凭据被拒/网络不通都不写盘，结果行明说原因。
              const verdict = await core.invoke<{ ok: boolean; kind: string; detail: string }>('channel_verify', {
                platform: spec.id,
                appId: parsed.primary,
                appSecret: parsed.secondary,
              });
              if (!verdict?.ok) {
                if (verdict?.kind === 'network') {
                  setLine(`${t('channel.onboardNetwork')}（${verdict.detail}）`, 'err');
                } else {
                  setLine(`${t('channel.onboardRejected')}：${verdict?.detail ?? ''}。${t('channel.onboardCheckHint')}`, 'err');
                }
                btn.disabled = false;
                return;
              }
              // 凭据有效 → 落盘（secret 0600 + channels.json 保真直改 +
              // 启用开关 + 顶层 enabled 同步）。
              await secretSet(secretKey, parsed.secondary);
              await updateChannelEntry(cfg, spec.id, (entry) => {
                entry.enabled = true;
                entry.accounts = entry.accounts ?? {};
                const acc = Object.values(entry.accounts)[0] ?? {};
                acc[spec.id === 'dingtalk' ? 'clientId' : 'appId'] = parsed.primary;
                acc[spec.id === 'dingtalk' ? 'clientSecretRef' : 'appSecretRef'] = secretKey;
                entry.accounts.main = acc;
              });
              let okLine = t('channel.onboardOk');
              try {
                const status = await core.invoke<{ running: boolean; pid_alive: boolean }>('gateway_status');
                if (!status.running && !status.pid_alive) okLine = t('channel.onboardOkStopped');
              } catch { /* 状态读不到按「已保存」口径说话，不假装 */ }
              setLine(okLine, 'ok');
              badge.className = 'channel-badge channel-badge-on';
              badge.textContent = t('channel.badgeActive');
              pasteInput.value = '';
              const next = document.createElement('div');
              next.className = 'channel-guide-line channel-onboard-next';
              next.textContent = `→ ${onboarding.nextStep}`;
              row.after(next);
            } catch (err) {
              setLine(`${t('channel.saveFailed')}: ${err instanceof Error ? err.message : String(err)}`, 'err');
            } finally {
              btn.disabled = false;
            }
          })();
        });
        body.appendChild(onboard);
      }

      for (const field of spec.fields) {
        const row = document.createElement('div');
        row.className = 'channel-field-row';
        const label = document.createElement('span');
        label.className = 'channel-field-label';
        label.textContent = field.label;
        const input = document.createElement('input');
        input.className = 'setting-input channel-field-input';
        input.type = field.secret ? 'password' : 'text';
        input.placeholder = field.placeholder;
        input.autocomplete = 'off';
        if (field.secret && secretKey) {
          void secretGet(secretKey).then((v) => {
            input.placeholder = v ? t('channel.secretSet') : field.placeholder;
          });
        } else {
          input.value = String(account[field.key] ?? '');
        }
        input.addEventListener('change', () => {
          void (async () => {
            try {
              if (field.secret && secretKey) {
                if (input.value.trim()) {
                  await secretSet(secretKey, input.value.trim());
                  // 指针必须同步写进账户条目：gateway 只认 account.appSecret
                  // （明文，GUI 契约上不写）或 account.appSecretRef（指针）。
                  // 只落 secrets.json 不补指针，gateway 会以「缺少 appSecret」
                  // 跳过该通道，设置页却显示已启用——2026-10-11 真机 qq 卡在
                  // 「未接入任何通道」就是这么来的。Ref 名 = 字段名 + Ref
                  // （appSecret→appSecretRef / clientSecret→clientSecretRef），
                  // 与 cliChannels 的解析约定逐字对齐。
                  await updateChannelAccount(cfg, spec.id, (acc) => { acc[`${field.key}Ref`] = secretKey; });
                }
                input.value = '';
                input.placeholder = t('channel.secretSet');
              } else {
                await updateChannelAccount(cfg, spec.id, (acc) => { acc[field.key] = input.value.trim(); });
              }
            } catch (err) {
              // 浏览器预览等非 Tauri 环境写入不了本地文件：明说，别假装保存成功。
              input.placeholder = `${t('channel.saveFailed')}: ${err instanceof Error ? err.message : String(err)}`;
            }
          })();
        });
        row.append(label, input);
        body.appendChild(row);
      }

      // ── 待批准配对（一键批准）：读盘上 pending 文件按通道过滤，批准 =
      // pending 删条目 + peers 加条目。PairingGate 按 mtime 跨进程增量重读
      // （approve 命令同款通路），gateway 无需重启。 ──
      if (secretKey && spec.status === 'implemented') {
        const pairingBox = document.createElement('div');
        pairingBox.className = 'channel-pairing';
        const pairingTitle = document.createElement('div');
        pairingTitle.className = 'channel-onboard-title';
        pairingTitle.textContent = t('channel.pairingPending');
        pairingBox.appendChild(pairingTitle);
        const pairingList = document.createElement('div');
        pairingBox.appendChild(pairingList);
        body.appendChild(pairingBox);
        void renderPairingList(pairingList, spec.id);
      }

      const footer = document.createElement('div');
      footer.className = 'channel-card-footer';
      const doneBtn = document.createElement('button');
      doneBtn.className = 'setting-btn secondary';
      doneBtn.textContent = t('channel.done');
      doneBtn.addEventListener('click', onDone);
      footer.appendChild(doneBtn);
      body.appendChild(footer);

      card.appendChild(body);
    }
    return card;
  }

  void renderAll();
}

// ── 待批准配对（GUI 侧零命令行批准）────────────────────────────────────

interface PendingPairingEntry {
  code: string;
  channelId: string;
  peerId: string;
  name?: string;
  createdAt: number;
}

async function readJsonViaTauri(path: string): Promise<Record<string, unknown> | null> {
  const core = await loadTauriCore();
  if (!core || !isTauriRuntime()) return null;
  try {
    const pureHome = await pureHomeDir();
    const raw = await core.invoke<string>('read_file', { workspace: pureHome, path });
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null; // 不存在/损坏 = 空表（PairingGate 同款容错）
  }
}

async function writeJsonViaTauri(path: string, data: unknown): Promise<void> {
  const core = await loadTauriCore();
  if (!core || !isTauriRuntime()) throw new Error('write requires the Tauri runtime');
  const pureHome = await pureHomeDir();
  await core.invoke('write_file', { workspace: pureHome, path, content: `${JSON.stringify(data, null, 2)}\n` });
}

async function renderPairingList(host: HTMLElement, channelId: string): Promise<void> {
  const pending = await readJsonViaTauri('channels/pending-pairings.json');
  const rows = Object.entries(pending ?? {})
    .map(([key, value]) => ({ key, value: value as PendingPairingEntry }))
    .filter((row) => row.value && typeof row.value.code === 'string' && row.value.channelId === channelId)
    .sort((a, b) => (a.value.createdAt ?? 0) - (b.value.createdAt ?? 0));
  host.replaceChildren();
  if (rows.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'channel-guide-line';
    empty.textContent = t('channel.pairingNone');
    host.appendChild(empty);
    return;
  }
  for (const row of rows) {
    const line = document.createElement('div');
    line.className = 'channel-pairing-row';
    const label = document.createElement('span');
    label.className = 'channel-guide-line';
    label.textContent = `${row.value.code}${row.value.name ? ` · ${row.value.name}` : ''}`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'setting-btn secondary channel-pairing-btn';
    btn.textContent = t('channel.pairingApprove');
    btn.addEventListener('click', () => {
      void (async () => {
        btn.disabled = true;
        btn.textContent = t('channel.pairingApproving');
        try {
          const pend = (await readJsonViaTauri('channels/pending-pairings.json')) ?? {};
          const peers = (await readJsonViaTauri('channels/peers.json')) ?? {};
          const entry = pend[row.key] as PendingPairingEntry | undefined;
          if (!entry) throw new Error('pairing request no longer exists');
          delete pend[row.key];
          peers[row.key] = {
            channelId: entry.channelId,
            peerId: entry.peerId,
            ...(entry.name ? { name: entry.name } : {}),
            approvedAt: Date.now(),
          };
          await writeJsonViaTauri('channels/pending-pairings.json', pend);
          await writeJsonViaTauri('channels/peers.json', peers);
          label.textContent = t('channel.pairingApproved');
          btn.remove();
        } catch (err) {
          btn.disabled = false;
          btn.textContent = t('channel.pairingApprove');
          label.textContent = `${t('channel.saveFailed')}: ${err instanceof Error ? err.message : String(err)}`;
        }
      })();
    });
    line.append(label, btn);
    host.appendChild(line);
  }
}

/**
 * 顶层 `enabled` 是 gateway 的总开关：`pure gateway` 在它为 false 时打印
 * 「channels.enabled 为 false」后直接退出（src/cliChannels.ts）。而这个字段
 * 只有 CLI 手写时会存在——GUI 一直只写通道级开关，于是用户勾了飞书/QQ，
 * 网关照旧「未启动任何通道」立刻退出，设置页却报「已启动 + 连通性失败」
 * （2026-10-07 Windows 真机）。写文件前按「任一通道启用」同步它。
 */
function syncChannelsEnabled(cfg: ChannelsFile): void {
  cfg.enabled = Object.values(cfg.channels ?? {}).some((c) => c?.enabled === true);
}

async function updateChannelEntry(cfg: ChannelsFile, id: string, patch: (entry: NonNullable<ChannelsFile['channels']>[string]) => void): Promise<void> {
  cfg.channels = cfg.channels ?? {};
  const entry = cfg.channels[id] ?? {};
  patch(entry);
  cfg.channels[id] = entry;
  syncChannelsEnabled(cfg);
  await writeChannelsFile(cfg);
}

async function updateChannelAccount(cfg: ChannelsFile, id: string, patch: (acc: Record<string, unknown>) => void): Promise<void> {
  await updateChannelEntry(cfg, id, (entry) => {
    entry.accounts = entry.accounts ?? {};
    const acc = Object.values(entry.accounts)[0] ?? {};
    patch(acc);
    entry.accounts.main = acc;
  });
}
