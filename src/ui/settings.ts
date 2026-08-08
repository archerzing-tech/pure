// src/ui/settings.ts
// Modal settings panel. Lazy-loaded on first open (see src/ui/main.ts) so the
// eager startup bundle stays lean; the config model it edits lives in
// ./config.ts (needed at startup by chat.ts / main.ts) and provider defaults
// come from ../shared/providers.ts.

import { fetchAndDisplayVersion, checkForUpdatesManual } from './updater';
import { escapeHtml } from '../shared/html';
import { t, updateLanguage, applyTranslations, type Language as I18nLanguage } from '../shared/i18n';
import { isTauriRuntime, loadTauriCore } from '../shared/tauri';
import { formatBytes } from './TauriToolAdapter';
import { defaultModelFor, providerDef } from '../shared/providers';
import {
  STORAGE_KEY,
  defaults,
  hasConfiguredKey,
  invalidateConfigCache,
  isDefaultMcpServer,
  loadConfig,
  revokeSecretFromRust,
  storeSecretInRust,
  type PureConfig,
} from './config';
import {
  DEFAULT_HUB_REPO,
  fetchHubIndex,
  fetchSkillBody,
  makeHubSkill,
  normalizeHubRepo,
  splitSkillMarkdown,
  type HubSkill,
} from './skillHub';

export class SettingsPanel {
  private onSave: () => void;
  private onOpen?: () => void;
  private onClose?: () => void;
  private currentCategory: string = 'general';
  private visible = false;
  private focusBeforeOpen: HTMLElement | null = null;
  private mcpServers: PureConfig['mcpServers'] = [];
  /** Bound in the constructor; refreshes the paste-file footprint on open. */
  private refreshTmpUsage: () => Promise<void> = async () => {};

  constructor(onSave: () => void, onOpen?: () => void, onClose?: () => void) {
    this.onSave = onSave;
    this.onOpen = onOpen;
    this.onClose = onClose;

    this.bindNav();
    this.bindActions();
    this.loadToForm();
  }

  // ── Open / Close (horizontal squeeze animation) ──

  open() {
    if (this.visible) return;
    this.focusBeforeOpen = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.visible = true;
    const settingsView = document.getElementById('settings-view')!;
    const chatView = document.getElementById('chat-view')!;
    const toggleBtn = document.getElementById('sidebar-toggle')!;
    settingsView.classList.add('expanded');
    chatView.classList.add('squeezed');
    toggleBtn.style.display = 'none';
    this.loadToForm();
    this.onOpen?.();
    // Move keyboard focus into the settings view so opening it never leaves
    // the user tabbing through controls behind the squeezed chat view.
    document.getElementById('settings-back-btn')?.focus();
    // Refresh the paste-file footprint every time the panel opens.
    void this.refreshTmpUsage();
  }

  close() {
    if (!this.visible) return;
    this.visible = false;
    const settingsView = document.getElementById('settings-view')!;
    const chatView = document.getElementById('chat-view')!;
    const toggleBtn = document.getElementById('sidebar-toggle')!;
    settingsView.classList.remove('expanded');
    chatView.classList.remove('squeezed');
    toggleBtn.style.display = '';
    this.onClose?.();
    if (this.focusBeforeOpen?.isConnected) this.focusBeforeOpen.focus();
    this.focusBeforeOpen = null;
  }

  isVisible(): boolean {
    return this.visible;
  }

  // ── Navigation ──

  switchCategory(category: string) {
    this.currentCategory = category;

    document.querySelectorAll('.settings-nav-item').forEach(el => {
      const isActive = el.getAttribute('data-category') === category;
      el.classList.toggle('active', isActive);
      if (isActive) el.setAttribute('aria-current', 'page');
      else el.removeAttribute('aria-current');
    });

    document.querySelectorAll('.settings-page').forEach(el => {
      el.classList.toggle('active', el.getAttribute('data-page') === category);
    });

    const navItem = document.querySelector(`.settings-nav-item[data-category="${category}"]`);
    const title = navItem?.querySelector('span')?.textContent || 'Settings';
    document.getElementById('settings-title')!.textContent = title;
  }

  // ── Config queries ──

  isConfigured(): boolean {
    return hasConfiguredKey(loadConfig());
  }

  getAppliedConfig(): PureConfig {
    const cfg = loadConfig();
    if (!cfg) return defaults();
    return cfg;
  }

  // ── Bind navigation ──

  private bindNav() {
    document.querySelectorAll('.settings-nav-item').forEach(el => {
      el.addEventListener('click', () => {
        const cat = el.getAttribute('data-category');
        if (cat) this.switchCategory(cat);
      });
    });

    document.getElementById('settings-close')!.addEventListener('click', () => this.close());
    document.getElementById('settings-back-btn')?.addEventListener('click', () => this.close());
  }

