// src/ui/settings.ts
// Modal settings panel. Lazy-loaded on first open (see src/ui/main.ts) so the
// eager startup bundle stays lean; the config model it edits lives in
// ./config.ts (needed at startup by chat.ts / main.ts) and provider defaults
// come from ../shared/providers.ts.

import { fetchAndDisplayVersion, checkForUpdatesManual } from './updater';
import { escapeHtml } from '../shared/html';
import { t, updateLanguage, applyTranslations, type Language as I18nLanguage } from '../shared/i18n';
import { isTauriRuntime, loadTauriCore } from '../shared/tauri';
import { formatBytes } from '../shared/format';
import { memoryStore } from './memoryStore';
import { EVOLUTION_DEFAULTS, healthScore, lifecycleOf, resolveEvolutionConfig } from '../adapter/memory/evolution';
import type { MemoryEntry } from '../adapter/memory/IMemoryStore';
import { buildMemoryExportJson, buildMemoryExportMarkdown, parseMemoryImport } from './memoryTransfer';
import { showToastHtml } from '../shared/toast';
import { buildExportSavedToast } from './statsExportToast';
import {
  customProviderFor,
  defaultModelFor,
  isCustomProviderId,
  OLLAMA_PRESET,
  OPENAI_PRESET,
  OPENROUTER_PRESET,
  NVIDIA_PRESET,
  providerDef,
  type CustomProvider,
} from '../shared/providers';
import { effectiveProxyUrl, isUsableProxyUrl, normalizeProxyConfig, normalizeProxyList } from '../shared/proxy';
import { probeLlmEndpoint } from '../shared/llmProbe';
import {
  STORAGE_KEY,
  defaults,
  hasConfiguredKey,
  invalidateConfigCache,
  isDefaultMcpServer,
  loadConfig,
  SCRAPLING_MCP_PRESET,
  revokeCustomSecretFromRust,
  revokeSecretFromRust,
  storeCustomSecretInRust,
  storeSecretInRust,
  customSecretKey,
  modelListForProvider,
  normalizeProviderModels,
  uniqueModels,
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

/**
 * AbortSignal.timeout needs Safari 16+ (macOS 13). Older WKWebView versions
 * throw a TypeError here, which would make every connection test / fetch
 * fail with a generic network error — fall back to AbortController + setTimeout.
 */
function abortSignal(ms: number): AbortSignal {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), ms);
  return ctrl.signal;
}

export class SettingsPanel {
  private onSave: () => void;
  private toastTimer: ReturnType<typeof setTimeout> | undefined;
  private onOpen?: () => void;
  private onClose?: () => void;
  private currentCategory: string = 'general';
  private visible = false;
  private focusBeforeOpen: HTMLElement | null = null;
  private mcpServers: PureConfig['mcpServers'] = [];
  /** Bound in the constructor; refreshes the paste-file footprint on open. */
  private refreshTmpUsage: () => Promise<void> = async () => {};
  /**
   * Provider card being edited whose activation is pending an explicit user
   * action (card click or "启用此供应商"). While set, autoSave keeps the
   * previous active provider, so merely typing a Base URL / model never
   * promotes the card to the active LLM.
   */
  private pendingActivation: string | null = null;
  /** Last card the config panel rendered for — field prefill only runs on a
   *  real card switch, never on live keystrokes in the same card. */
  private presentedProvider: string | null = null;
  /** Pending debounced save (text-input keystrokes only). */
  private autoSaveTimer: ReturnType<typeof setTimeout> | undefined;

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
    // Flush any pending debounced save first — the last keystrokes in a text
    // field must not be lost when the panel closes within the debounce window.
    this.flushAutoSave();
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
    if (category !== 'llm') {
      this.setProviderV4Drawer('provider', false);
      this.setProviderV4Drawer('models', false);
      this.setProviderV4Drawer('connection', false);
    }
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

    // 记忆库是只读仪表盘：切换到该页时重新渲染，反映最新的进化状态
    // （比如刚结束的会话刚写入新记忆 / 某条被取代降级）。
    if (category === 'memory') this.renderMemoryDashboard();
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

