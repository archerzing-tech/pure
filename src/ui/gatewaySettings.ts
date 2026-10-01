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
  // ── 依赖管理（三列表格 + 智能展开/收起，2026-10-01 用户定稿设计）──
  const depsSection = document.createElement('div');
  depsSection.className = 'settings-section gateway-deps-section';
  host.appendChild(depsSection);

  const depsCard = document.createElement('div');
  depsCard.className = 'setting-row gateway-deps-header';
  depsCard.style.cssText = 'cursor:pointer;user-select:none;';
  depsSection.appendChild(depsCard);

  const depsHeaderLabel = document.createElement('div');
  depsHeaderLabel.className = 'setting-label';
  depsCard.appendChild(depsHeaderLabel);

  const depsHeaderArrow = document.createElement('span');
  depsHeaderArrow.className = 'gateway-deps-arrow';
  depsHeaderArrow.textContent = '▸';
  depsCard.appendChild(depsHeaderLabel);
  depsCard.appendChild(depsHeaderArrow);

  const depsTable = document.createElement('div');
  depsTable.className = 'gateway-deps-table';
  depsTable.style.display = 'none';
  depsSection.appendChild(depsTable);

  let depsExpanded = false;
  depsCard.addEventListener('click', () => {
    depsExpanded = !depsExpanded;
    depsTable.style.display = depsExpanded ? '' : 'none';
    depsHeaderArrow.textContent = depsExpanded ? '▾' : '▸';
  });

  interface DepRow { name: string; installed: boolean; version: string; required: boolean; }
  async function refreshDeps(): Promise<void> {
    try {
      const core = await coreOf();
      if (!core) return;
      const deps = await core.invoke<Array<{ name: string; installed: boolean; version: string }>>('gateway_check_deps');
      // Bun 是必需依赖（网关的运行时），CLI 是可选增强（完整通道需要）。
      const rows: DepRow[] = (deps ?? []).map((d) => ({
        ...d,
        required: d.name === 'Bun',
      }));
      const missingRequired = rows.filter((r) => r.required && !r.installed);
      const missingOptional = rows.filter((r) => !r.required && !r.installed);
      const allOk = missingRequired.length === 0 && missingOptional.length === 0;

      // ── 首行状态 ──
      depsHeaderLabel.replaceChildren();
      if (missingRequired.length > 0) {
        const names = missingRequired.map((r) => r.name).join('、');
        depsHeaderLabel.textContent = `⚠️ 缺少必需依赖「${names}」——没有它 Gateway 无法启动`;
        depsHeaderLabel.className = 'setting-label gateway-deps-warning';
        // 缺必需依赖 → 自动展开
        if (!depsExpanded) { depsExpanded = true; depsTable.style.display = ''; depsHeaderArrow.textContent = '▾'; }
      } else if (missingOptional.length > 0) {
        const dot = document.createElement('span');
        dot.className = 'gateway-dot gateway-dot-ok';
        depsHeaderLabel.appendChild(dot);
        depsHeaderLabel.appendChild(document.createTextNode('可启动 Gateway（基础模式）'));
        const hint = document.createElement('div');
        hint.className = 'gateway-deps-hint';
        hint.textContent = `安装 ${missingOptional.map((r) => r.name).join('、')} 可启用完整通道连接（飞书/QQ/钉钉）`;
        depsHeaderLabel.appendChild(hint);
      } else {
        const dot = document.createElement('span');
        dot.className = 'gateway-dot gateway-dot-ok';
        depsHeaderLabel.appendChild(dot);
        depsHeaderLabel.appendChild(document.createTextNode('依赖已就绪'));
      }

      // ── 三列表格 ──
      depsTable.replaceChildren();
      const table = document.createElement('table');
      table.className = 'gateway-deps-table-inner';
      const thead = document.createElement('thead');
      const headRow = document.createElement('tr');
      for (const col of ['名称', '路径', '操作']) {
        const th = document.createElement('th');
        th.textContent = col;
        headRow.appendChild(th);
      }
      thead.appendChild(headRow);
      table.appendChild(thead);
      const tbody = document.createElement('tbody');

      for (const dep of rows) {
        const tr = document.createElement('tr');
        tr.className = dep.installed ? 'gateway-dep-ok' : 'gateway-dep-missing';

        // 第一列：名称 + 圆点 + 必需标记
        const tdName = document.createElement('td');
        const dot = document.createElement('span');
        dot.className = `gateway-dot${dep.installed ? ' gateway-dot-ok' : ' gateway-dot-warn'}`;
        tdName.appendChild(dot);
        tdName.appendChild(document.createTextNode(dep.name));
        if (dep.required) {
          const badge = document.createElement('span');
          badge.className = 'gateway-dep-badge';
          badge.textContent = '必需';
          tdName.appendChild(badge);
        }
        tr.appendChild(tdName);

        // 第二列：路径（已装显示，未装显示 —）
        const tdPath = document.createElement('td');
        tdPath.className = 'gateway-dep-path';
        if (dep.installed && dep.version) {
          tdPath.textContent = dep.version;
          tdPath.title = dep.version;
        } else {
          tdPath.textContent = '—';
        }
        tr.appendChild(tdPath);

        // 第三列：按钮（已装=灰禁用，未装=高亮安装）
        const tdAction = document.createElement('td');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `setting-btn ${dep.installed ? '' : 'setting-btn-primary'} gateway-dep-install-btn`;
        btn.textContent = dep.installed ? '已安装' : '⬇ 安装';
        btn.disabled = dep.installed;
        if (!dep.installed) {
          btn.addEventListener('click', async () => {
            btn.disabled = true;
            btn.textContent = '⬱ 安装中…';
            try {
              const cmd = dep.name === 'Bun' ? 'gateway_install_bun' : 'gateway_download_cli';
              const result = await core.invoke<string>(cmd);
              btn.textContent = '✅ 完成';
              void refreshDeps();
            } catch (err) {
              btn.textContent = '❌ 重试';
              btn.disabled = false;
              btn.title = err instanceof Error ? err.message : String(err);
            }
          });
        }
        tdAction.appendChild(btn);
        tr.appendChild(tdAction);
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      depsTable.appendChild(table);
    } catch {
      depsTable.replaceChildren();
    }
  }

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
