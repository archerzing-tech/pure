// src/ui/channelSettings.ts
// 设置 → 频道页：飞书 / 钉钉 / 企业微信 / webchat 的接入卡片。
// 单一事实源是 ~/.pure/channels.json（gateway 读的就是它），本页用 Tauri 的
// read_file/write_file 直接编辑该文件；密钥不进 localStorage/channels.json，
// 走 Rust secret_set/secret_get 落在 ~/.pure/secrets.json（0600）——
// 与 CLI/gateway 的 appSecretRef/clientSecretRef 约定同源，零翻译层。
// 表单编辑即时写盘（沿用设置页的 auto-save 姿态）；生效时机 = gateway
// 下次启动（gateway 不热加载配置，页面上有说明）。
import { isTauriRuntime, loadTauriCore } from '../shared/tauri';
import { homeDir, join } from '@tauri-apps/api/path';
import { t } from '../shared/i18n';

export interface ChannelAccountDraft {
  appId: string;
  appSecret: string;
  clientId: string;
  clientSecret: string;
  robotCode: string;
  cardTemplateId: string;
  corpId: string;
  agentId: string;
  token: string;
  encodingAesKey: string;
}

type Draft = Partial<ChannelAccountDraft>;

interface ChannelSpec {
  id: 'feishu' | 'dingtalk' | 'wecom' | 'webchat';
  name: string;
  icon: string;
  /** 每个输入框：key ↔ 凭据槽位或 channels.json 字段。 */
  fields: { key: keyof ChannelAccountDraft; label: string; placeholder: string; secret?: boolean }[];
  guide: string[];
  status: 'implemented' | 'planned';
}

const SECRETS_KEY: Partial<Record<ChannelSpec['id'], string>> = {
  feishu: 'feishu.appSecret',
  dingtalk: 'dingtalk.clientSecret',
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
      '企业内部应用的凭据即 Client ID / Client Secret（Stream 模式无需公网 IP）',
    ],
    status: 'implemented',
  },
  {
    id: 'wecom',
    name: '企业微信',
    icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 9h10M7 13h6"/></svg>',
    fields: [
      { key: 'corpId', label: 'Corp ID', placeholder: 'ww_xxx' },
      { key: 'token', label: 'Token', placeholder: '', secret: true },
      { key: 'encodingAesKey', label: 'EncodingAESKey', placeholder: '', secret: true },
    ],
    guide: ['智能机器人长连接接入（设计稿阶段，待实现）'],
    status: 'planned',
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
  const core = await loadTauriCore();
  if (!core || !isTauriRuntime()) return;
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
  if (!core || !isTauriRuntime()) return;
  await core.invoke('secret_set', { key, value });
}

async function gatewayRunning(): Promise<boolean> {
  const cfg = await readChannelsFile();
  const port = cfg.gateway?.port ?? 18790;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { method: 'HEAD' });
    return res.ok;
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

  void (async () => {
    const [cfg, running] = await Promise.all([readChannelsFile(), gatewayRunning()]);
    cfg.channels = cfg.channels ?? {};

    note.textContent = running ? t('channel.gatewayRunning') : t('channel.gatewayStopped');

    for (const spec of SPECS) {
      wrap.appendChild(await buildCard(spec, cfg));
    }
    wrap.appendChild(buildGatewayCard(cfg));
  })();
}

