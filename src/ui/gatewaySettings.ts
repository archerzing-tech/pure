// src/ui/gatewaySettings.ts
// 设置 → Gateway 页：管理独立的 `pure gateway` 守护进程（channels 宿主）。
// 状态/启停走 Rust 端 gateway_status / gateway_start / gateway_stop 命令——
// 它们只碰 gateway 进程与 webchat 端口，与 WebView 里的 agent 会话完全无关，
// 本地对话/做任务能力不受影响。状态每 5 秒自动刷新（页面可见时）。
import { isTauriRuntime, loadTauriCore } from '../shared/tauri';
import { t } from '../shared/i18n';

interface GatewayStatus {
  running: boolean;
  pid_alive: boolean;
  pid: number | null;
  started_at: number | null;
  channels: string[];
  port: number;
  http_ok: boolean;
}

type Core = { invoke: <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T> };

async function coreOf(): Promise<Core | null> {
  if (!isTauriRuntime()) return null;
  return (await loadTauriCore()) as unknown as Core | null;
}

function fmtTime(ts: number | null): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

export function renderGatewaySettings(host: HTMLElement): void {
  host.replaceChildren();

  const desc = document.createElement('p');
  desc.className = 'settings-page-desc';
  desc.textContent = t('gateway.desc');
  host.appendChild(desc);

  const section = document.createElement('div');
  section.className = 'settings-section';
  host.appendChild(section);

  const statusRow = document.createElement('div');
  statusRow.className = 'setting-row';
  statusRow.innerHTML = `
    <div class="setting-info">
      <span class="setting-label"><span class="gateway-dot" id="gateway-dot"></span>${t('gateway.status')}</span>
      <span class="setting-hint">…</span>
    </div>`;
  section.appendChild(statusRow);
  const dot = statusRow.querySelector<HTMLSpanElement>('#gateway-dot');

  const hint = statusRow.querySelector<HTMLSpanElement>('.setting-hint');

  const channelsRow = document.createElement('div');
  channelsRow.className = 'setting-row';
  channelsRow.innerHTML = `
    <div class="setting-info">
      <span class="setting-label">${t('gateway.channels')}</span>
      <span class="setting-hint">—</span>
    </div>`;
  section.appendChild(channelsRow);
  const channelsHint = channelsRow.querySelector<HTMLSpanElement>('.setting-hint');

  const pidRow = document.createElement('div');
  pidRow.className = 'setting-row';
  pidRow.innerHTML = `
    <div class="setting-info">
      <span class="setting-label">${t('gateway.process')}</span>
      <span class="setting-hint">—</span>
    </div>`;
  section.appendChild(pidRow);
  const pidHint = pidRow.querySelector<HTMLSpanElement>('.setting-hint');

  const actions = document.createElement('div');
  actions.className = 'gateway-actions';
  const startBtn = mkButton(t('gateway.start'), 'primary');
  const stopBtn = mkButton(t('gateway.stop'), 'secondary');
  const restartBtn = mkButton(t('gateway.restart'), 'secondary');
  const testBtn = mkButton(t('gateway.test'), 'secondary');
  // ── 依赖管理（一键安装缺失依赖，2026-10-01 用户建议）──
  const depsSection = document.createElement('div');
  depsSection.className = 'gateway-deps-section';
  depsSection.style.cssText = 'margin-top:18px;padding:14px;border:1px solid var(--border-light);border-radius:10px;';
  host.appendChild(depsSection);

  const depsTitle = document.createElement('h4');
  depsTitle.textContent = t('gateway.deps.title', '依赖管理');
  depsTitle.style.cssText = 'margin:0 0 10px;font-size:14px;font-weight:600;';
  depsSection.appendChild(depsTitle);

  const depsList = document.createElement('div');
  depsSection.appendChild(depsList);

  const installAllBtn = document.createElement('button');
  installAllBtn.className = 'gateway-install-all-btn';
  installAllBtn.textContent = t('gateway.deps.installAll', '一键安装缺失依赖');
  installAllBtn.style.cssText = 'margin-top:10px;padding:8px 16px;border-radius:8px;border:1px solid var(--accent,#3b82f6);background:var(--accent,#3b82f6);color:#fff;cursor:pointer;font-size:13px;';
  depsSection.appendChild(installAllBtn);

  const depsStatus = document.createElement('p');
  depsStatus.style.cssText = 'margin-top:8px;font-size:12px;color:var(--text-secondary);';
  depsSection.appendChild(depsStatus);

  async function refreshDeps(): Promise<void> {
    try {
      const core = await coreOf();
      if (!core) return;
      const deps = await core.invoke<Array<{ name: string; installed: boolean; version: string }>>('gateway_check_deps');
      depsList.replaceChildren();
      let allOk = true;
      for (const dep of deps ?? []) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;margin:4px 0;font-size:13px;';
        const icon = dep.installed ? '✅' : '❌';
        const ver = dep.installed && dep.version ? `（${dep.version}）` : '';
        row.textContent = `${icon} ${dep.name}${ver}`;
        if (!dep.installed) allOk = false;
        depsList.appendChild(row);
      }
      installAllBtn.style.display = allOk ? 'none' : '';
      depsStatus.textContent = allOk ? t('gateway.deps.allOk', '所有依赖已就绪') : '';
    } catch {
      depsList.replaceChildren();
    }
  }

  installAllBtn.addEventListener('click', async () => {
    const core = await coreOf();
    if (!core) return;
    installAllBtn.disabled = true;
    installAllBtn.textContent = t('gateway.deps.installing', '安装中…');
    depsStatus.textContent = '';
    try {
      const deps = await core.invoke<Array<{ name: string; installed: boolean }>>('gateway_check_deps');
      const messages: string[] = [];
      for (const dep of deps ?? []) {
        if (dep.installed) continue;
        if (dep.name === 'Bun') {
          const result = await core.invoke<string>('gateway_install_bun');
          messages.push(result);
        } else if (dep.name.includes('CLI')) {
          const result = await core.invoke<string>('gateway_download_cli');
          messages.push(result);
        }
      }
      depsStatus.textContent = messages.length > 0 ? messages.join('；') : t('gateway.deps.allOk', '所有依赖已就绪');
    } catch (err) {
      depsStatus.textContent = `${t('gateway.deps.installError', '安装失败')}: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      installAllBtn.disabled = false;
      installAllBtn.textContent = t('gateway.deps.installAll', '一键安装缺失依赖');
      void refreshDeps();
    }
  });

  void refreshDeps();

  actions.append(startBtn, stopBtn, restartBtn, testBtn);
  host.appendChild(actions);

  const output = document.createElement('pre');
  output.className = 'gateway-output';
  output.hidden = true;
  host.appendChild(output);

  function log(message: string): void {
    output.hidden = false;
    output.textContent += `${new Date().toLocaleTimeString()} ${message}\n`;
  }

  let busy = false;
  let lastStatus: GatewayStatus | null = null;

  function setBusy(v: boolean): void {
    busy = v;
    for (const b of [startBtn, stopBtn, restartBtn, testBtn]) {
      b.disabled = v;
      if (v) b.blur(); // 操作中不保留按下态；结束由 apply() 按真实状态接管
    }
  }

  function apply(s: GatewayStatus): void {
    lastStatus = s;
    // 运行中 = 端口有应答（即启动未报错）→ 绿点；进程在但端口未就绪 → 琥珀；
    // 没进程 → 灰点。
    if (dot) dot.className = `gateway-dot ${s.running ? 'gateway-dot-ok' : s.pid_alive ? 'gateway-dot-warn' : ''}`;
    if (hint) hint.textContent = s.running
      ? `${t('gateway.running')} (${t('gateway.port')} ${s.port})`
      : s.pid_alive
        ? t('gateway.starting')
        : t('gateway.stopped');
    if (channelsHint) channelsHint.textContent = s.channels.length > 0 ? s.channels.join(', ') : '—';
    if (pidHint) pidHint.textContent = s.pid ? `pid ${s.pid} · ${t('gateway.since')} ${fmtTime(s.started_at)}` : '—';
    startBtn.disabled = busy || s.pid_alive;
    stopBtn.disabled = busy || !s.pid_alive;
    restartBtn.disabled = busy || !s.pid_alive;
  }

  async function refresh(): Promise<void> {
    const core = await coreOf();
    if (!core) {
      if (hint) hint.textContent = t('gateway.needsTauri');
      for (const b of [startBtn, stopBtn, restartBtn, testBtn]) b.disabled = true;
      return;
    }
    try {
      apply(await core.invoke<GatewayStatus>('gateway_status'));
    } catch (err) {
      if (hint) hint.textContent = `${t('gateway.statusError')}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  startBtn.addEventListener('click', () => void run('gateway_start', t('gateway.logStarted')));
  stopBtn.addEventListener('click', () => void run('gateway_stop', t('gateway.logStopped')));
  restartBtn.addEventListener('click', () => void runRestart());
  testBtn.addEventListener('click', () => void runTest());

  async function run(cmd: string, done: string): Promise<void> {
    const core = await coreOf();
    if (!core || busy) return;
    setBusy(true);
    try {
      apply(await core.invoke<GatewayStatus>(cmd));
      log(done);
    } catch (err) {
      log(`${t('gateway.logError')}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
      void refresh();
    }
  }

  async function runRestart(): Promise<void> {
    const core = await coreOf();
    if (!core || busy) return;
    setBusy(true);
    try {
      // 2026-10-01：改走 Rust 侧 gateway_restart（原子命令——内含正确的
      // 停止→等端口释放→启动序列，且 Windows 侧 taskkill 语义已修）。
      apply(await core.invoke<GatewayStatus>('gateway_restart'));
      log(t('gateway.logRestarted'));
    } catch (err) {
      log(`${t('gateway.logError')}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
      void refresh();
    }
  }

  async function runTest(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      // 不能用 WebView fetch：tauri:// 源向 127.0.0.1 发跨域请求会被 CORS/ATS
      // 拦截（Load failed），不代表端口死活。探测统一走 Rust（gateway_status
      // 里就是 no_proxy 的 reqwest）。
      const core = await coreOf();
      if (!core) return;
      const t0 = Date.now();
      const s = await core.invoke<GatewayStatus>('gateway_status');
      const ms = Date.now() - t0;
      log(s.http_ok
        ? `${t('gateway.testOk')} (${ms}ms, port ${s.port})`
        : `${t('gateway.testFail')} (port ${s.port})`);
      apply(s);
    } catch (err) {
      log(`${t('gateway.testFail')}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
      void refresh();
    }
  }

  void refresh();
  // 页面可见期间每 5 秒轻量刷新（只在 DOM 里，不可见时 fetch 会失败无所谓）。
  const timer = setInterval(() => {
    if (!host.isConnected) {
      clearInterval(timer);
      return;
    }
    if (!busy) void refresh();
  }, 5000);
}

function mkButton(label: string, variant: 'primary' | 'secondary'): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = `setting-btn ${variant}`;
  b.textContent = label;
  return b;
}
