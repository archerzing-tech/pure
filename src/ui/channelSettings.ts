// src/ui/channelSettings.ts
// 设置 → 频道页：飞书 / 钉钉 / 企业微信 / webchat 的接入卡片（手风琴式）。
// 单一事实源是 ~/.pure/channels.json（gateway 读的就是它），本页用 Tauri 的
// read_file/write_file 直接编辑该文件；密钥不进 localStorage/channels.json，
// 走 Rust secret_set/secret_get 落在 ~/.pure/secrets.json（0600）——
// 与 CLI/gateway 的 appSecretRef/clientSecretRef 约定同源，零翻译层。
//
// 交互：每个频道一张卡，头部一行 = 图标 + 名称 + 状态徽标 + 启用开关；
// 默认全部收起，点头部展开（同时只展开一个），表单改动即改即存，
// 「完成」收起。收起时也能从徽标一眼看出「已启用/未启用 + 凭据是否已设」。
import { isTauriRuntime, loadTauriCore, tauriInvoke } from '../shared/tauri';
import { homeDir, join } from '@tauri-apps/api/path';
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
    fields: [
      { key: 'appId', label: 'App ID', placeholder: 'cli_xxx' },
      { key: 'appSecret', label: 'App Secret', placeholder: '••••••••', secret: true },
    ],
    guide: [
      '开放平台 → 创建企业自建应用 → 添加「机器人」能力',
      '事件与回调 → 订阅方式选「长连接」→ 添加事件 im.message.receive_v1',
      '权限管理：开通 im:message、im:message:send_as_bot、im:resource（图片）',
      '版本管理 → 创建版本并发布（未发布事件不会推送）',
    ],
    status: 'implemented',
  },
  {
    id: 'dingtalk',
    name: '钉钉',
    icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M8 12h8M12 8v8"/></svg>',
    fields: [
      { key: 'clientId', label: 'Client ID (AppKey)', placeholder: 'ding_xxx' },
      { key: 'clientSecret', label: 'Client Secret (AppSecret)', placeholder: '••••••••', secret: true },
      { key: 'robotCode', label: 'Robot Code（可选，发图片需要）', placeholder: 'ding_xxx' },
      { key: 'cardTemplateId', label: '卡片模板 ID（可选，缺省只发最终结果）', placeholder: '' },
    ],
    guide: [
      '开放平台 → 创建企业内部应用 → 开启「机器人」',
      'Stream 模式推送（无需公网 IP）',
      '企业内部应用的凭据即 Client ID / Client Secret',
    ],
    status: 'implemented',
  },
  {
    id: 'qq',
    name: 'QQ',
    icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M9 10h.01M15 10h.01M8.5 14.5a5 5 0 0 0 7 0"/></svg>',
    fields: [
      { key: 'appId', label: 'AppID', placeholder: '10xxxxxx' },
      { key: 'appSecret', label: 'AppSecret', placeholder: '••••••••', secret: true },
    ],
    guide: [
      'QQ 开放平台 → 创建机器人 → 拿 AppID / AppSecret',
      ' websocket 长连接接入（无需公网 IP），群聊默认仅 @ 触发',
      '沙箱环境先试单聊（C2C），群消息需上线审核后全量可用',
    ],
    status: 'implemented',
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

async function gatewayRunning(): Promise<boolean> {
  // 2026-10-01 真机：webview 裸 fetch 打 127.0.0.1 是跨源请求，网关不回
  // CORS 头 ⇒ 浏览器直接拒（Gateway 明明在跑，频道页却报「未运行」）。
  // 与 Gateway 页同一真相：Rust gateway_status（no_proxy、无 CORS 之说）。
  try {
    const status = await tauriInvoke<{ running?: boolean }>('gateway_status');
    return status?.running === true;
  } catch {
    return false;
  }
}

export function renderChannelSettings(host: HTMLElement, onChange: () => void): void {
  void onChange;
  host.replaceChildren();
  const desc = document.createElement('p');
  desc.className = 'settings-page-desc';
  desc.textContent = t('channel.desc');
  host.appendChild(desc);

  const wrap = document.createElement('div');
  wrap.className = 'channel-cards';
  host.appendChild(wrap);

  const note = document.createElement('p');
  note.className = 'settings-page-desc channel-note';
  host.appendChild(note);

  // 手风琴状态：同时只展开一张卡（undefined = 全收起）。
  let expandedId: string | undefined;

  async function renderAll(): Promise<void> {
    // 频道列表立即渲染——不等 gateway 探测（2026-10-01 Windows 真机：网关
    // 没跑时 127.0.0.1 空端口不走快速拒绝，HTTP 探测超时 ≈ 5s 白屏）。
    const cfg = await readChannelsFile();
    cfg.channels = cfg.channels ?? {};
    note.textContent = t('channel.gatewayChecking', '检查 gateway 状态…');
    wrap.replaceChildren();
    for (const spec of SPECS) {
      wrap.appendChild(await buildCard(spec, cfg, () => {
        expandedId = undefined;
        void renderAll();
      }));
    }
    // 网关状态异步补上（列表已经在了，这行只改顶部徽章文案）。
    void gatewayRunning().then((running) => {
      note.textContent = running ? t('channel.gatewayRunning') : t('channel.gatewayStopped');
    });
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
        if (v && !badge.textContent?.includes('·')) badge.textContent += ` · ${t('channel.badgeSecretSet')}`;
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

    // ── 展开体：开通步骤 + 凭据表单 + 完成 ──
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
                if (input.value.trim()) await secretSet(secretKey, input.value.trim());
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