async function buildCard(spec: ChannelSpec, cfg: ChannelsFile): Promise<HTMLElement> {
  const entry = cfg.channels![spec.id] ?? {};
  const account = Object.values(entry.accounts ?? {})[0] ?? {};
  const secretKey = SECRETS_KEY[spec.id];

  const card = document.createElement('div');
  card.className = `channel-card${spec.status === 'planned' ? ' channel-card-planned' : ''}`;

  const head = document.createElement('div');
  head.className = 'channel-card-head';
  head.innerHTML = `<span class="channel-card-icon">${spec.icon}</span><span class="channel-card-name">${spec.name}</span>`;

  const enabledToggle = document.createElement('label');
  enabledToggle.className = 'toggle';
  const enabledInput = document.createElement('input');
  enabledInput.type = 'checkbox';
  enabledInput.checked = entry.enabled === true;
  if (spec.status === 'planned') enabledInput.disabled = true;
  enabledToggle.append(enabledInput, Object.assign(document.createElement('span'), { className: 'toggle-slider' }));
  head.appendChild(enabledToggle);
  card.appendChild(head);

  const hint = document.createElement('div');
  hint.className = 'channel-card-hint';
  hint.textContent = spec.status === 'planned' ? t('channel.planned') : t('channel.statusPrefix') + (enabledInput.checked ? t('channel.state.on') : t('channel.state.off'));
  card.appendChild(hint);

  for (const g of spec.guide) {
    const li = document.createElement('div');
    li.className = 'channel-guide-line';
    li.textContent = `· ${g}`;
    card.appendChild(li);
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
    // 凭据字段从 secrets 读（不回显明文，占位提示已设置）；非凭据从 channels.json 读
    if (field.secret && secretKey) {
      input.dataset.pending = '';
      void secretGet(secretKey).then((v) => {
        input.placeholder = v ? t('channel.secretSet') : field.placeholder;
      });
    } else {
      input.value = String(account[field.key] ?? '');
    }
    input.addEventListener('change', () => {
      void (async () => {
        if (field.secret && secretKey) {
          if (input.value.trim()) await secretSet(secretKey, input.value.trim());
          input.value = '';
          input.placeholder = t('channel.secretSet');
        } else {
          await updateChannelAccount(cfg, spec.id, (acc) => { acc[field.key] = input.value.trim(); });
        }
      })();
    });
    row.append(label, input);
    card.appendChild(row);
  }

  enabledInput.addEventListener('change', () => {
    void (async () => {
      await updateChannelEntry(cfg, spec.id, (e) => { e.enabled = enabledInput.checked; });
      hint.textContent = spec.status === 'planned' ? t('channel.planned') : t('channel.statusPrefix') + (enabledInput.checked ? t('channel.state.on') : t('channel.state.off'));
    })();
  });

  return card;
}

function buildGatewayCard(cfg: ChannelsFile): HTMLElement {
  const card = document.createElement('div');
  card.className = 'channel-card channel-card-gateway';
  const title = document.createElement('div');
  title.className = 'channel-card-name';
  title.textContent = t('channel.gateway.title');
  card.appendChild(title);

  const hostRow = document.createElement('div');
  hostRow.className = 'channel-field-row';
  const hostLabel = document.createElement('span');
  hostLabel.className = 'channel-field-label';
  hostLabel.textContent = 'Host';
  const hostInput = document.createElement('input');
  hostInput.className = 'setting-input channel-field-input';
  hostInput.value = cfg.gateway?.host ?? '127.0.0.1';
  hostInput.addEventListener('change', () => {
    void updateGateway(cfg, (g) => { g.host = hostInput.value.trim() || '127.0.0.1'; });
  });
  hostRow.append(hostLabel, hostInput);
  card.appendChild(hostRow);

  const portRow = document.createElement('div');
  portRow.className = 'channel-field-row';
  const portLabel = document.createElement('span');
  portLabel.className = 'channel-field-label';
  portLabel.textContent = 'Port';
  const portInput = document.createElement('input');
  portInput.className = 'setting-input channel-field-input';
  portInput.type = 'number';
  portInput.value = String(cfg.gateway?.port ?? 18790);
  portInput.addEventListener('change', () => {
    void updateGateway(cfg, (g) => { g.port = Number(portInput.value) || 18790; });
  });
  portRow.append(portLabel, portInput);
  card.appendChild(portRow);

  const startRow = document.createElement('div');
  startRow.className = 'channel-start-row';
  const startBtn = document.createElement('button');
  startBtn.className = 'setting-btn secondary';
  startBtn.textContent = t('channel.gateway.openWebchat');
  startBtn.addEventListener('click', () => {
    const port = cfg.gateway?.port ?? 18790;
    window.open(`http://127.0.0.1:${port}/`, '_blank');
  });
  const cli = document.createElement('code');
  cli.className = 'channel-cli-hint';
  cli.textContent = 'pure gateway';
  startRow.append(startBtn, cli);
  card.appendChild(startRow);
  return card;
}

async function updateChannelEntry(cfg: ChannelsFile, id: string, patch: (entry: NonNullable<ChannelsFile['channels']>[string]) => void): Promise<void> {
  cfg.channels = cfg.channels ?? {};
  const entry = cfg.channels[id] ?? {};
  patch(entry);
  cfg.channels[id] = entry;
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

async function updateGateway(cfg: ChannelsFile, patch: (g: NonNullable<ChannelsFile['gateway']>) => void): Promise<void> {
  cfg.gateway = cfg.gateway ?? {};
  patch(cfg.gateway);
  await writeChannelsFile(cfg);
}