  // ── Bind form actions + auto-save ──

  private bindActions() {
    // Update check
    fetchAndDisplayVersion();
    document.getElementById('cfg-check-updates')?.addEventListener('click', () => checkForUpdatesManual());

    // ── Temp paste files: usage + one-click cleanup (Tauri only) ──
    const tmpUsageEl = document.getElementById('tmp-usage');
    const tmpDaysEl = document.getElementById('tmp-days') as HTMLInputElement | null;
    const tmpCleanBtn = document.getElementById('tmp-clean-btn') as HTMLButtonElement | null;

    this.refreshTmpUsage = async () => {
      if (!tmpUsageEl || !isTauriRuntime()) return;
      try {
        const core = await loadTauriCore();
        const usage = await core?.invoke<{ files: number; bytes: number }>('tmp_paste_usage');
        tmpUsageEl.textContent = usage && usage.files > 0
          ? `${usage.files} · ${formatBytes(usage.bytes)}`
          : t('tmp.usageNone');
      } catch (err) {
        console.error('[pure] tmp_paste_usage failed:', err);
      }
    };

    // ── Skill Hub: browse + install third-party skills ──
    const hubRepoInput = document.getElementById('hub-repo') as HTMLInputElement | null;
    const hubBrowseBtn = document.getElementById('hub-browse-btn') as HTMLButtonElement | null;
    const hubStatusEl = document.getElementById('hub-status');
    const hubGroupedEl = document.getElementById('hub-grouped');
    const hubInstalledEl = document.getElementById('hub-installed');

    const setHubStatus = (msg: string, isError = false) => {
      if (!hubStatusEl) return;
      hubStatusEl.textContent = msg;
      hubStatusEl.hidden = !msg;
      hubStatusEl.classList.toggle('hub-status-error', isError);
    };

    const renderInstalled = () => this.renderInstalledHubSkills();

    hubBrowseBtn?.addEventListener('click', async () => {
      const repo = normalizeHubRepo(hubRepoInput?.value.trim() || DEFAULT_HUB_REPO);
      if (!repo) return;
      hubBrowseBtn.disabled = true;
      hubBrowseBtn.textContent = t('hub.loading');
      hubGroupedEl!.innerHTML = '';
      setHubStatus('');
      try {
        const index = await fetchHubIndex(repo);
        const cfg = loadConfig() ?? defaults();
        const installed = new Set((cfg.hubSkills ?? []).map(s => s.name));
        const groups = index.groupings.length > 0 ? index.groupings : [{
          title: t('hub.allSkills'),
          description: '',
          skills: index.skills,
        }];
        hubGroupedEl!.innerHTML = groups.map(g => `
          <div class="hub-group">
            <div class="hub-group-title">${escapeHtml(g.title)}</div>
            ${g.description ? `<div class="hub-group-desc">${escapeHtml(g.description)}</div>` : ''}
            <div class="hub-group-skills">
              ${g.skills.map(s => `
                <div class="skill-card hub-skill-card" data-repo="${escapeHtml(repo)}" data-skill="${escapeHtml(s.name)}">
                  <div class="skill-card-header">
                    <span class="skill-name">${escapeHtml(s.name)}</span>
                    ${installed.has(s.name) ? `<span class="hub-badge hub-badge-installed" data-i18n="hub.installedBadge">已安装</span>` : ''}
                  </div>
                  <p class="skill-desc">${escapeHtml(s.description || '')}</p>
                  <button class="setting-btn hub-install-btn" data-repo="${escapeHtml(repo)}" data-skill="${escapeHtml(s.name)}" ${installed.has(s.name) ? 'disabled' : ''} data-i18n="hub.install">安装</button>
                </div>`).join('')}
            </div>
          </div>`).join('');
        applyTranslations();
        setHubStatus(index.groupings.length === 0 && index.skills.length === 0
          ? t('hub.empty')
          : t('hub.loaded').replace('{n}', String((index.groupings.length > 0 ? index.groupings.reduce((a, g) => a + g.skills.length, 0) : index.skills.length))));
      } catch (err) {
        console.error('[pure] skill hub browse failed:', err);
        setHubStatus((err as Error)?.message || t('hub.failed'), true);
      } finally {
        hubBrowseBtn.disabled = false;
        hubBrowseBtn.textContent = t('hub.browse');
      }
    });

    // Install buttons are event-delegated (the grid is rebuilt on each browse).
    hubGroupedEl?.addEventListener('click', async (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.hub-install-btn');
      if (!btn || btn.disabled) return;
      const repo = btn.dataset.repo;
      const skill = btn.dataset.skill;
      if (!repo || !skill) return;
      btn.disabled = true;
      btn.textContent = t('hub.installing');
      try {
        const raw = await fetchSkillBody(repo, skill);
        if (raw === null) {
          setHubStatus(t('hub.bodyFailed').replace('{s}', skill), true);
          return;
        }
        const cfg = loadConfig() ?? defaults();
        const skills = [...(cfg.hubSkills ?? [])];
        if (skills.some(s => s.name === skill)) {
          setHubStatus(t('hub.alreadyInstalled').replace('{s}', skill), true);
          return;
        }
        const split = splitSkillMarkdown(raw);
        const summary = { name: skill, description: split.description ?? '', hasDescription: !!split.description };
        skills.push(makeHubSkill(repo, summary, split.body || raw));
        cfg.hubSkills = skills;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
        invalidateConfigCache();
        renderInstalled();
        // Mark the card installed IN PLACE (badge + disabled) instead of
        // re-fetching the whole index — no extra network round-trip, and the
        // success toast below is not overwritten by a browse status.
        const card = hubGroupedEl?.querySelector(`.hub-skill-card[data-skill="${CSS.escape(skill)}"]`);
        const cardBtn = card?.querySelector<HTMLButtonElement>('.hub-install-btn');
        if (card) {
          card.querySelector('.skill-card-header')?.insertAdjacentHTML('beforeend',
            `<span class="hub-badge hub-badge-installed" data-i18n="hub.installedBadge">已安装</span>`);
          applyTranslations();
        }
        if (cardBtn) {
          cardBtn.disabled = true;
          cardBtn.textContent = t('hub.installedBadge');
        }
        setHubStatus(t('hub.installedToast').replace('{s}', skill));
      } catch (err) {
        console.error('[pure] skill hub install failed:', err);
        setHubStatus((err as Error)?.message || t('hub.failed'), true);
        btn.disabled = false;
        btn.textContent = t('hub.install');
      }
    });

    // Installed-skill enable/disable toggles + remove buttons.
    hubInstalledEl?.addEventListener('change', (e) => {
      const input = e.target as HTMLInputElement;
      if (!input.classList.contains('cfg-hub-skill-toggle')) return;
      const idx = parseInt(input.dataset.hubSkill || '', 10);
      if (isNaN(idx)) return;
      const cfg = loadConfig() ?? defaults();
      const skills = [...(cfg.hubSkills ?? [])];
      if (skills[idx]) {
        skills[idx] = { ...skills[idx], enabled: input.checked };
        cfg.hubSkills = skills;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
        invalidateConfigCache();
      }
    });
    hubInstalledEl?.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.hub-remove-btn');
      if (!btn) return;
      const idx = parseInt(btn.dataset.index || '', 10);
      if (isNaN(idx)) return;
      const cfg = loadConfig() ?? defaults();
      const skills = [...(cfg.hubSkills ?? [])];
      skills.splice(idx, 1);
      cfg.hubSkills = skills;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
      invalidateConfigCache();
      renderInstalled();
      setHubStatus(t('hub.removed'));
    });

    // Seed the repo input + installed list on first bind.
    if (hubRepoInput && !hubRepoInput.value) hubRepoInput.value = DEFAULT_HUB_REPO;
    renderInstalled();

    // ── Environment: auto-detect the user's city from IP ──
    const locateBtn = document.getElementById('cfg-locate-btn') as HTMLButtonElement | null;
    locateBtn?.addEventListener('click', async () => {
      if (locateBtn.disabled) return;
      locateBtn.disabled = true;
      locateBtn.textContent = t('env.detecting');
      try {
        const city = await this.detectLocation();
        const cityInput = document.getElementById('cfg-city') as HTMLInputElement | null;
        if (cityInput) {
          cityInput.value = city;
          this.autoSave();
        }
        this.toast(t('env.detected').replace('{city}', city));
      } catch (err) {
        console.error('[pure] location detection failed:', err);
        this.toast(t('env.detectFailed'));
      } finally {
        locateBtn.disabled = false;
        locateBtn.textContent = t('env.detectBtn');
      }
    });

    tmpCleanBtn?.addEventListener('click', async () => {
      if (!isTauriRuntime()) return;
      const days = Math.max(1, Math.min(365, parseInt(tmpDaysEl?.value || '7', 10) || 7));
      tmpCleanBtn.disabled = true;
      try {
        const core = await loadTauriCore();
        const res = await core?.invoke<{ deleted: number; freedBytes: number }>('cleanup_tmp_pastes', { days });
        const deleted = res?.deleted ?? 0;
        this.toast(deleted > 0
          ? t('tmp.cleaned').replace('{n}', String(deleted)).replace('{size}', formatBytes(res?.freedBytes ?? 0))
          : t('tmp.nothing'));
      } catch (err) {
        console.error('[pure] cleanup_tmp_pastes failed:', err);
        this.toast(t('tmp.cleanFailed'));
      } finally {
        tmpCleanBtn.disabled = false;
        void this.refreshTmpUsage();
      }
    });

    // Toggle API key visibility
    const toggleKey = document.getElementById('cfg-toggle-key');
    const keyInput = document.getElementById('cfg-apikey') as HTMLInputElement;
    toggleKey?.addEventListener('click', () => {
      const isPassword = keyInput.type === 'password';
      keyInput.type = isPassword ? 'text' : 'password';
      toggleKey.querySelector('svg')?.style.setProperty('opacity', isPassword ? '1' : '0.5');
    });

    // Track real user edits: a stored (masked) key must only be revoked when
    // the user explicitly types into the field and clears it — never by an
    // unrelated autoSave (theme / language / font-size change) that fires
    // while the masked field happens to be empty.
    keyInput.addEventListener('input', () => {
      if (keyInput.value.trim()) keyInput.dataset.touched = '1';
    });

    // Provider cards + hidden compatibility select share one source of truth.
    document.querySelectorAll<HTMLButtonElement>('.provider-card').forEach(card => {
      card.addEventListener('click', () => {
        const provider = card.dataset.provider;
        if (!provider) return;
        const select = document.getElementById('cfg-provider') as HTMLSelectElement;
        select.value = provider;
        this.updateProviderPresentation(provider);
        this.autoSave();
      });
    });

    // Provider change → update the card presentation, model placeholder + auto-save.
    document.getElementById('cfg-provider')!.addEventListener('change', () => {
      const p = (document.getElementById('cfg-provider') as HTMLSelectElement).value;
      this.updateProviderPresentation(p);
      this.autoSave();
    });

    // Theme selector
    document.querySelectorAll('.theme-option').forEach(el => {
      const selectTheme = () => {
        document.querySelectorAll('.theme-option').forEach(o => {
          const active = o === el;
          o.classList.toggle('active', active);
          o.setAttribute('aria-checked', String(active));
        });
        this.applyTheme(el.getAttribute('data-theme') || 'light');
        this.autoSave();
      };
      el.addEventListener('click', selectTheme);
      el.addEventListener('keydown', (event) => {
        const key = (event as KeyboardEvent).key;
        if (key === 'Enter' || key === ' ') {
          event.preventDefault();
          selectTheme();
          return;
        }
        if (key === 'ArrowRight' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowUp') {
          event.preventDefault();
          const options = [...document.querySelectorAll<HTMLElement>('.theme-option')];
          const index = options.indexOf(el as HTMLElement);
          const step = key === 'ArrowRight' || key === 'ArrowDown' ? 1 : -1;
          const next = options[(index + step + options.length) % options.length];
          next?.focus();
          next?.click();
        }
      });
    });

    // Add MCP server
    document.getElementById('cfg-add-mcp')?.addEventListener('click', () => this.showAddForm());
    document.getElementById('mcp-form-save')?.addEventListener('click', () => {
      this.addMcpServer();
      this.autoSave();
    });
    document.getElementById('mcp-form-cancel')?.addEventListener('click', () => this.hideAddForm());

    // Transport toggle — show command or url field
    const transportSelect = document.getElementById('mcp-form-transport') as HTMLSelectElement;
    transportSelect?.addEventListener('change', () => {
      const isStdio = transportSelect.value === 'stdio';
      document.getElementById('mcp-form-cmd-row')?.classList.toggle('hidden', !isStdio);
      document.getElementById('mcp-form-url-row')?.classList.toggle('hidden', isStdio);
    });

    // Auto-save on all input/select/checkbox changes
    const autoSaveSelectors = [
      '#cfg-provider', '#cfg-apikey', '#cfg-model', '#cfg-baseurl',
      '#cfg-language',
      '#cfg-city',
      '#cfg-fontsize', '#cfg-density',
      '#cfg-tool-fs', '#cfg-tool-cmd', '#cfg-tool-git', '#cfg-tool-browser',
      '#cfg-tavily-key', '#cfg-serper-key',
      '#cfg-streaming-render',
      '#cfg-permission-mode', '#cfg-perm-read', '#cfg-perm-write', '#cfg-perm-cmd', '#cfg-perm-git',
      '.cfg-skill-toggle'
    ];
    autoSaveSelectors.forEach(sel => {
      document.querySelectorAll(sel).forEach(el => {
        el.addEventListener('change', () => this.autoSave());
        if (el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'text') {
          el.addEventListener('input', () => {
            if (sel === '#cfg-model' || sel === '#cfg-baseurl') {
              const provider = (document.getElementById('cfg-provider') as HTMLSelectElement | null)?.value;
              if (provider) this.updateProviderPresentation(provider);
            }
            this.autoSave();
          });
        }
      });
    });

    // Keyboard: Esc to close
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.visible) {
        this.close();
      }
    });
  }

  // ── Theme ──

  private applyTheme(theme: string) {
    const resolved: 'light' | 'dark' = (
      theme === 'system'
        ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
        : (theme as 'light' | 'dark')
    );
    const prev = document.documentElement.getAttribute('data-theme');
    document.documentElement.setAttribute('data-theme', resolved);
    // Notify markdown.ts so it can re-render mermaid diagrams (their colors are baked
    // in at render time and ignore CSS variables) — but ONLY when the resolved theme
    // actually changed. loadToForm() calls applyTheme() on every settings open;
    // dispatching unconditionally would re-render every mermaid diagram on the page
    // (async, flash) each time the panel opens even when nothing changed.
    if (prev !== resolved) {
      document.dispatchEvent(new CustomEvent('pure:theme-changed', { detail: { theme: resolved } }));
    }
  }

  // ── Environment: IP-based city detection ──

  /** Detect the user's city from their IP address. In the Tauri app this runs
   * in Rust (detect_location, multi-backend: ipwho.is → ipinfo.io →
   * ip-api.com); in plain browser dev mode it probes the two HTTPS endpoints
   * directly (the browser blocks mixed http:// content on an https page).
   * Returns the composed "city, region, country" string or throws. */
  private async detectLocation(): Promise<string> {
    if (isTauriRuntime()) {
      const core = await loadTauriCore();
      const loc = await core?.invoke<string>('detect_location');
      if (!loc) throw new Error('empty location result');
      return loc;
    }
    for (const url of ['https://ipwho.is/', 'https://ipinfo.io/json']) {
      try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!resp.ok) continue;
        const data = await resp.json() as { city?: string; region?: string; regionName?: string; country?: string };
        const parts = [data.city, data.region ?? data.regionName, data.country]
          .map(s => (s ?? '').trim())
          .filter(Boolean);
        if (parts.length > 0) return parts.join(', ');
      } catch { /* try next backend */ }
    }
    throw new Error('all geolocation backends failed');
  }

  // ── Provider card presentation ──

  private updateProviderPresentation(provider: string): void {
    const def = providerDef(provider);
    if (!def) return;
    const cfg = loadConfig() ?? defaults();
    const selectedLabel = t(def.i18nKey);
    const modelInput = document.getElementById('cfg-model') as HTMLInputElement | null;
    const baseUrlInput = document.getElementById('cfg-baseurl') as HTMLInputElement | null;
    const currentModel = modelInput?.value.trim() || '';
    const currentBaseURL = baseUrlInput?.value.trim() || '';
    const previousDef = providerDef(cfg.provider);
    const previousDefault = defaultModelFor(cfg.provider);

    // Switching providers should not carry provider-specific defaults into the
    // next card, while deliberate custom model/endpoint values are preserved.
    if (cfg.provider !== provider) {
      if (modelInput && (!currentModel || currentModel === previousDefault)) {
        modelInput.value = '';
      }
      if (baseUrlInput && currentBaseURL && currentBaseURL === previousDef?.baseURL) {
        baseUrlInput.value = '';
      }
    }

    document.querySelectorAll<HTMLElement>('.provider-card').forEach(card => {
      const cardProvider = card.dataset.provider;
      const active = cardProvider === provider;
      card.classList.toggle('selected', active);
      card.setAttribute('aria-selected', String(active));
      const status = card.querySelector<HTMLElement>('[data-provider-status]');
      if (status) status.textContent = active ? t('llm.selected') : t('llm.chooseCard');
      const modelValue = card.querySelector<HTMLElement>('.provider-card-model-value');
      const cardDef = providerDef(cardProvider);
      if (modelValue && cardDef) {
        modelValue.textContent = active && modelInput?.value.trim()
          ? modelInput.value.trim()
          : cardDef.defaultModel;
      }
    });

    const title = document.getElementById('provider-config-title');
    const endpoint = document.getElementById('provider-config-endpoint');
    if (title) title.textContent = selectedLabel;
    if (endpoint) endpoint.textContent = baseUrlInput?.value.trim() || def.baseURL;
    if (modelInput) modelInput.placeholder = def.defaultModel;
  }

  // ── Load config into form ──

  private loadToForm() {
    // Re-apply translations for dynamic content
    applyTranslations();
    const cfg = loadConfig() || defaults();

    (document.getElementById('cfg-provider') as HTMLSelectElement).value = cfg.provider;
    this.updateProviderPresentation(cfg.provider);
    const keyInput = document.getElementById('cfg-apikey') as HTMLInputElement;
    keyInput.value = cfg.apiKey;
    if (isTauriRuntime() && cfg.hasApiKey) {
      // Key is stored in Rust secrets — never pull it back into the WebView.
      // Show a masked placeholder; typing a new key replaces it, and clearing
      // a field the user actually edited revokes it.
      delete keyInput.dataset.touched; // fresh session: user has not edited yet
      keyInput.setAttribute('data-i18n-placeholder', 'llm.apiKey.savedPlaceholder');
      keyInput.placeholder = t('llm.apiKey.savedPlaceholder');
    } else {
      keyInput.setAttribute('data-i18n-placeholder', 'llm.apiKey.placeholder');
      keyInput.placeholder = t('llm.apiKey.placeholder');
    }
    (document.getElementById('cfg-model') as HTMLInputElement).value = cfg.model;
    (document.getElementById('cfg-model') as HTMLInputElement).placeholder = defaultModelFor(cfg.provider);
    (document.getElementById('cfg-baseurl') as HTMLInputElement).value = cfg.baseURL;
    this.updateProviderPresentation(cfg.provider);
    (document.getElementById('cfg-language') as HTMLSelectElement).value = cfg.language;
    const cityEl = document.getElementById('cfg-city') as HTMLInputElement | null;
    if (cityEl) cityEl.value = cfg.city ?? '';

    const streamingRenderEl = document.getElementById('cfg-streaming-render') as HTMLInputElement | null;
    if (streamingRenderEl) streamingRenderEl.checked = cfg.streamingRender;

    (document.getElementById('cfg-fontsize') as HTMLSelectElement).value = cfg.fontSize;
    (document.getElementById('cfg-density') as HTMLSelectElement).value = cfg.density;

    const permMode = document.getElementById('cfg-permission-mode') as HTMLSelectElement | null;
    if (permMode) permMode.value = cfg.permissionMode;
    const permRead = document.getElementById('cfg-perm-read') as HTMLInputElement | null;
    if (permRead) permRead.checked = cfg.autoPermRead;
    const permWrite = document.getElementById('cfg-perm-write') as HTMLInputElement | null;
    if (permWrite) permWrite.checked = cfg.autoPermWrite;
    const permCmd = document.getElementById('cfg-perm-cmd') as HTMLInputElement | null;
    if (permCmd) permCmd.checked = cfg.autoPermCmd;
    const permGit = document.getElementById('cfg-perm-git') as HTMLInputElement | null;
    if (permGit) permGit.checked = cfg.autoPermGit;

    (document.getElementById('cfg-tool-fs') as HTMLInputElement).checked = cfg.toolFS;
    (document.getElementById('cfg-tool-cmd') as HTMLInputElement).checked = cfg.toolCmd;
    (document.getElementById('cfg-tool-git') as HTMLInputElement).checked = cfg.toolGit;
    (document.getElementById('cfg-tool-browser') as HTMLInputElement).checked = cfg.toolBrowser;
    const tavilyKeyEl = document.getElementById('cfg-tavily-key') as HTMLInputElement | null;
    if (tavilyKeyEl) tavilyKeyEl.value = cfg.tavilyApiKey ?? '';
    const serperKeyEl = document.getElementById('cfg-serper-key') as HTMLInputElement | null;
    if (serperKeyEl) serperKeyEl.value = cfg.serperApiKey ?? '';

    document.querySelectorAll('.cfg-skill-toggle').forEach(el => {
      const skill = el.getAttribute('data-skill');
      if (skill && cfg.skills[skill] !== undefined) {
        (el as HTMLInputElement).checked = cfg.skills[skill];
      }
    });

    // Re-render the Skill Hub installed list so toggles reflect the persisted
    // enabled state when the panel reopens.
    this.renderInstalledHubSkills();

    document.querySelectorAll('.theme-option').forEach(el => {
      const active = el.getAttribute('data-theme') === cfg.theme;
      el.classList.toggle('active', active);
      el.setAttribute('aria-checked', String(active));
    });
    this.applyTheme(cfg.theme);

    // ── MCP servers ──
    this.mcpServers = cfg.mcpServers ? [...cfg.mcpServers] : [];
    this.renderMcpServers();
  }

  // ── MCP Server Management ──

  private renderMcpServers() {
    const list = document.getElementById('mcp-server-list')!;
    if (this.mcpServers.length === 0) {
      list.innerHTML = `<div class="mcp-server-empty">${t('mcp.empty')}</div>`;
      return;
    }

    list.innerHTML = this.mcpServers.map((s, i) => {
      const label = s.transport === 'stdio'
        ? (s.command ? s.command.join(' ') : 'stdio')
        : (s.url || 'http');
      const builtin = isDefaultMcpServer(s.name)
        ? ` <span class="mcp-server-badge mcp-server-badge-builtin">${t('mcp.builtin')}</span>`
        : '';
      return `<div class="mcp-server-card" data-index="${i}">
        <div class="mcp-server-info">
          <div>
            <span class="mcp-server-name">${escapeHtml(s.name)}</span>
            <span class="mcp-server-badge">${escapeHtml(s.transport)}</span>${builtin}
            <div class="mcp-server-command">${escapeHtml(label)}</div>
          </div>
        </div>
        <button class="mcp-server-delete" data-index="${i}" title="${t('mcp.remove.title')}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>`;
    }).join('');

    // Bind delete buttons
    list.querySelectorAll('.mcp-server-delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.getAttribute('data-index') || '');
        if (!isNaN(idx)) this.removeMcpServer(idx);
      });
    });
  }

  private showAddForm() {
    const form = document.getElementById('mcp-add-form')!;
    form.classList.remove('hidden');
    (document.getElementById('mcp-form-name') as HTMLInputElement).value = '';
    (document.getElementById('mcp-form-command') as HTMLInputElement).value = '';
    (document.getElementById('mcp-form-url') as HTMLInputElement).value = '';
    (document.getElementById('mcp-form-transport') as HTMLSelectElement).value = 'stdio';
    document.getElementById('mcp-form-cmd-row')?.classList.remove('hidden');
    document.getElementById('mcp-form-url-row')?.classList.add('hidden');
    document.getElementById('mcp-form-name')?.focus();
  }

  private hideAddForm() {
    document.getElementById('mcp-add-form')!.classList.add('hidden');
  }

  private addMcpServer() {
    const name = (document.getElementById('mcp-form-name') as HTMLInputElement).value.trim();
    if (!name) {
      this.toast(t('toast.serverNameRequired'));
      return;
    }

    if (this.mcpServers.some(s => s.name === name)) {
      this.toast(t('toast.serverNameExists'));
      return;
    }

    const transport = (document.getElementById('mcp-form-transport') as HTMLSelectElement).value as 'stdio' | 'http';
    const server: PureConfig['mcpServers'][number] = { name, transport };

    if (transport === 'stdio') {
      const cmd = (document.getElementById('mcp-form-command') as HTMLInputElement).value.trim();
      if (!cmd) {
        this.toast(t('toast.commandRequired'));
        return;
      }
      server.command = cmd.split(/\s+/);
    } else {
      const url = (document.getElementById('mcp-form-url') as HTMLInputElement).value.trim();
      if (!url) {
        this.toast(t('toast.urlRequired'));
        return;
      }
      server.url = url;
    }

    this.mcpServers.push(server);
    this.renderMcpServers();
    this.hideAddForm();
  }

  private removeMcpServer(index: number) {
    this.mcpServers.splice(index, 1);
    this.renderMcpServers();
  }

  // ── Skill Hub installed-list rendering (shared by bindActions + loadToForm) ──

  /** Render the installed third-party skills (toggle + remove per card).
   * Called on settings open and after every install/remove/toggle. */
  private renderInstalledHubSkills(): void {
    const hubInstalledEl = document.getElementById('hub-installed');
    if (!hubInstalledEl) return;
    const skills = (loadConfig() ?? defaults()).hubSkills ?? [];
    if (skills.length === 0) {
      hubInstalledEl.innerHTML = '';
      return;
    }
    hubInstalledEl.innerHTML = `<div class="hub-section-label" data-i18n="hub.installed">已安装</div>` + skills.map((s, i) => `
      <div class="skill-card hub-installed-card" data-index="${i}">
        <div class="skill-card-header">
          <span class="skill-name">${escapeHtml(s.name)}</span>
          <span class="hub-source">${escapeHtml(s.source)}</span>
          <label class="toggle"><input type="checkbox" class="cfg-hub-skill-toggle" data-hub-skill="${i}" ${s.enabled ? 'checked' : ''} /><span class="toggle-slider"></span></label>
        </div>
        <p class="skill-desc">${escapeHtml(s.description || '')}</p>
        <button class="hub-remove-btn" data-index="${i}" data-i18n="hub.remove">移除</button>
      </div>`).join('');
    applyTranslations();
  }

  // ── Gather form values ──

  private gatherForm(): PureConfig {
    const skills: Record<string, boolean> = {};
    document.querySelectorAll('.cfg-skill-toggle').forEach(el => {
      const skill = el.getAttribute('data-skill');
      if (skill) skills[skill] = (el as HTMLInputElement).checked;
    });

    // Third-party hub skills: carry the persisted list through, syncing each
    // entry's enabled state from its toggle (the remove button mutates the
    // list in place before this runs).
    const hubSkills = [...((loadConfig() ?? defaults()).hubSkills ?? [])];
    document.querySelectorAll<HTMLInputElement>('.cfg-hub-skill-toggle').forEach(el => {
      const idx = parseInt(el.dataset.hubSkill || '', 10);
      if (!isNaN(idx) && hubSkills[idx]) hubSkills[idx] = { ...hubSkills[idx], enabled: el.checked };
    });

    return {
      provider: (document.getElementById('cfg-provider') as HTMLSelectElement).value as PureConfig['provider'],
      apiKey: (document.getElementById('cfg-apikey') as HTMLInputElement).value.trim(),
      model: (document.getElementById('cfg-model') as HTMLInputElement).value.trim(),
      baseURL: (document.getElementById('cfg-baseurl') as HTMLInputElement).value.trim(),
      language: (document.getElementById('cfg-language') as HTMLSelectElement).value as PureConfig['language'],
      city: (document.getElementById('cfg-city') as HTMLInputElement | null)?.value.trim() ?? '',
      theme: (document.querySelector('.theme-option.active')?.getAttribute('data-theme') || 'light') as PureConfig['theme'],
      fontSize: (document.getElementById('cfg-fontsize') as HTMLSelectElement).value as PureConfig['fontSize'],
      density: (document.getElementById('cfg-density') as HTMLSelectElement).value as PureConfig['density'],
      hasApiKey: (loadConfig() ?? defaults()).hasApiKey,
      permissionMode: (document.getElementById('cfg-permission-mode') as HTMLSelectElement | null)?.value as PureConfig['permissionMode'] || 'confirm',
      autoPermRead: (document.getElementById('cfg-perm-read') as HTMLInputElement | null)?.checked ?? true,
      autoPermWrite: (document.getElementById('cfg-perm-write') as HTMLInputElement | null)?.checked ?? false,
      autoPermCmd: (document.getElementById('cfg-perm-cmd') as HTMLInputElement | null)?.checked ?? false,
      autoPermGit: (document.getElementById('cfg-perm-git') as HTMLInputElement | null)?.checked ?? true,
      toolFS: (document.getElementById('cfg-tool-fs') as HTMLInputElement).checked,
      toolCmd: (document.getElementById('cfg-tool-cmd') as HTMLInputElement).checked,
      toolGit: (document.getElementById('cfg-tool-git') as HTMLInputElement).checked,
      toolBrowser: (document.getElementById('cfg-tool-browser') as HTMLInputElement).checked,
      tavilyApiKey: (document.getElementById('cfg-tavily-key') as HTMLInputElement | null)?.value.trim() ?? '',
      serperApiKey: (document.getElementById('cfg-serper-key') as HTMLInputElement | null)?.value.trim() ?? '',
      skills,
      hubSkills,
      mcpServers: [...this.mcpServers],
      streamingRender: (document.getElementById('cfg-streaming-render') as HTMLInputElement | null)?.checked ?? true,
      // The composer's mode selector lives outside this form — carry its value
      // through so a settings save never silently resets a user's mode choice.
      taskMode: (loadConfig() ?? defaults()).taskMode,
      // Preserve the current config version (defaults() always sets it, so the
      // merged value is never undefined — keep the spread rather than a bare
      // constant so a future v3 bump survives the round-trip).
      configVersion: (loadConfig() ?? defaults()).configVersion,
    };
  }

  // ── Auto-save (silent, no close, no toast) ──

  private autoSave() {
    const prev = loadConfig() ?? defaults();
    const cfg = this.gatherForm();
    cfg.hasApiKey = prev.hasApiKey;

    if (!cfg.model) {
      cfg.model = defaultModelFor(cfg.provider);
    }

    if (isTauriRuntime()) {
      // Desktop: the key is owned by Rust secrets, never localStorage.
      const keyInput = document.getElementById('cfg-apikey') as HTMLInputElement;
      if (cfg.apiKey) {
        void storeSecretInRust(cfg.apiKey);
        cfg.hasApiKey = true;
      } else if (cfg.hasApiKey && keyInput.dataset.touched === '1') {
        // User edited the field and cleared it → revoke the stored key.
        void revokeSecretFromRust();
        cfg.hasApiKey = false;
        delete keyInput.dataset.touched;
      }
      cfg.apiKey = ''; // never persist the raw key
    } else {
      cfg.hasApiKey = !!cfg.apiKey;
    }

    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
    // Drop the cached config so the next loadConfig() re-reads the saved state.
    invalidateConfigCache();

    updateLanguage(cfg.language as I18nLanguage);
    this.applyTheme(cfg.theme);

    document.documentElement.style.setProperty('--font-size',
      cfg.fontSize === 'small' ? '13px' : cfg.fontSize === 'large' ? '15px' : '14px');
    document.documentElement.style.setProperty('--spacing',
      cfg.density === 'compact' ? '8px' : cfg.density === 'spacious' ? '16px' : '12px');

    this.onSave();
  }

  // ── Toast ──

  private toast(msg: string) {
    const el = document.getElementById('toast')!;
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout((this as any)._toastTimer);
    (this as any)._toastTimer = setTimeout(() => el.classList.add('hidden'), 2000);
  }
}
