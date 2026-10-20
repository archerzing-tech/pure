// src/ui/proxyOnboarding.ts
// 首启代理引导：GUI 就绪后静默探测一次系统代理（复用 Settings 页的
// detect_system_proxy 命令），发现「机器上有代理、应用内代理没开」时弹一张
// 非阻塞引导卡让用户一键启用。动机：终端 AI 工具天然继承 shell 的代理环境
// 变量，而 pure 从 Dock 启动不继承，内网出网用户里只有 pure 上不了网——
// 把「知道怎么配代理」这件事提前替用户做掉，而不是等聊天失败再排查。
//
// 判定与配置换算抽成纯函数（单测覆盖），DOM/Tauri 接线保持薄。
// 「这次不用」只在内存记一个本次启动的标记，不持久化：下个会话机器上代理
// 还在就再问一次——用户换环境（拔掉代理）不该被一次拒绝永远钉死。

import { loadConfig, persistConfig } from './config';
import { isTauriRuntime, loadTauriCore } from '../shared/tauri';
import { composeProxyUrl, normalizeProxyConfig, type ProxyConfig } from '../shared/proxy';
import { t } from '../shared/i18n';
import { showToast } from '../shared/toast';

/** detect_system_proxy 命令的返回形态（Rust DetectedProxy）。 */
export interface DetectedProxyInfo {
  scheme: string;
  host: string;
  port: string;
  /** 'macos' | 'windows' | 'env' | 'local' */
  source: string;
  detail: string;
}

export interface ProxyOnboardingInput {
  /** 浏览器模式读不到 OS 代理，探测命令也不会有结果，永远不弹。 */
  isDesktop: boolean;
  /** 应用内代理主开关（config.proxy.enabled）——开着就不多嘴。 */
  proxyEnabled: boolean;
  /** 本次探测结果；null = 没探到任何可用代理。 */
  detection: DetectedProxyInfo | null;
  /** 本次启动是否已经问过（弹过卡或用户点过「这次不用」都算）。 */
  askedThisLaunch: boolean;
}

/** OS 级代理来源：macOS scutil / Windows 注册表。这两种来源可信到可以直接
 *  用 system:// 形态交给后端请求时解析；env/本地端口的代理可能是死代理，
 *  但引导卡是用户拍板的显式确认（不是静默写配置），所以一样值得问。 */
const OS_PROXY_SOURCES = new Set(['macos', 'windows']);

/**
 * 该不该弹首启代理引导卡。四个条件全满足才弹：
 * 桌面端、应用内代理未启用、本次启动还没问过、探测到了带 host 的代理地址。
 * 纯函数——判定规则改动全在这里，单测钉死行为。
 */
export function shouldOfferProxyOnboarding(input: ProxyOnboardingInput): boolean {
  if (input.askedThisLaunch) return false;
  if (!input.isDesktop) return false;
  if (input.proxyEnabled) return false;
  const found = input.detection;
  if (!found) return false;
  // 最小健全性检查：没有 host 的检测结果写不出可用配置。
  return Boolean(String(found.host ?? '').trim());
}

/**
 * 探测结果 → 代理配置补丁。OS 级来源用 system:// 形态（mode: 'system'，
 * 后端请求时自己解析，OS 代理改了跟着走，地址不用我们维护）；env/本地端口
 * 探活拿到的是具体 host:port，写 manual 形态。只返回需要覆盖的字段，
 * 其余（凭据、绕行供应商、探测端点）原样保留。
 */
export function proxyConfigPatchFromDetection(found: DetectedProxyInfo): Partial<ProxyConfig> {
  if (OS_PROXY_SOURCES.has(found.source)) {
    return { enabled: true, mode: 'system' };
  }
  return {
    enabled: true,
    mode: 'manual',
    url: composeProxyUrl(found.scheme, found.host, found.port),
  };
}

// 本次启动只问一次。进 maybeOfferProxyOnboarding 就置位（探测失败/异常也
// 不重试）——反复弹卡比不弹更烦人。内存变量，重启即重置，不持久化。
let askedThisLaunch = false;

/** 测试钩子：重置模块级「本次已问过」标记。 */
export function resetProxyOnboardingForTests(): void {
  askedThisLaunch = false;
}

/**
 * 启动接线：至多一次探测 + 弹卡。挂在 main.ts 的 deferred idle 路径上
 * （GUI 就绪之后、不占关键路径），绝不挂在聊天失败路径上。
 */