    // Provider cards (built-in + dynamic custom) + hidden compatibility select
    // share one source of truth. Delegated on the grid so cards rendered later
    // (custom providers) work without rebinding.
    const providerV4Shell = document.getElementById('provider-v4-shell');
    providerV4Shell?.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      const openProvider = target.closest<HTMLElement>('[data-open-provider]');
      if (openProvider) {
        event.preventDefault();
        this.setProviderV4Drawer('provider');
        return;
      }
      if (target.closest('[data-close-provider]')) {
        this.setProviderV4Drawer('provider', false);
        return;
      }
      const openModels = target.closest<HTMLElement>('[data-open-models]');
      if (openModels) {
        event.preventDefault();
        this.setProviderV4Drawer('models');
        return;
      }
      if (target.closest('[data-close-models]')) {
        this.setProviderV4Drawer('models', false);
        return;
      }
      if (target.closest('[data-close-connection]')) {
        this.setProviderV4Drawer('connection', false);
        return;
      }
      const openConnection = target.closest<HTMLElement>('[data-open-connection]');
      if (openConnection) {
        event.preventDefault();
        this.setProviderV4Drawer('connection');
      }
    });

    document.getElementById('provider-card-grid')?.addEventListener('click', (event) => {
      // Per-card delete (×) takes precedence.
      const removeBtn = (event.target as HTMLElement).closest<HTMLElement>('.provider-card-remove');
      if (removeBtn) {
        event.stopPropagation();
        this.removeCustomProvider(removeBtn.dataset.removeProvider || '');
        return;
      }
      const card = (event.target as HTMLElement).closest<HTMLElement>('.provider-card');
      const provider = card?.dataset.provider;
      if (!provider) return;
      this.selectProvider(provider);
    });

    // "Enable this provider" button — explicit activation for a card whose
    // config is open but which isn't the active LLM yet.
    document.getElementById('provider-activate-btn')?.addEventListener('click', () => {
      const id = (document.getElementById('cfg-provider') as HTMLSelectElement).value;
      this.selectProvider(id);
    });

    // Provider change → update the card presentation, model placeholder + auto-save.
    document.getElementById('cfg-provider')!.addEventListener('change', () => {
      const p = (document.getElementById('cfg-provider') as HTMLSelectElement).value;
      this.selectProvider(p);
    });

    document.getElementById('provider-v4-test-btn')?.addEventListener('click', () => void this.testProviderConnection());

    // ── Multi-model editor (custom providers): add / remove / set-default ──
    // Enter in the model input (or the ＋ 添加 button) commits the typed model
    // into the provider's model list and makes it the default. Clicking a chip
    // switches the default; the × on a chip removes that model.
    document.getElementById('cfg-add-model-btn')?.addEventListener('click', () => this.addModel());
    document.getElementById('cfg-clear-models-btn')?.addEventListener('click', () => this.clearModels());
    (document.getElementById('cfg-model-add') as HTMLInputElement | null)?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.addModel();
      }
    });
    document.getElementById('cfg-model-list')?.addEventListener('click', (e) => {
      const remove = (e.target as HTMLElement).closest<HTMLElement>('.provider-model-chip-remove');
      if (remove) {
        e.stopPropagation();
        this.removeModel(remove.getAttribute('data-remove') || '');
        return;
      }
      const chip = (e.target as HTMLElement).closest<HTMLElement>('.provider-model-chip');
      if (chip) this.setDefaultModel(chip.getAttribute('data-model') || '');
    });

    // ── Custom providers: quick presets, delete, live name edit ──
    document.getElementById('cfg-fetch-models-btn')?.addEventListener('click', () => this.fetchProviderModels());
    document.getElementById('provider-delete-btn')?.addEventListener('click', () => this.removeSelectedCustomProvider());
    // Quick-preset chips (用户自定义 / OpenAI / OpenRouter / NVIDIA / Ollama):
    // one click adds the provider and selects it — the key (if any) is entered
    // in the config card below, prompted by the toast.
    document.querySelectorAll<HTMLElement>('.provider-preset-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const slug = chip.dataset.preset || '';
        if (slug === 'custom') {
          this.addBlankCustomProvider();
          return;
        }
        const preset = this.customPresetFor(slug);
        if (preset) this.addCustomPreset(preset);
      });
    });
    const customNameEdit = document.getElementById('cfg-custom-name-edit') as HTMLInputElement | null;
    customNameEdit?.addEventListener('input', () => {
      // Re-label the selected card as the user types the custom name.
      const provider = (document.getElementById('cfg-provider') as HTMLSelectElement).value;
      if (!isCustomProviderId((loadConfig() ?? defaults()).customProviders, provider)) return;
      const name = customNameEdit.value.trim();
      if (name) {
        const nameEl = document.querySelector<HTMLElement>('.provider-card.selected .provider-card-name');
        if (nameEl) nameEl.textContent = name;
      }
      this.debouncedAutoSave();
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
    document.getElementById('cfg-add-scrapling-mcp')?.addEventListener('click', () => {
      this.addScraplingMcp();
      this.autoSave();
    });
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

    // ── Proxy: test the configured URL before relying on it — a malformed
    // address must not silently break every subsequent LLM / tool request. ──
    document.getElementById('cfg-proxy-test-btn')?.addEventListener('click', () => void this.testProxyConnection());

    // Auto-save on all input/select/checkbox changes
    const autoSaveSelectors = [
      '#cfg-provider', '#cfg-apikey', '#cfg-model', '#cfg-baseurl',
      '#cfg-imagegen', '#cfg-imagegen-model',
      '#cfg-language',
      '#cfg-city',
      '#cfg-fontsize', '#cfg-density',
      '#cfg-tool-fs', '#cfg-tool-cmd', '#cfg-tool-git', '#cfg-tool-browser',
      '#cfg-tavily-key', '#cfg-serper-key',
      '#cfg-mcp-exclude-prefixes',
      '#cfg-proxy-enabled', '#cfg-proxy-llm', '#cfg-proxy-tools', '#cfg-proxy-url', '#cfg-proxy-bypass-providers', '#cfg-proxy-bypass-models',
      '#cfg-streaming-render',
      '#cfg-permission-mode', '#cfg-perm-read', '#cfg-perm-write', '#cfg-perm-cmd', '#cfg-perm-git',
      '.cfg-skill-toggle',
      // Memory evolution thresholds (number inputs save on change/blur).
      '#cfg-mem-half-life', '#cfg-mem-active-min', '#cfg-mem-dormant-max',
      '#cfg-mem-delete-floor', '#cfg-mem-grace', '#cfg-mem-supersede-sim'
    ];
    autoSaveSelectors.forEach(sel => {
      document.querySelectorAll(sel).forEach(el => {
        el.addEventListener('change', () => this.autoSave());
        // Password inputs (the API key field) get the same debounced per-keystroke
        // save as text inputs — otherwise a typed key only persists on blur, and
        // the connection state looks stale while the user is still typing.
        if (el.tagName === 'INPUT' && ((el as HTMLInputElement).type === 'text' || (el as HTMLInputElement).type === 'password')) {
          el.addEventListener('input', () => {
            if (sel === '#cfg-model' || sel === '#cfg-baseurl') {
              const provider = (document.getElementById('cfg-provider') as HTMLSelectElement | null)?.value;
              if (provider) this.updateProviderPresentation(provider);
            }
            // Per-keystroke writes are debounced: autoSave() rebuilds the
            // whole form + writes localStorage (+ calls the Rust secret store
            // when a key is present), so a burst of typing must coalesce into
            // one save after the user pauses. Discrete actions (change / click
            // / select) still autoSave() immediately; close() flushes.
            this.debouncedAutoSave();
          });
        }
      });
    });

    // ── Memory forgetting-speed: reset to engine defaults ──
    document.getElementById('cfg-mem-reset-btn')?.addEventListener('click', () => {
      this.loadEvolutionToForm();
      this.autoSave();
      this.toast(t('memory.resetDone'));
      // The reset landed on the memory page — reflect it in the dashboard
      // and diagnostics (custom markers clear).
      this.renderMemoryDashboard();
      this.renderMemoryDiagnostics();
    });

    // ── Memory diagnostics: run decay now（按当前阈值重算全部记忆）──
    document.getElementById('cfg-mem-decay-btn')?.addEventListener('click', async () => {
      const btn = document.getElementById('cfg-mem-decay-btn') as HTMLButtonElement | null;
      if (btn) btn.disabled = true;
      try {
        // olderThan = 0：无视"闲置超过阈值才处理"的门槛，立即按当前生效的
        // 遗忘速度重算全部记忆 —— 调整阈值后手动触发即可看到新分数落盘。
        await memoryStore.decay(0);
        this.toast(t('memory.diag.ran'));
      } catch (err) {
        console.error('[pure] manual memory decay failed:', err);
        this.toast(t('memory.diag.runFailed'));
      } finally {
        if (btn) btn.disabled = false;
        this.renderMemoryDiagnostics();
        this.renderMemoryDashboard();
      }
    });

    // ── Memory export/import（记忆页导出/导入，迁移到新机器）──
    document.getElementById('cfg-mem-export-json')?.addEventListener('click', () => this.exportMemoryLibrary('json'));
    document.getElementById('cfg-mem-export-md')?.addEventListener('click', () => this.exportMemoryLibrary('markdown'));
    const importBtn = document.getElementById('cfg-mem-import');
    const importFile = document.getElementById('cfg-mem-import-file') as HTMLInputElement | null;
    importBtn?.addEventListener('click', () => importFile?.click());
    // The hidden input persists across clicks — reset value so re-importing the
    // SAME file after a change fires change() again (File inputs don't repeat
    // on an identical selection otherwise).
    importFile?.addEventListener('change', () => {
      const file = importFile.files?.[0];
      importFile.value = '';
      if (file) void this.importMemoryLibrary(file);
    });

    // Memory threshold edits: out-of-range typed values snap back to the
    // field's default (the spinner's min/max don't constrain typed input),
    // and the dashboard above re-renders with the new thresholds so the
    // health bars reflect the change immediately.
    const MEM_EVO_IDS = ['cfg-mem-half-life', 'cfg-mem-active-min', 'cfg-mem-dormant-max', 'cfg-mem-delete-floor', 'cfg-mem-grace', 'cfg-mem-supersede-sim'];
    for (const id of MEM_EVO_IDS) {
      const el = document.getElementById(id) as HTMLInputElement | null;
      if (!el) continue;
      el.addEventListener('change', () => {
        const v = parseFloat(el.value);
        const min = el.min ? parseFloat(el.min) : -Infinity;
        const max = el.max ? parseFloat(el.max) : Infinity;
        if (!Number.isFinite(v) || v < min || v > max) {
          this.loadEvolutionToForm(); // snap back to persisted/default value
        }
        this.renderMemoryDashboard();
        this.renderMemoryDiagnostics(); // custom markers + effective params update
      });
    }

    // Background memory decay (src/ui/memoryDecayTimer.ts) fires after the 1h
    // throttle window even without a new chat session. When it runs while the
    // memory page is open, refresh the diagnostics + dashboard so the last-run
    // time / next-run estimate / health bars stay truthful.
    document.addEventListener('pure:memory-decay-run', () => {
      if (!this.visible) return;
      this.renderMemoryDiagnostics();
      this.renderMemoryDashboard();
    });

    // Keyboard: close the active Drawer before leaving Settings.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !this.visible) return;
      const shell = document.getElementById('provider-v4-shell');
      if (shell?.classList.contains('models-drawer-open')) {
        this.setProviderV4Drawer('models', false);
        return;
      }
      const drawer = document.querySelector<HTMLElement>('#provider-v4-provider-drawer:not([hidden]), #provider-v4-connection-drawer:not([hidden])');
      if (drawer) {
        this.setProviderV4Drawer(drawer.id === 'provider-v4-provider-drawer' ? 'provider' : 'connection', false);
        return;
      }
      this.close();
    });
  }

  // ── Provider v4 drawers ──

  private setProviderV4Drawer(kind: 'provider' | 'models' | 'connection', open?: boolean): void {
    const shell = document.getElementById('provider-v4-shell');
    if (!shell) return;
    const ids: Record<'provider' | 'models' | 'connection', string> = {
      provider: 'provider-v4-provider-drawer',
      models: 'provider-v4-model-drawer',
      connection: 'provider-v4-connection-drawer',
    };
    const drawer = document.getElementById(ids[kind]);
    if (!drawer) return;
    const modelBody = document.getElementById('provider-v4-model-drawer-body');
    const nextOpen = kind === 'models'
      ? (open ?? !shell.classList.contains('models-drawer-open'))
      : (open ?? drawer.hasAttribute('hidden'));
    const kinds: Array<'provider' | 'models' | 'connection'> = ['provider', 'models', 'connection'];

    const updateModelToggle = (expanded: boolean): void => {
      const toggle = shell.querySelector<HTMLElement>('.provider-v4-model-drawer-toggle');
      if (!toggle) return;
      toggle.dataset.i18n = expanded ? 'llm.model.collapse' : 'llm.model.expand';
      toggle.textContent = t(expanded ? 'llm.model.collapse' : 'llm.model.expand');
    };

    if (nextOpen) {
      // Default + Drawer is exclusive: one editing surface is visible at a time.
      for (const current of kinds) {
        const currentDrawer = document.getElementById(ids[current]);
        const currentOpen = current === kind;
        if (current === 'models') {
          modelBody?.toggleAttribute('hidden', !currentOpen);
          updateModelToggle(currentOpen);
        } else {
          currentDrawer?.toggleAttribute('hidden', !currentOpen);
        }
        shell.classList.toggle(`${current}-drawer-open`, currentOpen);
        shell.querySelectorAll<HTMLElement>(`[data-open-${current}]`).forEach(trigger => {
          trigger.setAttribute('aria-expanded', String(currentOpen));
        });
      }
      return;
    }

    if (kind === 'models') {
      modelBody?.toggleAttribute('hidden', true);
      updateModelToggle(false);
    } else {
      drawer.toggleAttribute('hidden', true);
    }
    shell.classList.remove(`${kind}-drawer-open`);
    shell.querySelectorAll<HTMLElement>(`[data-open-${kind}]`).forEach(trigger => {
      trigger.setAttribute('aria-expanded', 'false');
    });
  }

  /** Test the currently selected provider's endpoint without changing the
   * active provider. Any HTTP response proves the endpoint is reachable;
   * authentication errors are reported as reachable-but-not-authorized rather
   * than falsely treating a working server as offline. */
  private async testProviderConnection(): Promise<void> {
    const btn = document.getElementById('provider-v4-test-btn') as HTMLButtonElement | null;
    const status = document.getElementById('provider-v4-connection-status');
    const provider = (document.getElementById('cfg-provider') as HTMLSelectElement | null)?.value || '';
    const cfg = loadConfig() ?? defaults();
    const custom = customProviderFor(cfg.customProviders ?? [], provider);
    const def = providerDef(provider);
    const baseURL = ((document.getElementById('cfg-baseurl') as HTMLInputElement | null)?.value.trim()
      || custom?.baseURL
      || def?.baseURL
      || '').replace(/\/+$/, '');
    if (!baseURL) {
      if (status) {
        status.textContent = t('llm.connection.notConfigured');
        status.dataset.state = 'error';
      }
      this.toast(t('llm.custom.needURL'));
      return;
    }
    if (btn) {
      btn.disabled = true;
      btn.textContent = t('llm.connection.testing');
    }
    if (status) {
      status.textContent = t('llm.connection.testing');
      status.dataset.state = 'testing';
    }
    const apiKey = (document.getElementById('cfg-apikey') as HTMLInputElement | null)?.value.trim() || '';
    // One probe contract on both surfaces: desktop runs it in Rust through the
    // SAME network path real chats use (reqwest + configured proxy + secrets
    // resolution), browser dev mode runs the fetch mirror with identical
    // semantics (only 2xx succeeds, 401/403 = key rejected, first /models
    // probe decides). A result that says ok here is a result that will work
    // when chatting.
    const started = performance.now();
    let probe: { ok: boolean; status?: number; latencyMs?: number; error?: string };
    if (isTauriRuntime()) {
      const proxy = normalizeProxyConfig(loadConfig()?.proxy);
      const model = (document.getElementById('cfg-model') as HTMLInputElement | null)?.value.trim()
        || custom?.defaultModel || defaultModelFor(provider);
      try {
        const core = await loadTauriCore();
        if (!core) throw new Error('Tauri runtime unavailable');
        probe = await core.invoke('test_llm_connection', {
          baseUrl: baseURL,
          apiKey,
          secretKey: custom ? customSecretKey(custom.id) : undefined,
          proxyUrl: effectiveProxyUrl(proxy, 'llm') ?? '',
          proxyBypassProviders: proxy?.bypassProviders ?? [],
          proxyBypassModels: proxy?.bypassModels ?? [],
          provider,
          model,
        });
      } catch (err) {
        // Command-level failure (e.g. invalid proxy URL) — surface the real
        // reason instead of a generic "cannot connect".
        const message = (err as Error)?.message || String(err);
        if (status) {
          status.textContent = t('llm.connection.testFailed');
          status.dataset.state = 'error';
        }
        this.toast(`${t('llm.connection.testFailed')}：${message}`);
        return;
      }
    } else {
      probe = await probeLlmEndpoint(baseURL, apiKey);
    }
    const elapsed = Math.max(0, Math.round(performance.now() - started));
    if (probe.ok) {
      if (status) {
        status.textContent = t('llm.connection.testOk').replace('{ms}', String(probe.latencyMs ?? elapsed));
        status.dataset.state = 'active';
      }
      this.toast(t('llm.connection.testOk').replace('{ms}', String(probe.latencyMs ?? elapsed)));
    } else {
      if (status) {
        status.textContent = t('llm.connection.testFailed');
        status.dataset.state = 'error';
      }
      this.toast(`${t('llm.connection.testFailed')}：${probe.error || 'unknown error'}`);
    }
    if (btn) {
      btn.disabled = false;
      btn.textContent = t('llm.connection.test');
    }
  }

  // ── Proxy connection test ──

  /**
   * Validate the proxy URL format locally, then (desktop) ask Rust to build
   * the real client and probe endpoints through it. The Rust side enforces
   * the same scheme allowlist and reports dead proxies / unreachable hosts
   * with the actual error — instead of the user discovering later that every
   * LLM call fails through a broken address.
   */
  private async testProxyConnection(): Promise<void> {
    const btn = document.getElementById('cfg-proxy-test-btn') as HTMLButtonElement | null;
    const url = (document.getElementById('cfg-proxy-url') as HTMLInputElement).value.trim();
    if (!url) {
      this.toast(t('proxy.test.empty'));
      return;
    }
    // Local format check: catch bad schemes (e.g. `socks5:localhost:1080`
    // without //) before any network call — mirrors the Rust allowlist.
    if (!isUsableProxyUrl(url)) {
      this.toast(t('proxy.test.invalid'));
      return;
    }
    if (!isTauriRuntime()) {
      // Browser fetch cannot route through a proxy — only the desktop app
      // exercises the real client. Be honest instead of pretending success.
      this.toast(t('proxy.test.browserOnly'));
      return;
    }
    if (btn) {
      btn.disabled = true;
      btn.textContent = t('proxy.testing');
    }
    try {
      const core = await loadTauriCore();
      const reached = await core?.invoke<string>('test_proxy', { proxyUrl: url });
      this.toast(t('proxy.test.ok') + (reached ? `：${reached}` : ''));
    } catch (err) {
      console.warn('[pure] proxy test failed:', err);
      this.toast(t('proxy.test.fail') + '：' + ((err as Error)?.message || String(err)));
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = t('proxy.test');
      }
    }
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
      const proxy = normalizeProxyConfig(loadConfig()?.proxy);
      const loc = await core?.invoke<string>('detect_location', { proxyUrl: effectiveProxyUrl(proxy, 'tools') });
      if (!loc) throw new Error('empty location result');
      return loc;
    }
    for (const url of ['https://ipwho.is/', 'https://ipinfo.io/json']) {
      try {
        const resp = await fetch(url, { signal: abortSignal(8000) });
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

  /**
   * A provider is "configured" when it can serve requests out of the box:
   * built-ins always count (they carry their own endpoint/model), custom
   * providers need a Base URL + at least one model. An unconfigured custom
   * card must NEVER become the active LLM on its own.
   */
  private isKnownProvider(provider: string): boolean {
    return !!providerDef(provider) || ['openai', 'openrouter', 'nvidia', 'ollama'].includes(provider);
  }

  private isProviderConfigured(provider: string): boolean {
    const customs = (loadConfig() ?? defaults()).customProviders ?? [];
    const custom = customProviderFor(customs, provider);
    if (custom) return !!custom.baseURL && !!custom.defaultModel;
    return !!providerDef(provider);
  }

  /**
   * Select a card: open its config for editing and, only when it is fully
   * configured, make it the active LLM. A bare "用户自定义" card is opened for
   * editing WITHOUT switching providers — the user configures it first and
   * clicks it again (or the "启用此供应商" button) to activate it.
   */
  private selectProvider(id: string): void {
    const prevActive = (loadConfig() ?? defaults()).provider;
    const select = document.getElementById('cfg-provider') as HTMLSelectElement;
    select.value = id;
    this.updateProviderPresentation(id);
    if (!this.isProviderConfigured(id)) {
      this.pendingActivation = id;
      this.setProviderV4Drawer('provider', false);
      this.setProviderV4Drawer('connection', true);
      this.toast(t('llm.custom.configureFirst'));
      return;
    }
    this.pendingActivation = null;
    this.autoSave();
    this.updateProviderPresentation(id);
    if (id !== prevActive) {
      const nameEl = document.querySelector<HTMLElement>(`.provider-card[data-provider="${id}"] .provider-card-name`);
      const name = nameEl?.textContent ?? id;
      this.toast(t('llm.custom.enabledToast').replace('{name}', name));
    }
    this.setProviderV4Drawer('provider', false);
  }

  private updateProviderPresentation(provider: string): void {
    const cfg = loadConfig() ?? defaults();
    const customs = cfg.customProviders ?? [];
    const custom = customProviderFor(customs, provider);
    const def = providerDef(provider);
    const selectedLabel = custom?.name ?? (def ? t(def.i18nKey) : provider);
    const modelInput = document.getElementById('cfg-model') as HTMLInputElement | null;
    const baseUrlInput = document.getElementById('cfg-baseurl') as HTMLInputElement | null;
    const currentModel = modelInput?.value.trim() || '';
    const currentBaseURL = baseUrlInput?.value.trim() || '';
    const previousDef = providerDef(cfg.provider);
    const previousCustom = customProviderFor(customs, cfg.provider);
    const previousDefault = previousCustom?.defaultModel ?? defaultModelFor(cfg.provider);

    // Switching to a DIFFERENT card should not carry provider-specific defaults
    // into the next card, while deliberate custom model/endpoint values are
    // preserved. Running on every keystroke of the SAME card would clobber what
    // the user is typing (e.g. an unconfigured card still being edited), so the
    // prefill only fires when the panel actually switches which card it shows.
    if (provider !== this.presentedProvider) {
      if (modelInput && (!currentModel || currentModel === previousDefault)) {
        modelInput.value = '';
      }
      const previousEndpoint = previousCustom?.baseURL ?? previousDef?.baseURL;
      if (baseUrlInput && currentBaseURL && currentBaseURL === previousEndpoint) {
        baseUrlInput.value = '';
      }
      // Custom providers always carry a required base URL + default model —
      // prefill the editable fields so the config card reads back their values.
      const modelAddInput = document.getElementById('cfg-model-add') as HTMLInputElement | null;
      if (modelAddInput) modelAddInput.value = '';
      if (custom) {
        if (modelInput) modelInput.value = custom.defaultModel;
        if (baseUrlInput) baseUrlInput.value = custom.baseURL;
      } else if (modelInput) {
        const providerModels = modelListForProvider(cfg, provider);
        modelInput.value = provider === cfg.provider
          ? (cfg.model.trim() || providerModels[0] || defaultModelFor(provider))
          : (cfg.providerModels?.[provider]?.[0] || providerModels[0] || defaultModelFor(provider));
      }
      // Refresh the model list only on a real card switch — never on live
      // keystrokes inside the same card (it would churn the DOM while typing).
      this.renderModelList(provider);
    }

    document.querySelectorAll<HTMLElement>('.provider-card').forEach(card => {
      const cardProvider = card.dataset.provider;
      const active = cardProvider === provider;
      const isActive = cardProvider === cfg.provider;
      card.classList.toggle('selected', active);
      card.classList.toggle('provider-card-active', isActive);
      card.setAttribute('aria-selected', String(isActive));
      const status = card.querySelector<HTMLElement>('[data-provider-status]');
      if (status) {
        status.textContent = isActive ? t('llm.selected')
          : active ? t('llm.custom.editing')
          : t('llm.chooseCard');
      }
      const modelValue = card.querySelector<HTMLElement>('.provider-card-model-value');
      const cardCustom = customProviderFor(customs, cardProvider);
      const cardDef = providerDef(cardProvider);
      if (modelValue) {
        const cardModels = modelListForProvider(cfg, cardProvider || '');
        modelValue.textContent = active && modelInput?.value.trim()
          ? modelInput.value.trim()
          : (cardCustom?.defaultModel || (cardProvider === cfg.provider ? cfg.model.trim() : cfg.providerModels?.[cardProvider || '']?.[0]) || cardModels[0] || cardDef?.defaultModel || '');
      }
    });

    const title = document.getElementById('provider-config-title');
    const endpoint = document.getElementById('provider-config-endpoint');
    if (title) title.textContent = selectedLabel;
    if (endpoint) endpoint.textContent = baseUrlInput?.value.trim() || custom?.baseURL || def?.baseURL || '';
    if (modelInput) {
      modelInput.placeholder = custom
        ? (custom.defaultModel || t('llm.model.addPlaceholder'))
        : (def?.defaultModel ?? '');
    }

    // Custom-only rows: name edit + delete. Keyless locals (Ollama) get a hint
    // in the API-key field instead of the generic sk-... placeholder.
    const isCustom = !!custom;
    const isKnown = this.isKnownProvider(provider);
    const isCustomSettings = isCustom && !isKnown;
    const baseUrlRow = baseUrlInput?.closest<HTMLElement>('.provider-baseurl-row');
    baseUrlRow?.toggleAttribute('hidden', !isCustomSettings);
    // 未配置的自定义供应商（还没有 Base URL）：端点处给出醒目标记，避免用户
    // 以为已就绪就直接发送 —— 空地址会静默回落到内置默认端点。
    const unconfigured = isCustom && !custom?.baseURL;
    if (unconfigured && endpoint) endpoint.textContent = t('llm.custom.needURL');
    const configCard = document.querySelector<HTMLElement>('.provider-config-card');
    configCard?.classList.toggle('provider-unconfigured', unconfigured);
    baseUrlInput?.closest('.setting-row')?.classList.toggle('provider-needs-url', unconfigured);
    // Badge + explicit activation: the badge says "当前使用" only for the ACTIVE
    // LLM; any other card being edited shows "未启用" and reveals the enable
    // button so a card never becomes the active model without a user action.
    const editingIsActive = provider === cfg.provider;
    const badge = document.getElementById('provider-config-badge');
    const activateBtn = document.getElementById('provider-activate-btn');
    if (badge) {
      if (editingIsActive) {
        badge.textContent = t('llm.active');
        badge.dataset.i18n = 'llm.active';
        badge.classList.remove('provider-config-badge-inactive');
      } else {
        badge.textContent = t('llm.custom.notEnabled');
        delete badge.dataset.i18n;
        badge.classList.add('provider-config-badge-inactive');
      }
    }
    if (activateBtn) activateBtn.hidden = editingIsActive;
    const nameRow = document.getElementById('cfg-custom-name-row');
    const deleteRow = document.getElementById('cfg-custom-delete-row');
    const nameEdit = document.getElementById('cfg-custom-name-edit') as HTMLInputElement | null;
    if (nameRow) nameRow.hidden = !isCustomSettings;
    if (deleteRow) deleteRow.hidden = !isCustomSettings;
    if (nameEdit) nameEdit.value = custom?.name ?? '';
    // 文生图配置只对自定义供应商开放（内置 DeepSeek/Qwen/GLM 无图片 API）：
    // 开启后该供应商的图片请求走 generate_image 工具，渲染为真实图片而非 SVG。
    const imageGenRow = document.getElementById('cfg-imagegen-row');
    if (imageGenRow) imageGenRow.hidden = !isCustomSettings;
    const imageGenToggle = document.getElementById('cfg-imagegen') as HTMLInputElement | null;
    const imageGenModel = document.getElementById('cfg-imagegen-model') as HTMLInputElement | null;
    if (imageGenToggle) imageGenToggle.checked = custom?.imageGen === true;
    if (imageGenModel) imageGenModel.value = custom?.imageGenModel ?? '';
    // Model auto-fetch only makes sense for custom endpoints (the built-ins
    // come with their own default model list).
    const fetchBtn = document.getElementById('cfg-fetch-models-btn');
    if (fetchBtn) fetchBtn.hidden = !isCustomSettings;
    const keyInput = document.getElementById('cfg-apikey') as HTMLInputElement | null;
    const v4Name = document.getElementById('provider-v4-current-name');
    const v4Endpoint = document.getElementById('provider-v4-current-endpoint');
    const v4Model = document.getElementById('provider-v4-current-model-name');
    const v4Status = document.getElementById('provider-v4-connection-status');
    const v4Count = document.getElementById('provider-v4-model-count');
    if (v4Name) v4Name.textContent = selectedLabel;
    if (v4Endpoint) v4Endpoint.textContent = baseUrlInput?.value.trim() || custom?.baseURL || def?.baseURL || t('llm.connection.notConfigured');
    const selectedModels = modelListForProvider(cfg, provider);
    const selectedDefault = modelInput?.value.trim() || custom?.defaultModel || selectedModels[0] || t('llm.custom.err.models');
    if (v4Model) v4Model.textContent = selectedDefault;
    if (v4Count) v4Count.textContent = t('llm.model.count').replace('{n}', String(selectedModels.length));
    if (v4Status && v4Status.dataset.state !== 'testing') {
      const hasProviderCredential = isCustom
        ? !!custom?.local || !!custom?.apiKey || custom?.hasApiKey === true
        : !!cfg.apiKey || cfg.hasApiKey === true;
      // Three states: active+credential → 已连接; credential but NOT the
      // active provider → 已保存未启用 (a key is present, just not in use);
      // otherwise → 未配置. The middle state matters: after saving a key the
      // pill must never keep saying 未配置 ("连不通") — the key IS there.
      if (provider === cfg.provider && hasProviderCredential) {
        v4Status.textContent = t('llm.connection.connected');
        v4Status.dataset.state = 'active';
      } else if (hasProviderCredential) {
        v4Status.textContent = t('llm.connection.savedNotActive');
        v4Status.dataset.state = 'saved';
      } else {
        v4Status.textContent = t('llm.connection.notConfigured');
        v4Status.dataset.state = 'error';
      }
    }

    if (keyInput) {
      // Keyless locals say "leave empty"; cloud presets without a key yet say
      // "required" — the hint must not tell an OpenAI user the key is optional.
      if (isCustom && custom?.local && !custom.apiKey && !custom.hasApiKey) {
        keyInput.removeAttribute('data-i18n-placeholder');
        keyInput.placeholder = t('llm.custom.apiKeyOptional.hint');
      } else if (isCustom && !custom.apiKey && !custom.hasApiKey) {
        keyInput.removeAttribute('data-i18n-placeholder');
        keyInput.placeholder = t('llm.custom.apiKeyRequired.hint');
      } else {
        keyInput.setAttribute('data-i18n-placeholder', 'llm.apiKey.placeholder');
        keyInput.placeholder = t('llm.apiKey.placeholder');
      }
    }
    this.presentedProvider = provider;
  }

  // ── Load config into form ──

  private loadToForm() {
    // Re-apply translations for dynamic content
    applyTranslations();
    const cfg = loadConfig() || defaults();
    const selectedCustom = customProviderFor(cfg.customProviders ?? [], cfg.provider);
    // (Re)opening the panel always lands on the ACTIVE provider — nothing is
    // pending activation and the presented card resets to the active one.
    this.pendingActivation = null;
    this.presentedProvider = null;
    this.setProviderV4Drawer('provider', false);
    this.setProviderV4Drawer('models', false);
    this.setProviderV4Drawer('connection', false);

    // Custom provider cards are rendered dynamically — rebuild them before the
    // presentation pass so selection styles apply to user-defined entries too.
    this.renderCustomProviderCards();
    (document.getElementById('cfg-provider') as HTMLSelectElement).value = cfg.provider;
    const modelEl = document.getElementById('cfg-model') as HTMLInputElement;
    const modelAddEl = document.getElementById('cfg-model-add') as HTMLInputElement | null;
    const baseUrlEl = document.getElementById('cfg-baseurl') as HTMLInputElement;
    if (modelAddEl) modelAddEl.value = '';
    // Custom providers always carry a required base URL + default model in
    // their entry — prefill the editable fields so edits write back correctly.
    modelEl.value = cfg.model || selectedCustom?.defaultModel || '';
    baseUrlEl.value = cfg.baseURL || selectedCustom?.baseURL || '';
    this.updateProviderPresentation(cfg.provider);
    const keyInput = document.getElementById('cfg-apikey') as HTMLInputElement;
    // Browser mode: a custom provider's key lives in its config entry — prefill
    // the field so edits write back correctly and an unrelated autoSave never
    // clobbers it with an empty value. Tauri mode: entry keys are always '' in
    // storage (they live in Rust secrets), so this never leaks a secret.
    keyInput.value = cfg.apiKey || selectedCustom?.apiKey || '';
    if (isTauriRuntime() && (cfg.hasApiKey || selectedCustom?.hasApiKey)) {
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
    modelEl.placeholder = selectedCustom?.defaultModel ?? defaultModelFor(cfg.provider);
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
    const proxy = normalizeProxyConfig(cfg.proxy);
    const proxyEnabledEl = document.getElementById('cfg-proxy-enabled') as HTMLInputElement | null;
    if (proxyEnabledEl) proxyEnabledEl.checked = proxy.enabled;
    const proxyLlmEl = document.getElementById('cfg-proxy-llm') as HTMLInputElement | null;
    if (proxyLlmEl) proxyLlmEl.checked = proxy.llmEnabled;
    const proxyToolsEl = document.getElementById('cfg-proxy-tools') as HTMLInputElement | null;
    if (proxyToolsEl) proxyToolsEl.checked = proxy.toolsEnabled;
    const proxyUrlEl = document.getElementById('cfg-proxy-url') as HTMLInputElement | null;
    if (proxyUrlEl) proxyUrlEl.value = proxy.url;
    const proxyProvidersEl = document.getElementById('cfg-proxy-bypass-providers') as HTMLInputElement | null;
    if (proxyProvidersEl) proxyProvidersEl.value = proxy.bypassProviders.join(', ');
    const proxyModelsEl = document.getElementById('cfg-proxy-bypass-models') as HTMLInputElement | null;
    if (proxyModelsEl) proxyModelsEl.value = proxy.bypassModels.join(', ');

    document.querySelectorAll('.cfg-skill-toggle').forEach(el => {
      const skill = el.getAttribute('data-skill');
      if (skill && cfg.skills[skill] !== undefined) {
        (el as HTMLInputElement).checked = cfg.skills[skill];
      }
    });

    // Re-render the Skill Hub installed list so toggles reflect the persisted
    // enabled state when the panel reopens.
    this.renderInstalledHubSkills();

    // Memory evolution thresholds (Settings → Memory → 遗忘速度) — fill the
    // fields from the persisted (partial) config, defaulting to engine values.
    this.loadEvolutionToForm();

    // Memory dashboard: live health / lifecycle / supersession per entry.
    this.renderMemoryDashboard();

    // Runtime diagnostics: effective evolution params + last decay run info.
    this.renderMemoryDiagnostics();

    document.querySelectorAll('.theme-option').forEach(el => {
      const active = el.getAttribute('data-theme') === cfg.theme;
      el.classList.toggle('active', active);
      el.setAttribute('aria-checked', String(active));
    });
    this.applyTheme(cfg.theme);

    // ── MCP servers ──
    this.mcpServers = cfg.mcpServers ? [...cfg.mcpServers] : [];
    const excludeInput = document.getElementById('cfg-mcp-exclude-prefixes') as HTMLInputElement | null;
    if (excludeInput) excludeInput.value = (cfg.mcpExcludedPrefixes ?? []).join(', ');
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

  /** One-click Scrapling MCP preset (adaptive stealth scraping, `uvx scrapling
   * mcp`). Opt-in: requires Python + uv; see the hint next to the button. */
  private addScraplingMcp() {
    if (this.mcpServers.some(s => s.name === SCRAPLING_MCP_PRESET.name)) {
      this.toast(t('toast.serverNameExists'));
      return;
    }
    this.mcpServers.push({ ...SCRAPLING_MCP_PRESET });
    this.renderMcpServers();
    this.toast(t('toast.scraplingAdded'));
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

  // ── Memory evolution thresholds（遗忘速度设置区）──

  private static readonly DAY_MS = 24 * 3600 * 1000;

  /** 把（可能缺省的）evolution 配置填充进设置表单；缺省字段显示引擎默认值。 */
  private loadEvolutionToForm(): void {
    const evo = (loadConfig() ?? defaults()).evolution;
    const D = EVOLUTION_DEFAULTS;
    const set = (id: string, v: string): void => {
      const el = document.getElementById(id) as HTMLInputElement | null;
      if (el) el.value = v;
    };
    set('cfg-mem-half-life', String((evo?.recencyHalfLifeMs ?? D.recencyHalfLifeMs) / SettingsPanel.DAY_MS));
    set('cfg-mem-grace', String((evo?.dormantGraceMs ?? D.dormantGraceMs) / SettingsPanel.DAY_MS));
    set('cfg-mem-active-min', String((evo?.activeMin ?? D.activeMin) * 100));
    set('cfg-mem-dormant-max', String((evo?.dormantMax ?? D.dormantMax) * 100));
    set('cfg-mem-delete-floor', String((evo?.deleteFloor ?? D.deleteFloor) * 100));
    set('cfg-mem-supersede-sim', String((evo?.supersedeSimilarity ?? D.supersedeSimilarity) * 100));
  }

  /** 从表单收集 evolution 配置：只保留与引擎默认不同的字段（用户未改动的项
   *  不落盘，天然跟随升级后的默认值）。超出 min/max 的键入值（如手输 0 半衰
   *  期）直接拒绝 —— 不持久化，回落引擎默认，防止除零类破坏。 */
  private gatherEvolution(): PureConfig['evolution'] {
    const num = (id: string): number | null => {
      const el = document.getElementById(id) as HTMLInputElement | null;
      if (!el) return null;
      const v = parseFloat(el.value);
      if (!Number.isFinite(v)) return null;
      const min = el.min ? parseFloat(el.min) : -Infinity;
      const max = el.max ? parseFloat(el.max) : Infinity;
      if (v < min || v > max) return null;
      // 输入框 step=1：取整避免 30.5 这类小数（引擎能处理，但 UI 口径是整数）。
      return Math.round(v);
    };
    const D = EVOLUTION_DEFAULTS;
    const DAY = SettingsPanel.DAY_MS;
    const evo: NonNullable<PureConfig['evolution']> = {};
    const half = num('cfg-mem-half-life');
    const grace = num('cfg-mem-grace');
    const active = num('cfg-mem-active-min');
    const dormant = num('cfg-mem-dormant-max');
    const floor = num('cfg-mem-delete-floor');
    const sim = num('cfg-mem-supersede-sim');
    if (half !== null && half * DAY !== D.recencyHalfLifeMs) evo.recencyHalfLifeMs = half * DAY;
    if (grace !== null && grace * DAY !== D.dormantGraceMs) evo.dormantGraceMs = grace * DAY;
    if (active !== null && active / 100 !== D.activeMin) evo.activeMin = active / 100;
    if (dormant !== null && dormant / 100 !== D.dormantMax) evo.dormantMax = dormant / 100;
    if (floor !== null && floor / 100 !== D.deleteFloor) evo.deleteFloor = floor / 100;
    if (sim !== null && sim / 100 !== D.supersedeSimilarity) evo.supersedeSimilarity = sim / 100;
    return Object.keys(evo).length > 0 ? evo : undefined;
  }

  // ── Memory runtime diagnostics（记忆页诊断区）──

  /** 渲染生效的进化参数（合并用户自定义后）+ 上次衰减运行信息。 */
  private renderMemoryDiagnostics(): void {
    const el = document.getElementById('memory-diag');
    if (!el) return;
    const cfg = loadConfig() ?? defaults();
    const evo = resolveEvolutionConfig(cfg.evolution);
    const custom = cfg.evolution ?? {};
    const DAY = SettingsPanel.DAY_MS;
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    const day = (v: number) => `${v / DAY}${t('memory.unitDay')}`;
    const rows: Array<[string, string, boolean]> = [
      [t('memory.diag.halfLife'), day(evo.recencyHalfLifeMs), custom.recencyHalfLifeMs !== undefined],
      [t('memory.diag.activeMin'), pct(evo.activeMin), custom.activeMin !== undefined],
      [t('memory.diag.dormantMax'), pct(evo.dormantMax), custom.dormantMax !== undefined],
      [t('memory.diag.deleteFloor'), pct(evo.deleteFloor), custom.deleteFloor !== undefined],
      [t('memory.diag.grace'), day(evo.dormantGraceMs), custom.dormantGraceMs !== undefined],
      [t('memory.diag.supersedeSim'), pct(evo.supersedeSimilarity), custom.supersedeSimilarity !== undefined],
      [t('memory.diag.supersededPenalty'), pct(evo.supersededPenalty), custom.supersededPenalty !== undefined],
      [t('memory.diag.hitsFull'), String(evo.hitsForFullUsage), custom.hitsForFullUsage !== undefined],
    ];
    const info = memoryStore.getLastDecayInfo();
    const now = Date.now();
    const parts: string[] = [];
    if (info.lastDecayAt) parts.push(this.relativeTime(info.lastDecayAt, now));
    const del = info.lastDeleted ?? 0;
    const upd = info.lastUpdated ?? 0;
    if (parts.length > 0 && (del > 0 || upd > 0)) {
      parts.push(t('memory.diag.deleted').replace('{n}', String(del)));
      parts.push(t('memory.diag.updated').replace('{n}', String(upd)));
    }
    const lastRunText = parts.length > 0 ? parts.join(' · ') : t('memory.diag.never');
    // 下次自动衰减：后台定时器（memoryDecayTimer.ts）在节流窗（1h，与 Harness
    // MEMORY_DECAY_INTERVAL_MS 一致）过后自动执行，即使没有新会话。上次运行 +
    // 节流窗即下次触发点；节流窗已过 → 后台定时器立即补跑。
    const AUTO_DECAY_INTERVAL = 60 * 60 * 1000;
    let nextRunText: string;
    if (info.lastDecayAt) {
      const nextAt = info.lastDecayAt + AUTO_DECAY_INTERVAL;
      if (nextAt > now) {
        const diff = nextAt - now;
        const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
        const t0 = diff < MIN
          ? t('memory.diag.inMin').replace('{n}', '1')
          : diff < HOUR
            ? t('memory.diag.inMin').replace('{n}', String(Math.floor(diff / MIN)))
            : diff < DAY
              ? t('memory.diag.inHour').replace('{n}', String(Math.floor(diff / HOUR)))
              : t('memory.diag.inDay').replace('{n}', String(Math.floor(diff / DAY)));
        nextRunText = t('memory.diag.nextRunIn').replace('{t}', t0);
      } else {
        nextRunText = t('memory.diag.nextRunSoon');
      }
    } else {
      // 从未运行：后台定时器启动后立即补跑第一轮。
      nextRunText = t('memory.diag.nextRunSoon');
    }
    // 后台定时器徽章：显示衰减由 idle 定时器守护，不依赖新会话触发。
    const timerBadge = `<i class="memory-diag-timer">${t('memory.diag.timerEnabled')}</i>`;
    el.innerHTML = `<div class="memory-diag-params">
      ${rows.map(([label, value, isCustom]) => `<div class="memory-diag-row">
        <span class="memory-diag-key">${escapeHtml(label)}</span>
        <b class="memory-diag-value">${escapeHtml(value)}</b>
        ${isCustom ? `<i class="memory-diag-custom">${t('memory.diag.custom')}</i>` : ''}
      </div>`).join('')}
    </div>
    <div class="memory-diag-lastrun">
      <span class="memory-diag-key">${t('memory.diag.lastRunLabel')}</span>
      <span class="memory-diag-value">${escapeHtml(lastRunText)}</span>
    </div>
    <div class="memory-diag-lastrun">
      <span class="memory-diag-key">${t('memory.diag.nextRunLabel')}</span>
      <span class="memory-diag-value">${escapeHtml(nextRunText)}</span>
    </div>
    <div class="memory-diag-timer-row">${timerBadge} ${t('memory.diag.timerHint')}</div>`;
  }

  // ── Memory dashboard（智能进化记忆库可视化，Adapter Layer 设计文档 §12.9）──

  // Type badge classes + i18n keys only exist for the five known kinds; the
  // fallback text is escaped (entries are read from user-editable localStorage,
  // so an unexpected `type` must never reach innerHTML unescaped).
  private static readonly MEMORY_TYPES: ReadonlySet<string> = new Set([
    'user_preference', 'error_pattern', 'successful_pattern', 'project_convention', 'procedure',
  ]);

  /** 相对时间标签：刚刚 / {n} 分钟前 / {n} 小时前 / {n} 天前。 */
  private relativeTime(ts: number, now: number): string {
    const diff = Math.max(0, now - ts);
    const MIN = 60_000;
    const HOUR = 3_600_000;
    const DAY = 86_400_000;
    if (diff < MIN) return t('memory.justNow');
    if (diff < HOUR) return t('memory.minAgo').replace('{n}', String(Math.floor(diff / MIN)));
    if (diff < DAY) return t('memory.hourAgo').replace('{n}', String(Math.floor(diff / HOUR)));
    return t('memory.dayAgo').replace('{n}', String(Math.floor(diff / DAY)));
  }

  private truncateForMemory(text: string, n: number): string {
    return text.length > n ? `${text.slice(0, n)}…` : text;
  }

  /** 渲染记忆库：汇总（总数 + 各生命周期计数）+ 逐条卡片（健康分进度条、
   *  生命周期徽章、被取代标记、检索次数、上次使用、项目）。
   *  在面板打开（loadToForm）与切到「记忆」页时刷新。
   *  健康分取实时计算值（decayScore 是存储值，可能滞后一次衰减）。 */
  private renderMemoryDashboard(): void {
    const listEl = document.getElementById('memory-list');
    if (!listEl) return;
    const cfg = loadConfig() ?? defaults();
    const enabled = cfg.skills?.memory ?? true;
    const disabledHint = document.getElementById('memory-disabled-hint');
    if (disabledHint) {
      disabledHint.textContent = t('memory.disabled');
      disabledHint.hidden = enabled;
    }
    // Memory skill off: show only the hint — no summary, no card list, so the
    // page never mixes "disabled" with a populated dashboard.
    if (!enabled) {
      listEl.innerHTML = '';
      const summaryEl = document.getElementById('memory-summary');
      if (summaryEl) summaryEl.innerHTML = '';
      const cappedEl = document.getElementById('memory-capped');
      if (cappedEl) cappedEl.hidden = true;
      return;
    }

    let entries: MemoryEntry[] = [];
    try {
      entries = memoryStore.list();
    } catch (err) {
      console.error('[pure] memory dashboard list failed:', err);
    }

    const now = Date.now();
    const summaryEl = document.getElementById('memory-summary');
    if (summaryEl) {
      const counts = { active: 0, degraded: 0, dormant: 0 };
      for (const e of entries) counts[lifecycleOf(healthScore(e, now, cfg.evolution), cfg.evolution)]++;
      summaryEl.innerHTML = `<span class="memory-summary-count">${t('memory.summary').replace('{n}', String(entries.length))}</span>` +
        (entries.length > 0
          ? `<span class="memory-summary-chip memory-chip-active">${t('memory.lifecycle.active')} · ${counts.active}</span>` +
            `<span class="memory-summary-chip memory-chip-degraded">${t('memory.lifecycle.degraded')} · ${counts.degraded}</span>` +
            `<span class="memory-summary-chip memory-chip-dormant">${t('memory.lifecycle.dormant')} · ${counts.dormant}</span>`
          : '');
    }

    const MAX_CARDS = 100;
    const cappedEl = document.getElementById('memory-capped');
    if (cappedEl) {
      cappedEl.textContent = t('memory.capped').replace('{n}', String(MAX_CARDS));
      cappedEl.hidden = entries.length <= MAX_CARDS;
    }

    if (entries.length === 0) {
      listEl.innerHTML = `<div class="memory-empty">${t('memory.empty')}</div>`;
      return;
    }

    // 被取代标记的悬浮提示解析出取代者的内容（更直观），找不到则回退到 id。
    const byId = new Map(entries.map(e => [e.id, e]));
    listEl.innerHTML = entries
      .map(e => ({ e, score: healthScore(e, now, cfg.evolution) }))
      .sort((a, b) => b.score - a.score || b.e.timestamp - a.e.timestamp)
      .slice(0, MAX_CARDS)
      .map(({ e, score }) => {
        const lifecycle = lifecycleOf(score, cfg.evolution);
        const pct = Math.min(100, Math.max(0, Math.round(score * 100)));
        const superseded = e.supersededBy
          ? (() => {
              const replacer = byId.get(e.supersededBy!);
              const tip = replacer
                ? t('memory.supersededByTitle').replace('{content}', this.truncateForMemory(replacer.content, 120))
                : t('memory.supersededByTitle').replace('{content}', e.supersededBy!);
              return `<span class="memory-badge memory-badge-superseded" title="${escapeHtml(tip)}">${t('memory.superseded')}</span>`;
            })()
          : '';
        const lastUsed = e.lastUsedAt ?? e.timestamp;
        const project = e.projectPath || '';
        const projectShort = project.split('/').filter(Boolean).pop() || project;
        const knownType = SettingsPanel.MEMORY_TYPES.has(e.type) ? e.type : undefined;
        const typeClass = knownType ? ` memory-type-${knownType}` : '';
        const typeLabel = escapeHtml(knownType ? t(`memory.type.${knownType}`, knownType) : e.type);
        return `<div class="memory-card">
          <div class="memory-card-header">
            <span class="memory-badge memory-badge-type${typeClass}">${typeLabel}</span>
            <span class="memory-badge memory-badge-life memory-life-${lifecycle}">${t(`memory.lifecycle.${lifecycle}`, lifecycle)}</span>
            ${superseded}
          </div>
          <div class="memory-content" title="${escapeHtml(e.content)}">${escapeHtml(this.truncateForMemory(e.content, 160))}</div>
          <div class="memory-meta">
            <span class="memory-score" title="${escapeHtml(t('memory.health'))}: ${pct}%">
              <span class="memory-score-track"><i class="memory-score-bar memory-bar-${lifecycle}" style="width:${pct}%"></i></span>
              <b>${pct}%</b>
            </span>
            <span class="memory-meta-item">${t('memory.hits').replace('{n}', String(e.hitCount ?? 0))}</span>
            <span class="memory-meta-item">${t('memory.lastUsed').replace('{t}', this.relativeTime(lastUsed, now))}</span>
            ${project ? `<span class="memory-meta-item memory-project" title="${escapeHtml(project)}">${escapeHtml(projectShort)}</span>` : ''}
          </div>
        </div>`;
      })
      .join('');
  }

  // ── Memory export / import（导出/导入，迁移到新机器）──

  /** 导出记忆库：JSON（完整字段 + 实时健康分/生命周期）或 Markdown（报告）。
   *  空库提示而非导出空文件。保存走与 stats 导出相同的 Tauri save_file /
   *  browser fallback 流程。 */
  private async exportMemoryLibrary(format: 'json' | 'markdown'): Promise<void> {
    try {
      const entries = memoryStore.list();
      if (entries.length === 0) {
        this.toast(t('memory.transfer.empty'));
        return;
      }
      const cfg = (loadConfig() ?? defaults()).evolution;
      const stamp = new Date().toISOString().slice(0, 10);
      if (format === 'json') {
        const content = buildMemoryExportJson(entries, cfg);
        const savedTo = await this.saveTextFile(content, `pure-memories-${stamp}.json`, 'json');
        if (savedTo) showToastHtml(buildExportSavedToast(savedTo));
      } else {
        const content = buildMemoryExportMarkdown(entries, cfg);
        const savedTo = await this.saveTextFile(content, `pure-memories-${stamp}.md`, 'md');
        if (savedTo) showToastHtml(buildExportSavedToast(savedTo));
      }
    } catch (err) {
      console.error('[pure] memory export failed:', err);
      this.toast(t('memory.transfer.exportFailed'));
    }
  }

  /** 导入记忆库：读取 JSON 文件 → 解析校验 → 去重写入 → 刷新仪表盘。 */
  private async importMemoryLibrary(file: File): Promise<void> {
    try {
      const text = await file.text();
      const entries = parseMemoryImport(text);
      if (entries.length === 0) {
        this.toast(t('memory.transfer.noEntries'));
        return;
      }
      const { imported, skipped } = await memoryStore.importEntries(entries);
      this.toast(t('memory.transfer.imported')
        .replace('{n}', String(imported))
        .replace('{m}', String(skipped)));
      this.renderMemoryDashboard();
    } catch (err) {
      console.error('[pure] memory import failed:', err);
      const msg = (err as Error)?.message;
      this.toast(msg === 'unsupported-envelope'
        ? t('memory.transfer.invalidEnvelope')
        : msg === 'unsupported-version'
          ? t('memory.transfer.invalidVersion')
          : msg === 'storage-full'
            ? t('memory.transfer.storageFull')
            : t('memory.transfer.invalidFile'));
    }
  }

  /** 通过原生保存对话框写出文本（Tauri：plugin-dialog save + save_file
   *  invoke；browser：File System Access API → download anchor 回退）。
   *  返回保存路径；取消返回 null。镜像 main.ts 的 stats 导出流程。 */
  private async saveTextFile(content: string, filename: string, ext: string): Promise<string | null> {
    if (isTauriRuntime()) {
      const { save } = await import('@tauri-apps/plugin-dialog');
      const path = await save({ defaultPath: filename, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
      if (!path) return null; // cancelled
      const core = await loadTauriCore();
      if (!core) throw new Error('Tauri core unavailable');
      await core.invoke('save_file', { path, content });
      return path;
    }

    // Browser dev mode: File System Access API (Chrome/Edge).
    const w = window as unknown as {
      showSaveFilePicker?: (opts: {
        suggestedName?: string;
        types?: Array<{ description: string; accept: Record<string, string[]> }>;
      }) => Promise<{
        createWritable(): Promise<{ write(d: Blob): Promise<void>; close(): Promise<void> }>;
      }>;
    };
    if (typeof w.showSaveFilePicker === 'function') {
      try {
        const mime = ext === 'json' ? 'application/json' : 'text/markdown';
        const handle = await w.showSaveFilePicker({
          suggestedName: filename,
          types: [{ description: ext.toUpperCase(), accept: { [mime]: [`.${ext}`] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(new Blob([content], { type: 'text/plain;charset=utf-8' }));
        await writable.close();
        return filename;
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return null; // cancelled
        // Any other failure — fall through to the download fallback.
      }
    }

    // Last-resort download (works everywhere).
    const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return null;
  }

  // ── Custom providers ──

  /**
   * (Re)render the user-defined provider cards into the grid. Called on every
   * settings open and after add/delete so the grid mirrors the persisted list.
   */
  private renderCustomProviderCards(): void {
    const grid = document.getElementById('provider-card-grid');
    if (!grid) return;
    const customs = (loadConfig() ?? defaults()).customProviders ?? [];
    // Keep the hidden provider select in sync with the custom entries so
    // select.value stays the editing provider even for non-built-in ids
    // (a <select> returns '' when its value matches no <option>).
    const select = document.getElementById('cfg-provider') as HTMLSelectElement | null;
    select?.querySelectorAll('option[data-custom]').forEach(o => o.remove());
    for (const c of customs) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name;
      opt.dataset.custom = '1';
      select?.appendChild(opt);
    }
    // Remove previously rendered custom cards (marked below) so re-opening the
    // panel never duplicates them.
    grid.querySelectorAll('.provider-card-custom').forEach(el => el.remove());
    for (const c of customs) {
      // A cloud provider without a key yet (preset saved, key pending) must
      // NOT be presented as keyless — only true locals (Ollama / LM Studio)
      // advertise "no key needed".
      const keyless = !!c.local && !c.apiKey && !c.hasApiKey;
      const needsKey = !c.local && !c.apiKey && !c.hasApiKey;
      const markClass = c.id === 'ollama' ? 'provider-mark-ollama' : 'provider-mark-custom';
      const mark = c.id === 'ollama' ? 'OL' : (c.name.slice(0, 2) || 'C').toUpperCase();

      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'provider-card provider-card-custom';
      card.dataset.provider = c.id;
      card.setAttribute('role', 'option');
      card.setAttribute('aria-selected', 'false');

      // Per-card delete (×): hover/focus to reveal. The grid's delegated click
      // handler intercepts it before card selection. A <span role="button">
      // keeps the card itself a single <button> (no nested buttons).
      const removeEl = document.createElement('span');
      removeEl.className = 'provider-card-remove';
      removeEl.setAttribute('role', 'button');
      removeEl.tabIndex = 0;
      removeEl.dataset.removeProvider = c.id;
      removeEl.setAttribute('aria-label', `${t('llm.custom.deleteBtn')} ${c.name}`);
      removeEl.title = t('llm.custom.deleteBtn');
      removeEl.textContent = '×';

      const topLine = document.createElement('span');
      topLine.className = 'provider-card-topline';
      const markEl = document.createElement('span');
      markEl.className = `provider-card-mark ${markClass}`;
      markEl.textContent = mark;
      const statusEl = document.createElement('span');
      statusEl.className = 'provider-card-status';
      statusEl.dataset.providerStatus = '';
      statusEl.textContent = t('llm.chooseCard');
      topLine.append(markEl, statusEl);

      const nameEl = document.createElement('span');
      nameEl.className = 'provider-card-name';
      nameEl.textContent = c.name;

      const metaEl = document.createElement('span');
      metaEl.className = 'provider-card-meta';
      const protoEl = document.createElement('span');
      protoEl.textContent = 'OpenAI';
      const dotEl = document.createElement('b');
      dotEl.textContent = '·';
      const modelEl = document.createElement('span');
      modelEl.className = 'provider-card-model-value';
      modelEl.textContent = c.defaultModel;
      metaEl.append(protoEl, dotEl, modelEl);

      card.append(removeEl, topLine, nameEl, metaEl);
      if (keyless) {
        const badge = document.createElement('span');
        badge.className = 'provider-card-keyless';
        badge.textContent = t('llm.custom.noKeyBadge');
        card.appendChild(badge);
      } else if (needsKey) {
        const badge = document.createElement('span');
        badge.className = 'provider-card-keyless provider-card-needs-key';
        badge.textContent = t('llm.custom.needKeyBadge');
        card.appendChild(badge);
      }
      grid.appendChild(card);
    }
    const count = document.getElementById('provider-section-count');
    if (count) count.textContent = String(4 + customs.length);
  }

  private gatherProviderModels(): Record<string, string[]> {
    const cfg = loadConfig() ?? defaults();
    const provider = (document.getElementById('cfg-provider') as HTMLSelectElement | null)?.value || '';
    const result = normalizeProviderModels(cfg.providerModels);
    const custom = customProviderFor(cfg.customProviders ?? [], provider);
    // Typing a model edits the single default field; only the explicit Add
    // action grows a provider's list. This keeps the default one-model setup
    // compact instead of turning every partial input into a new row.
    return result;
  }

  /** Carry the custom-provider list through, applying the form's live edits. */
  private gatherCustomProviders(): PureConfig['customProviders'] {
    const prev = (loadConfig() ?? defaults()).customProviders ?? [];
    const list = prev.map(p => ({ ...p }));
    const provider = (document.getElementById('cfg-provider') as HTMLSelectElement).value;
    const idx = list.findIndex(p => p.id === provider);
    if (idx < 0) return list;
    const entry = { ...list[idx] };
    const name = (document.getElementById('cfg-custom-name-edit') as HTMLInputElement | null)?.value.trim();
    const baseURL = (document.getElementById('cfg-baseurl') as HTMLInputElement).value.trim();
    const model = (document.getElementById('cfg-model') as HTMLInputElement).value.trim();
    if (name) entry.name = name;
    if (baseURL) entry.baseURL = baseURL;
    // 模型库由下方芯片管理（添加/移除/设默认）；输入框只承载当前默认模型，
    // 不再把每次击键的中间值追加进 models 列表。空输入时回退到列表首项。
    if (model) entry.defaultModel = model;
    else if (!entry.models.includes(entry.defaultModel)) entry.defaultModel = entry.models[0] ?? '';
    // 文生图开关 + 图片模型名（仅自定义供应商表单里存在这些字段）。
    const imageGenToggle = document.getElementById('cfg-imagegen') as HTMLInputElement | null;
    const imageGenModel = (document.getElementById('cfg-imagegen-model') as HTMLInputElement | null)?.value.trim();
    entry.imageGen = imageGenToggle?.checked === true;
    if (imageGenModel) entry.imageGenModel = imageGenModel;
    else delete entry.imageGenModel;
    // Raw key from the field; autoSave() scrubs/redirects it per platform.
    entry.apiKey = (document.getElementById('cfg-apikey') as HTMLInputElement).value.trim();
    list[idx] = entry;
    return list;
  }

  /** Stable slug for a new custom provider; appends -2/-3… on collisions. */
  private uniqueCustomId(customs: CustomProvider[], name: string): string {
    const base = name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '') || 'custom';
    let id = base;
    let n = 2;
    while (customs.some(p => p.id === id)) id = `${base}-${n++}`;
    return id;
  }

  /**
   * 用户自定义 chip：一键生成一张空白自定义供应商卡片（默认名，暂无地址），
   * 并打开它的配置卡 —— 名称 + Base URL 在下方填写。卡片不会自动启用；
   * 配置完成后用户点击卡片（或"启用此供应商"）才成为活动大模型。
   */
  private addBlankCustomProvider(): void {
    const prev = loadConfig() ?? defaults();
    const customs = [...(prev.customProviders ?? [])];
    // 幂等：已有未配置的空白卡片（默认名 + 无地址）就直接选中它，重复点击不新建。
    const existing = customs.find(p => !p.baseURL && p.name === t('llm.custom.defaultName'));
    let id: string;
    if (existing) {
      id = existing.id;
    } else {
      id = this.uniqueCustomId(customs, 'custom');
      const entry: CustomProvider = {
        id,
        name: t('llm.custom.defaultName'),
        baseURL: '',
        models: [],
        defaultModel: '',
        apiKey: '',
        hasApiKey: false,
      };
      customs.push(entry);
    }
    // Do NOT activate the blank card: the active provider stays unchanged until
    // the user fills in name + Base URL and clicks the card (or 启用此供应商).
    const cfg: PureConfig = { ...prev, customProviders: customs };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
    invalidateConfigCache();
    this.renderCustomProviderCards();
    this.pendingActivation = id;
    (document.getElementById('cfg-provider') as HTMLSelectElement).value = id;
    (document.getElementById('cfg-model') as HTMLInputElement).value = '';
    (document.getElementById('cfg-baseurl') as HTMLInputElement).value = '';
    (document.getElementById('cfg-apikey') as HTMLInputElement).value = '';
    this.updateProviderPresentation(id);
    this.setProviderV4Drawer('provider', false);
    this.setProviderV4Drawer('connection', true);
    this.toast(t('llm.custom.addedBlank'));
    document.getElementById('cfg-custom-name-edit')?.focus();
  }

  /** Fetch model list from the form's base URL via /v1/models (OpenAI-compatible
   * standard). Fills the models input on success; toasts any error. */
  /** Fetch the model list from the config card's Base URL via /v1/models
   * (OpenAI-compatible standard). Fills the model field with the first model
   * and persists the full list into the custom provider entry. */
  private async fetchProviderModels(): Promise<void> {
    const baseURL = (document.getElementById('cfg-baseurl') as HTMLInputElement)?.value.trim();
    const apiKey = (document.getElementById('cfg-apikey') as HTMLInputElement)?.value.trim();
    if (!baseURL) {
      this.toast(t('llm.custom.fetchNoURL'));
      return;
    }
    const btn = document.getElementById('cfg-fetch-models-btn') as HTMLButtonElement | null;
    if (btn) btn.disabled = true;
    try {
      // Normalize: strip trailing slash, then try /v1/models first (the
      // OpenAI-compatible standard); fall back to just /models for servers
      // that serve the list at a different path.
      const normalized = baseURL.replace(/\/+$/, '');
      const candidates = normalized.endsWith('/v1')
        ? [normalized + '/models', normalized.replace(/\/v1$/, '') + '/models']
        : [normalized + '/models', normalized.replace(/\/v1\/?.*$/, '') + '/v1/models'];
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
      interface ModelsResponse { data?: Array<{ id: string }>; models?: Array<{ name: string }> }
      let data: ModelsResponse | null = null;
      for (const url of candidates) {
        try {
          const res = await fetch(url, { headers, signal: abortSignal(8000) });
          if (!res.ok) continue;
          data = await res.json() as ModelsResponse;
          if (data && ((Array.isArray(data.data) && data.data.length > 0) || (Array.isArray(data.models) && data.models.length > 0))) break;
          data = null;
        } catch { /* try next candidate */ }
      }
      if (!data) throw new Error('all endpoints returned empty or failed');
      const ids: string[] = [];
      if (Array.isArray(data.data)) ids.push(...data.data.map((m) => m.id));
      if (Array.isArray(data.models)) ids.push(...data.models.map((m) => m.name));
      if (ids.length === 0) throw new Error('no models in response');
      // Replace the library, but keep the current default when the endpoint
      // still returns it. Only an invalid or missing default falls back to the
      // first fetched model.
      const modelInput = document.getElementById('cfg-model') as HTMLInputElement | null;
      const provider = (document.getElementById('cfg-provider') as HTMLSelectElement)?.value || '';
      const prev = loadConfig() ?? defaults();
      const entry = (prev.customProviders ?? []).find(p => p.id === provider);
      const fetchedModels = uniqueModels(ids.slice(0, 30));
      if (fetchedModels.length === 0) throw new Error('no valid models in response');
      const existingDefault = entry?.defaultModel?.trim() || '';
      const nextDefault = fetchedModels.includes(existingDefault) ? existingDefault : fetchedModels[0];
      if (modelInput) modelInput.value = nextDefault;
      if (entry) {
        entry.models = fetchedModels;
        entry.defaultModel = nextDefault;
        const cfg: PureConfig = { ...prev, customProviders: [...(prev.customProviders ?? [])] };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
        invalidateConfigCache();
        this.renderCustomProviderCards();
      }
      this.renderModelList(provider);
      this.updateProviderPresentation(provider);
      this.autoSave();
      this.toast(t('llm.custom.fetchOk').replace('{n}', String(fetchedModels.length)));
    } catch (err) {
      console.warn('[pure] fetch models failed:', err);
      this.toast(t('llm.custom.fetchFail') + '：' + ((err as Error)?.message || ''));
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // ── Multi-model editor: compact list + add / remove / set-default ──

  private renderModelList(provider: string): void {
    const list = document.getElementById('cfg-model-list');
    const addBtn = document.getElementById('cfg-add-model-btn');
    const clearBtn = document.getElementById('cfg-clear-models-btn') as HTMLButtonElement | null;
    if (!list) return;
    const cfg = loadConfig() ?? defaults();
    const custom = customProviderFor(cfg.customProviders ?? [], provider);
    const models = modelListForProvider(cfg, provider);
    const defaultModel = custom?.defaultModel
      || (provider === cfg.provider ? cfg.model.trim() : cfg.providerModels?.[provider]?.[0])
      || models[0]
      || '';

    // Every provider uses the same editor. The fetch button remains custom-only,
    // but manually entered model IDs work for built-in and custom providers.
    if (addBtn) addBtn.hidden = false;
    if (clearBtn) clearBtn.disabled = models.length <= 1;
    list.hidden = models.length === 0;
    list.innerHTML = models.map(model => {
      const isDefault = model === defaultModel;
      const canRemove = models.length > 1;
      return `<div class="provider-model-chip${isDefault ? ' provider-model-chip-default' : ''}" data-model="${escapeHtml(model)}" title="${isDefault ? t('llm.custom.chipIsDefault') : t('llm.custom.chipSetDefault')}" role="listitem">
        <button type="button" class="provider-model-chip-select" data-model="${escapeHtml(model)}" aria-pressed="${String(isDefault)}">
          <span class="provider-model-chip-radio" aria-hidden="true"></span>
          <span class="provider-model-chip-name">${escapeHtml(model)}</span>
          <span class="provider-model-chip-meta">${isDefault ? t('llm.custom.chipIsDefault') : t('llm.custom.chipSetDefault')}</span>
        </button>
        ${isDefault ? `<span class="provider-model-chip-badge" data-i18n="llm.custom.defaultBadge">默认</span>` : ''}
        ${canRemove ? `<button type="button" class="provider-model-chip-remove" data-remove="${escapeHtml(model)}" title="${t('llm.custom.removeModel')}" aria-label="${t('llm.custom.removeModel')}">×</button>` : ''}
      </div>`;
    }).join('');
    applyTranslations();
  }

  private addModel(): void {
    const provider = (document.getElementById('cfg-provider') as HTMLSelectElement).value;
    const prev = loadConfig() ?? defaults();
    const custom = customProviderFor(prev.customProviders ?? [], provider);
    const input = document.getElementById('cfg-model-add') as HTMLInputElement;
    const model = input.value.trim();
    if (!model) {
      this.toast(t('llm.custom.err.models'));
      return;
    }
    let cfg: PureConfig;
    let exists: boolean;
    if (custom) {
      const existing = uniqueModels(custom.models ?? []);
      const currentDefault = custom.defaultModel?.trim() || existing[0] || model;
      const nextEntry = { ...custom, models: uniqueModels([...existing, model]), defaultModel: currentDefault };
      cfg = { ...prev, customProviders: (prev.customProviders ?? []).map(p => p.id === provider ? nextEntry : p) };
      exists = existing.includes(model);
    } else {
      const existing = modelListForProvider(prev, provider);
      const nextModels = uniqueModels([...existing, model]);
      cfg = { ...prev, providerModels: { ...normalizeProviderModels(prev.providerModels), [provider]: nextModels } };
      exists = existing.includes(model);
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
    invalidateConfigCache();
    this.renderModelList(provider);
    this.updateProviderPresentation(provider);
    this.autoSave();
    input.value = '';
    this.toast(exists
      ? t('llm.custom.modelExists').replace('{m}', model)
      : t('llm.custom.addModelDone').replace('{m}', model));
  }

  private clearModels(): void {
    const provider = (document.getElementById('cfg-provider') as HTMLSelectElement).value;
    const prev = loadConfig() ?? defaults();
    const custom = customProviderFor(prev.customProviders ?? [], provider);
    const models = modelListForProvider(prev, provider);
    if (models.length <= 1) return;
    const keep = custom?.defaultModel?.trim()
      || (provider === prev.provider ? prev.model.trim() : '')
      || models[0];
    let cfg: PureConfig;
    if (custom) {
      const nextEntry = { ...custom, models: [keep], defaultModel: keep };
      cfg = { ...prev, customProviders: (prev.customProviders ?? []).map(p => p.id === provider ? nextEntry : p) };
    } else {
      cfg = { ...prev, providerModels: { ...normalizeProviderModels(prev.providerModels), [provider]: [keep] } };
      if (provider === prev.provider) cfg.model = keep;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
    invalidateConfigCache();
    (document.getElementById('cfg-model') as HTMLInputElement).value = keep;
    this.renderModelList(provider);
    this.updateProviderPresentation(provider);
    this.autoSave();
    this.toast(t('llm.custom.clearModelsDone'));
  }

  private removeModel(model: string): void {
    const provider = (document.getElementById('cfg-provider') as HTMLSelectElement).value;
    const prev = loadConfig() ?? defaults();
    const custom = customProviderFor(prev.customProviders ?? [], provider);
    const models = modelListForProvider(prev, provider);
    if (models.length <= 1 || !models.includes(model)) return;
    let cfg: PureConfig;
    const remaining = models.filter(m => m !== model);
    if (custom) {
      const defaultModel = custom.defaultModel === model ? remaining[0] : custom.defaultModel;
      const nextEntry = { ...custom, models: remaining, defaultModel };
      cfg = { ...prev, customProviders: (prev.customProviders ?? []).map(p => p.id === provider ? nextEntry : p) };
    } else {
      cfg = { ...prev, providerModels: { ...normalizeProviderModels(prev.providerModels), [provider]: remaining } };
      if (provider === prev.provider && prev.model === model) cfg.model = remaining[0];
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
    invalidateConfigCache();
    const input = document.getElementById('cfg-model') as HTMLInputElement;
    input.value = custom ? (cfg.customProviders.find(p => p.id === provider)?.defaultModel ?? remaining[0]) : (provider === cfg.provider ? cfg.model : remaining[0]);
    this.renderModelList(provider);
    this.updateProviderPresentation(provider);
    this.autoSave();
    this.toast(t('llm.custom.removedModel').replace('{m}', model));
  }

  private setDefaultModel(model: string): void {
    const provider = (document.getElementById('cfg-provider') as HTMLSelectElement).value;
    const prev = loadConfig() ?? defaults();
    const custom = customProviderFor(prev.customProviders ?? [], provider);
    const models = modelListForProvider(prev, provider);
    if (!models.includes(model)) return;
    let cfg: PureConfig;
    if (custom) {
      if (custom.defaultModel === model) return;
      const nextEntry = { ...custom, defaultModel: model };
      cfg = { ...prev, customProviders: (prev.customProviders ?? []).map(p => p.id === provider ? nextEntry : p) };
    } else {
      const nextModels = [model, ...models.filter(m => m !== model)];
      cfg = { ...prev, providerModels: { ...normalizeProviderModels(prev.providerModels), [provider]: nextModels } };
      if (provider === prev.provider) cfg.model = model;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
    invalidateConfigCache();
    (document.getElementById('cfg-model') as HTMLInputElement).value = model;
    this.renderModelList(provider);
    this.updateProviderPresentation(provider);
    this.autoSave();
    this.toast(t('llm.custom.defaultChanged').replace('{m}', model));
  }

  /** Resolve a quick-preset chip by slug (openai / openrouter / nvidia / ollama). */
  private customPresetFor(id: string): CustomProvider | undefined {
    switch (id) {
      case OPENAI_PRESET.id: return OPENAI_PRESET;
      case OPENROUTER_PRESET.id: return OPENROUTER_PRESET;
      case NVIDIA_PRESET.id: return NVIDIA_PRESET;
      case OLLAMA_PRESET.id: return OLLAMA_PRESET;
      default: return undefined;
    }
  }

  /**
   * One-click quick preset: add the provider entry (idempotent) and open its
   * config card. The provider does NOT become the active LLM on add — the
   * fields are prefilled, then the user clicks the card (or 启用此供应商) to
   * activate it, so a card is only ever active after the user acts on it.
   */
  private addCustomPreset(preset: CustomProvider): void {
    const prev = loadConfig() ?? defaults();
    const customs = [...(prev.customProviders ?? [])];
    if (!customs.some(p => p.id === preset.id)) {
      customs.push({ ...preset });
    }
    const cfg: PureConfig = { ...prev, customProviders: customs };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
    invalidateConfigCache();
    this.renderCustomProviderCards();
    this.pendingActivation = preset.id;
    (document.getElementById('cfg-provider') as HTMLSelectElement).value = preset.id;
    (document.getElementById('cfg-model') as HTMLInputElement).value = preset.defaultModel;
    (document.getElementById('cfg-baseurl') as HTMLInputElement).value = preset.baseURL;
    this.updateProviderPresentation(preset.id);
    this.setProviderV4Drawer('provider', false);
    this.setProviderV4Drawer('connection', true);
    this.toast(t('llm.custom.addedConfig').replace('{name}', preset.name));
  }

  private removeSelectedCustomProvider(): void {
    this.removeCustomProvider((document.getElementById('cfg-provider') as HTMLSelectElement).value);
  }

  /** 按 id 删除自定义供应商卡片（卡片 × 与配置卡删除按钮共用）。若删除的是
   *  当前选中的供应商，回退到 DeepSeek 默认配置；否则保持当前选择。删除后
   *  表单回填新活动供应商的配置，避免残留被删卡片的字段值被后续保存误写。 */
  private removeCustomProvider(id: string): void {
    const prev = loadConfig() ?? defaults();
    const removed = customProviderFor(prev.customProviders ?? [], id);
    if (!removed) return;
    if (isTauriRuntime() && removed.hasApiKey) {
      void revokeCustomSecretFromRust(removed.id);
    }
    const wasSelected = prev.provider === id;
    const cfg: PureConfig = {
      ...prev,
      customProviders: (prev.customProviders ?? []).filter(p => p.id !== id),
      provider: wasSelected ? 'deepseek-openai' : prev.provider,
      model: wasSelected ? '' : prev.model,
      baseURL: wasSelected ? '' : prev.baseURL,
      apiKey: wasSelected ? '' : prev.apiKey,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
    invalidateConfigCache();
    this.renderCustomProviderCards();
    const select = document.getElementById('cfg-provider') as HTMLSelectElement;
    select.value = cfg.provider;
    const nextCustom = customProviderFor(cfg.customProviders ?? [], cfg.provider);
    const nextDef = providerDef(cfg.provider);
    (document.getElementById('cfg-model') as HTMLInputElement).value =
      cfg.model || nextCustom?.defaultModel || nextDef?.defaultModel || '';
    (document.getElementById('cfg-baseurl') as HTMLInputElement).value =
      cfg.baseURL || nextCustom?.baseURL || nextDef?.baseURL || '';
    const keyInput = document.getElementById('cfg-apikey') as HTMLInputElement;
    keyInput.value = cfg.apiKey || nextCustom?.apiKey || '';
    delete keyInput.dataset.touched;
    this.updateProviderPresentation(cfg.provider);
    this.toast(t('llm.custom.deleted'));
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

    // Decouple "whose config the panel edits" (the hidden select, target of the
    // form fields) from "the active LLM" (cfg.provider). A card is only active
    // once it is fully configured AND the user explicitly selected it
    // (pendingActivation is null); while editing a card that is pending
    // activation the active provider and its model/baseURL/apiKey survive.
    const prev = loadConfig() ?? defaults();
    const editing = (document.getElementById('cfg-provider') as HTMLSelectElement).value;
    const active = this.pendingActivation === editing
      ? prev.provider
      : (this.isProviderConfigured(editing) ? editing : prev.provider);
    const editingActive = editing === active;
    const apiKey = (document.getElementById('cfg-apikey') as HTMLInputElement).value.trim();
    const model = (document.getElementById('cfg-model') as HTMLInputElement).value.trim();
    const baseURL = (document.getElementById('cfg-baseurl') as HTMLInputElement).value.trim();

    return {
      provider: active as PureConfig['provider'],
      customProviders: this.gatherCustomProviders(),
      providerModels: this.gatherProviderModels(),
      apiKey: editingActive ? apiKey : prev.apiKey,
      model: editingActive ? model : prev.model,
      baseURL: editingActive ? baseURL : prev.baseURL,
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
      mcpExcludedPrefixes: (document.getElementById('cfg-mcp-exclude-prefixes') as HTMLInputElement | null)?.value.split(',').map((p) => p.trim()).filter(Boolean) ?? [],
      proxy: normalizeProxyConfig({
        enabled: (document.getElementById('cfg-proxy-enabled') as HTMLInputElement | null)?.checked ?? false,
        llmEnabled: (document.getElementById('cfg-proxy-llm') as HTMLInputElement | null)?.checked ?? false,
        toolsEnabled: (document.getElementById('cfg-proxy-tools') as HTMLInputElement | null)?.checked ?? false,
        url: (document.getElementById('cfg-proxy-url') as HTMLInputElement | null)?.value ?? '',
        bypassProviders: normalizeProxyList((document.getElementById('cfg-proxy-bypass-providers') as HTMLInputElement | null)?.value),
        bypassModels: normalizeProxyList((document.getElementById('cfg-proxy-bypass-models') as HTMLInputElement | null)?.value),
      }),
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
      configVersion: Math.max(8, (loadConfig() ?? defaults()).configVersion),
      // Memory evolution thresholds（遗忘速度）—— only non-default fields.
      evolution: this.gatherEvolution(),
    };
  }

  // ── Auto-save (silent, no close, no toast) ──

  /** Debounced variant for text-input keystrokes (see the input listener in
   *  bindActions): trailing edge, ~300ms after typing pauses. */
  private debouncedAutoSave(): void {
    if (this.autoSaveTimer) clearTimeout(this.autoSaveTimer);
    this.autoSaveTimer = setTimeout(() => {
      this.autoSaveTimer = undefined;
      this.autoSave();
    }, 300);
  }

  /** Flush a pending debounced save synchronously (panel close, so the last
   *  keystrokes are never lost). */
  private flushAutoSave(): void {
    if (!this.autoSaveTimer) return;
    clearTimeout(this.autoSaveTimer);
    this.autoSaveTimer = undefined;
    this.autoSave();
  }

  private autoSave() {
    const prev = loadConfig() ?? defaults();
    const cfg = this.gatherForm();
    cfg.hasApiKey = prev.hasApiKey;

    const keyInput = document.getElementById('cfg-apikey') as HTMLInputElement;
    const selectedCustom = customProviderFor(cfg.customProviders ?? [], cfg.provider);
    if (selectedCustom) {
      // Custom provider: its key lives in its OWN Rust secret slot
      // (llm.apiKey.<id>, desktop) or the config entry (browser). Keyless
      // locals (Ollama) simply stay empty on both platforms.
      if (isTauriRuntime()) {
        if (selectedCustom.apiKey) {
          void storeCustomSecretInRust(selectedCustom.id, selectedCustom.apiKey);
          selectedCustom.hasApiKey = true;
        } else if (selectedCustom.hasApiKey && keyInput.dataset.touched === '1') {
          // User edited the field and cleared it → revoke the stored key.
          void revokeCustomSecretFromRust(selectedCustom.id);
          selectedCustom.hasApiKey = false;
          delete keyInput.dataset.touched;
        }
        selectedCustom.apiKey = ''; // never persist the raw key
      } else {
        selectedCustom.hasApiKey = !!selectedCustom.apiKey;
      }
      cfg.apiKey = '';
      cfg.hasApiKey = false;
    } else {
      if (!cfg.model) {
        cfg.model = defaultModelFor(cfg.provider);
      }
      if (isTauriRuntime()) {
        // Desktop: the key is owned by Rust secrets, never localStorage.
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

    // Refresh the provider card presentation (status pill + labels) after a
    // save — the pill must reflect the key state the user just changed, not
    // the state captured when the panel opened.
    const editing = (document.getElementById('cfg-provider') as HTMLSelectElement | null)?.value;
    if (editing) this.updateProviderPresentation(editing);

    this.onSave();
  }

  // ── Toast ──

  private toast(msg: string) {
    const el = document.getElementById('toast')!;
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => el.classList.add('hidden'), 2000);
  }
}