export async function maybeOfferProxyOnboarding(): Promise<void> {
  if (askedThisLaunch) return;
  askedThisLaunch = true;
  if (!isTauriRuntime()) return;
  const core = await loadTauriCore();
  if (!core) return;
  let detection: DetectedProxyInfo | null = null;
  try {
    detection = (await core.invoke<DetectedProxyInfo | null>('detect_system_proxy')) ?? null;
  } catch (err) {
    console.warn('[pure] startup proxy detection failed:', err);
    return;
  }
  const cfg = loadConfig();
  const proxyEnabled = cfg?.proxy?.enabled === true;
  // 显式收窄：null（没探到）走同一出口，后续代码拿到的都是非空结果。
  if (!detection) return;
  if (!shouldOfferProxyOnboarding({ isDesktop: true, proxyEnabled, detection, askedThisLaunch: false })) {
    return;
  }
  showProxyOnboardingCard(detection);
}

function dismissProxyOnboardingCard(): void {
  document.getElementById('proxy-onboarding-card')?.remove();
}

/** 探测地址的人读形态：`host:port`（port 空就只剩 host）。 */
function detectionAddressLabel(found: DetectedProxyInfo): string {
  const host = String(found.host ?? '').trim();
  const port = String(found.port ?? '').trim();
  return port ? `${host}:${port}` : host;
}

function showProxyOnboardingCard(found: DetectedProxyInfo): void {
  dismissProxyOnboardingCard();
  const card = document.createElement('div');
  card.id = 'proxy-onboarding-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', t('proxy.onboarding.title'));

  const title = document.createElement('div');
  title.className = 'proxy-onboard-title';
  title.textContent = t('proxy.onboarding.title');
  card.appendChild(title);

  const body = document.createElement('div');
  body.className = 'proxy-onboard-body';
  body.textContent = t('proxy.onboarding.body');
  card.appendChild(body);

  const addr = document.createElement('div');
  addr.className = 'proxy-onboard-addr';
  // 来源标签跟随探测来源复用 Settings 页的现成文案；未知来源不硬凑。
  const sourceKey = `proxy.detect.source.${found.source}`;
  const sourceLabel = t(sourceKey);
  addr.textContent =
    sourceLabel !== sourceKey
      ? `${detectionAddressLabel(found)} · ${sourceLabel}`
      : detectionAddressLabel(found);
  card.appendChild(addr);

  const actions = document.createElement('div');
  actions.className = 'proxy-onboard-actions';

  const declineBtn = document.createElement('button');
  declineBtn.className = 'setting-btn secondary';
  declineBtn.textContent = t('proxy.onboarding.decline');
  declineBtn.addEventListener('click', () => dismissProxyOnboardingCard());

  const acceptBtn = document.createElement('button');
  acceptBtn.className = 'setting-btn primary';
  acceptBtn.textContent = t('proxy.onboarding.accept');
  acceptBtn.addEventListener('click', () => {
    dismissProxyOnboardingCard();
    applyProxyFromDetection(found);
  });

  actions.appendChild(declineBtn);
  actions.appendChild(acceptBtn);
  card.appendChild(actions);
  document.body.appendChild(card);

  // Esc 等同「这次不用」：卡片不抢焦点也不阻塞任何操作，键盘用户也该有
  // 一键送走它的方式。卡片先被按钮关掉时监听器自拆——绝不能残留着吞掉
  // 用户后续的 Esc（关设置页、停回复都靠它）。
  const onKeydown = (e: KeyboardEvent): void => {
    if (!document.getElementById('proxy-onboarding-card')) {
      document.removeEventListener('keydown', onKeydown);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      dismissProxyOnboardingCard();
      document.removeEventListener('keydown', onKeydown);
    }
  };
  document.addEventListener('keydown', onKeydown);
}

/**
 * 「启用并走它」：把探测结果写进代理配置并启用。落点与 Settings 页的
 * autoSave 相同（persistConfig 单一出口），点按钮时重新 loadConfig 而不是
 * 沿用弹卡时的快照——卡片开着的几十秒里用户可能在设置里动过别的字段，
 * 快照写回会把那些改动抹掉。
 */
function applyProxyFromDetection(found: DetectedProxyInfo): void {
  const cfg = loadConfig();
  if (!cfg) return;
  cfg.proxy = normalizeProxyConfig({
    ...cfg.proxy,
    ...proxyConfigPatchFromDetection(found),
  });
  persistConfig(cfg);
  showToast(t('proxy.onboarding.enabled'));
}
