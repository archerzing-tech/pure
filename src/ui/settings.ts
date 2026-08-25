// src/ui/settings.ts
// Modal settings panel. Lazy-loaded on first open (see src/ui/main.ts) so the
// eager startup bundle stays lean; the config model it edits lives in
// ./config.ts (needed at startup by chat.ts / main.ts) and provider defaults
// come from ../shared/providers.ts.

import { fetchAndDisplayVersion, checkForUpdatesManual } from './updater';
import { copyTextToClipboard } from '../shared/clipboard';
import { escapeHtml } from '../shared/html';
import { t, updateLanguage, applyTranslations, type Language as I18nLanguage } from '../shared/i18n';
import { isTauriRuntime, loadTauriCore } from '../shared/tauri';
import { formatBytes } from '../shared/format';
import { memoryStore } from './memoryStore';
import { EVOLUTION_DEFAULTS, healthScore, lifecycleOf, resolveEvolutionConfig } from '../adapter/memory/evolution';
import type { MemoryEntry } from '../adapter/memory/IMemoryStore';
import { GLOBAL_MEMORY_SCOPE } from '../shared/types';
import { buildMemoryExportJson, buildMemoryExportMarkdown, parseMemoryImport } from './memoryTransfer';
import { showToastHtml } from '../shared/toast';
import { showConfirmModal } from './modal';
import { DEFAULT_AUTO_CONTINUE_MAX_ROUNDS } from './autoContinue';
import { buildExportSavedToast } from './statsExportToast';
import {
  customProviderFor,
  customProviderLabel,
  defaultModelFor,
  isCustomProviderId,
  OLLAMA_PRESET,
  OPENAI_PRESET,
  OPENROUTER_PRESET,
  NVIDIA_PRESET,
  nextCustomProviderId,
  PROVIDERS,
  providerDef,
  providerOverrideFor,
  type CustomProvider,
} from '../shared/providers';
import { composeProxyUrl, effectiveProxyUrl, isUsableProxyUrl, normalizeProxyConfig, normalizeProxyList, parseProxyUrl, proxyUrlWithAuth } from '../shared/proxy';
import { probeLlmEndpoint } from '../shared/llmProbe';
import {
  defaults,
  DEFAULT_MAP_TILE_CACHE_MB,
  hasConfiguredKey,
  withDefaultModel,
  invalidateConfigCache,
  isDefaultMcpServer,
  loadConfig,
  persistConfig,
  SCRAPLING_MCP_PRESET,
  revokeCustomSecretFromRust,
  revokeSecretFromRust,
  storeCustomSecretInRust,
  storeSecretInRust,
  revokeProxyPasswordFromRust,
  storeProxyPasswordInRust,
  customSecretKey,
  modelListForProvider,
  providerHasKey,
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
  /** Bound in the constructor; refreshes the offline map-tile cache footprint. */
  private refreshMapTileUsage: () => Promise<void> = async () => {};
  /**
   * Provider whose expanded configuration panel is open (null = all cards
   * collapsed). Only one panel can be expanded at a time; the grid renders
   * the panel in place of that provider's card.
   */
  private editingProvider: string | null = null;
  /** Pending debounced save (text-input keystrokes only). */
  private autoSaveTimer: ReturnType<typeof setTimeout> | undefined;
  /** Reset timer for the connectivity-verify button's ✓ / ✗ flash. */
  private testConnResetTimer: ReturnType<typeof setTimeout> | undefined;

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
    void this.refreshMapTileUsage();
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
    if (category !== 'llm' && this.editingProvider) {
      // Leaving the LLM page collapses the expanded panel (edits are
      // auto-saved, so nothing is lost).
      this.collapseProviderPanel();
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

    // ── Map tile cache: usage + one-click clear + open directory (Tauri only) ──
    const mapTileUsageEl = document.getElementById('map-tile-usage');
    const mapTileDirEl = document.getElementById('map-tile-dir');
    const mapTileClearBtn = document.getElementById('map-tile-cache-clear') as HTMLButtonElement | null;
    const mapTileOpenBtn = document.getElementById('map-tile-cache-open') as HTMLButtonElement | null;
    let mapTileCacheDir: string | undefined;

    this.refreshMapTileUsage = async () => {
      if (!mapTileUsageEl || !isTauriRuntime()) return;
      try {
        const core = await loadTauriCore();
        const usage = await core?.invoke<{ files: number; bytes: number; dir: string }>('map_tile_cache_usage');
        mapTileUsageEl.textContent = usage && usage.files > 0
          ? `${usage.files} · ${formatBytes(usage.bytes)}`
          : t('mapCache.usageNone');
        mapTileCacheDir = usage?.dir;
        if (mapTileDirEl) mapTileDirEl.textContent = mapTileCacheDir ?? '—';
        if (mapTileOpenBtn) mapTileOpenBtn.disabled = !mapTileCacheDir;
      } catch (err) {
        console.error('[pure] map_tile_cache_usage failed:', err);
      }
    };

    mapTileOpenBtn?.addEventListener('click', async () => {
      if (!isTauriRuntime() || !mapTileCacheDir) return;
      try {
        const core = await loadTauriCore();
        await core?.invoke('open_path', { path: mapTileCacheDir });
      } catch (err) {
        console.error('[pure] open map tile cache dir failed:', err);
        this.toast(t('mapCache.openFailed'));
      }
    });

    mapTileClearBtn?.addEventListener('click', async () => {
      if (!isTauriRuntime()) return;
      mapTileClearBtn.disabled = true;
      try {
        const core = await loadTauriCore();
        const res = await core?.invoke<{ deleted: number; freedBytes: number }>('clear_map_tile_cache');
        const deleted = res?.deleted ?? 0;
        this.toast(deleted > 0
          ? t('mapCache.cleared').replace('{n}', String(deleted)).replace('{size}', formatBytes(res?.freedBytes ?? 0))
          : t('mapCache.nothing'));
      } catch (err) {
        console.error('[pure] clear_map_tile_cache failed:', err);
        this.toast(t('mapCache.clearFailed'));
      } finally {
        mapTileClearBtn.disabled = false;
        void this.refreshMapTileUsage();
      }
    });

    // ── Skill Hub: browse + install third-party skills ──
    const hubRepoSelect = document.getElementById('hub-repo') as HTMLSelectElement | null;
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

    // Filter the browsed skill cards by name/description as the user types.
    const hubFilterEl = document.getElementById('hub-filter') as HTMLInputElement | null;
    hubFilterEl?.addEventListener('input', () => {
      const query = hubFilterEl.value.trim().toLowerCase();
      hubGroupedEl?.querySelectorAll<HTMLElement>('.hub-skill-card').forEach(card => {
        const name = card.querySelector('.skill-name')?.textContent?.toLowerCase() ?? '';
        const desc = card.querySelector('.skill-desc')?.textContent?.toLowerCase() ?? '';
        const matches = !query || name.includes(query) || desc.includes(query);
        card.classList.toggle('hidden', !matches);
      });
    });

    hubBrowseBtn?.addEventListener('click', async () => {
      const repo = normalizeHubRepo(hubRepoSelect?.value.trim() || DEFAULT_HUB_REPO);
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
        persistConfig(cfg);
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
        persistConfig(cfg);
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
      persistConfig(cfg);
      invalidateConfigCache();
      renderInstalled();
      setHubStatus(t('hub.removed'));
    });

    // Installed list renders on first bind (the provider dropdown always has a
    // default selection, so it needs no seeding).
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

    // ── System permissions: status + native request dialog (Tauri only) ──
    const permSection = document.getElementById('perm-section');
    if (permSection) {
      if (!isTauriRuntime()) {
        permSection.hidden = true;
      } else {
        permSection.addEventListener('click', async (event) => {
          const btn = (event.target as HTMLElement).closest('.perm-request-btn') as HTMLButtonElement | null;
          if (!btn || btn.disabled) return;
          const kind = btn.getAttribute('data-perm');
          if (!kind) return;
          btn.disabled = true;
          btn.textContent = t('perm.requesting');
          try {
            const core = await loadTauriCore();
            // Blocks until the user answers the macOS dialog (location:
            // system dialog; camera/mic: requestAccess completion).
            await core?.invoke<string>('request_system_permission', { kind });
            await this.refreshSystemPermissions();
            this.toast(t('perm.status.updated'));
          } catch (err) {
            console.error('[pure] request_system_permission failed:', err);
            this.toast(t('perm.requestFailed'));
          } finally {
            btn.disabled = false;
            btn.textContent = t('perm.request');
          }
        });
      }
    }

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

    // ── LLM page: default-model bar + provider card grid ──
    // The whole LLM page is event-delegated on the grid container: cards,
    // the expanded panel and every model-row action are re-rendered on save,
    // so direct listeners would need constant rebinding.
    const llmGrid = document.getElementById('llm-provider-grid');
    llmGrid?.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      // Provider-id chip: copy the id (proxy bypass rules) without opening
      // the card. Checked before every other action since the chip sits
      // inside the card / panel buttons.
      const idChip = target.closest<HTMLElement>('[data-copy-provider-id]');
      if (idChip) {
        event.stopPropagation();
        void this.copyProviderId(idChip.dataset.copyProviderId ?? '');
        return;
      }
      // Expanded-panel actions.
      if (target.closest('#cfg-test-conn-btn')) {
        void this.testProviderConnection();
        return;
      }
      const removeRow = target.closest<HTMLElement>('[data-remove-row]');
      if (removeRow) {
        event.stopPropagation();
        this.removeModelRow(parseInt(removeRow.dataset.removeRow || '0', 10));
        return;
      }
      if (target.closest('#cfg-add-model-btn')) { this.addModelRow(); return; }
      if (target.closest('#cfg-clear-models-btn')) { this.clearModels(); return; }
      if (target.closest('#cfg-fetch-models-btn')) { void this.fetchProviderModels(); return; }
      if (target.closest('#provider-delete-btn')) { this.removeCustomProvider(this.editingProvider || ''); return; }
      if (target.closest('[data-close-panel]')) { this.collapseProviderPanel(); return; }
      if (target.closest('[data-save-panel]')) { this.saveAndCollapsePanel(); return; }
      const toggleKey = target.closest('#cfg-toggle-key');
      if (toggleKey) {
        const keyInput = document.getElementById('cfg-apikey') as HTMLInputElement | null;
        if (!keyInput) return;
        const isPassword = keyInput.type === 'password';
        keyInput.type = isPassword ? 'text' : 'password';
        toggleKey.querySelector('svg')?.style.setProperty('opacity', isPassword ? '1' : '0.5');
        return;
      }
      // "＋ 新增供应商" card.
      if (target.closest('[data-add-provider]')) {
        this.addBlankCustomProvider();
        return;
      }
      // Collapsed provider card → expand (or collapse when re-clicked).
      const card = target.closest<HTMLElement>('.llm-provider-card');
      if (card?.dataset.provider) this.toggleProviderPanel(card.dataset.provider);
    });

    // Enter in a model row commits the typed id / name (add or rename).
    llmGrid?.addEventListener('keydown', (event) => {
      const input = event.target as HTMLInputElement;
      if (input && (input.classList.contains('llm-model-row-id') || input.classList.contains('llm-model-row-name')) && event.key === 'Enter') {
        event.preventDefault();
        this.commitModelRows();
      }
    });

    // Live edits inside the expanded panel: per-keystroke saves are debounced,
    // the API-key field additionally tracks "touched" so a cleared field only
    // revokes a stored secret when the user actually edited it.
    llmGrid?.addEventListener('input', (event) => {
      const el = event.target as HTMLInputElement;
      if (el.id === 'cfg-apikey') {
        if (el.value.trim()) el.dataset.touched = '1';
        this.debouncedAutoSave();
        return;
      }
      if (el.id === 'cfg-custom-name-edit' || el.id === 'cfg-baseurl' || el.id === 'cfg-imagegen-model') {
        this.debouncedAutoSave();
      }
      // Typing in a model row: debounce, then re-render UNLESS the caret is
      // still inside the list (the autoSave grid re-render would kill focus).
      if (el.classList.contains('llm-model-row-id') || el.classList.contains('llm-model-row-name')) {
        this.debouncedAutoSave();
      }
    });
    llmGrid?.addEventListener('change', (event) => {
      const el = event.target as HTMLInputElement;
      if (el.id === 'cfg-imagegen') this.autoSave();
      // Default-model radio inside a row → commit the selection.
      if (el.classList.contains('llm-model-row-radio')) this.commitModelRows();
    });

    // Default-model bar: open the grouped model menu, pick a model, close on
    // outside click.
    const defaultBtn = document.getElementById('llm-default-model-btn');
    const defaultMenu = document.getElementById('llm-default-model-menu');
    defaultBtn?.addEventListener('click', () => this.toggleDefaultModelMenu());
    defaultMenu?.addEventListener('click', (event) => {
      const item = (event.target as HTMLElement).closest<HTMLElement>('[data-default-model]');
      if (!item) return;
      const parts = (item.dataset.defaultModel || '').split('::');
      if (parts.length === 2) this.setDefaultModelFromMenu(parts[0], parts[1]);
    });
    document.addEventListener('click', (event) => {
      if (!defaultMenu || defaultMenu.hidden) return;
      const t = event.target as HTMLElement;
      if (defaultMenu.contains(t) || defaultBtn?.contains(t)) return;
      this.closeDefaultModelMenu();
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
    document.getElementById('cfg-proxy-detect-btn')?.addEventListener('click', () => void this.detectSystemProxy());

    // The address is split into scheme + host + port fields; keep the hidden
    // cfg-proxy-url mirror in sync so save/test read one composed value.
    const recomposeProxyUrl = (): void => {
      const urlEl = document.getElementById('cfg-proxy-url') as HTMLInputElement | null;
      if (!urlEl) return;
      const scheme = (document.getElementById('cfg-proxy-scheme') as HTMLSelectElement | null)?.value ?? '';
      const host = (document.getElementById('cfg-proxy-host') as HTMLInputElement | null)?.value ?? '';
      const port = (document.getElementById('cfg-proxy-port') as HTMLInputElement | null)?.value ?? '';
      urlEl.value = composeProxyUrl(scheme, host, port);
    };
    ['#cfg-proxy-scheme', '#cfg-proxy-host', '#cfg-proxy-port'].forEach(sel => {
      document.querySelector(sel)?.addEventListener('change', recomposeProxyUrl);
      document.querySelector(sel)?.addEventListener('input', recomposeProxyUrl);
    });
    document.getElementById('cfg-proxy-mode')?.addEventListener('change', () => this.updateProxyModeVisibility());

    // The max-rounds field only makes sense while auto-continue is on — reveal
    // it when the toggle is checked, hide it otherwise.
    document.getElementById('cfg-auto-continue')?.addEventListener('change', () => this.updateAutoContinueVisibility());

    // Auto-save on all input/select/checkbox changes
    const autoSaveSelectors = [
      // LLM fields (api key / name / base URL / image gen / model editor) are
      // handled by the grid-delegated listeners above — the panel is
      // re-rendered on every save, so a static binding would go stale.
      '#cfg-language',
      '#cfg-city',
      '#cfg-fontsize', '#cfg-density',
      '#cfg-tool-fs', '#cfg-tool-cmd', '#cfg-tool-git', '#cfg-tool-browser',
      '#cfg-tavily-key', '#cfg-serper-key',
      '#cfg-mcp-exclude-prefixes',
      '#cfg-proxy-enabled', '#cfg-proxy-mode', '#cfg-proxy-llm', '#cfg-proxy-tools', '#cfg-proxy-scheme', '#cfg-proxy-host', '#cfg-proxy-port', '#cfg-proxy-username', '#cfg-proxy-password', '#cfg-proxy-bypass-providers',
      '#cfg-proxy-probe-0-enabled', '#cfg-proxy-probe-0-url', '#cfg-proxy-probe-1-enabled', '#cfg-proxy-probe-1-url', '#cfg-proxy-probe-2-enabled', '#cfg-proxy-probe-2-url',
      '#cfg-streaming-render',
      '#cfg-auto-continue',
      '#cfg-auto-continue-rounds',
      '#cfg-permission-mode', '#cfg-perm-read', '#cfg-perm-write', '#cfg-perm-cmd', '#cfg-perm-git',
      '.cfg-skill-toggle',
      // Map-tile cache cap (number input saves on change/blur).
      '#cfg-map-tile-cache-mb', '#cfg-map-tianditu-key',
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
            // The proxy password is stored in Rust secrets; a typed value
            // marks the field touched so autoSave can tell "user cleared it"
            // (revoke) apart from "never retyped it" (keep the stored secret).
            if (el.id === 'cfg-proxy-password' && (el as HTMLInputElement).value.trim()) (el as HTMLInputElement).dataset.touched = '1';
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

    // ── Memory: per-entry delete（记忆卡片的逐条删除，确认后移除）──
    // 委托到容器而不是每卡绑定：卡片随衰减/删除重渲染，委托免于反复重建。
    document.getElementById('memory-list')?.addEventListener('click', async (event) => {
      const btn = (event.target as HTMLElement).closest<HTMLElement>('[data-mem-del]');
      if (!btn) return;
      event.stopPropagation();
      const id = btn.dataset.memDel || '';
      if (!id) return;
      const ok = await showConfirmModal({
        title: t('memory.deleteTitle'),
        message: t('memory.deleteConfirm'),
        okLabel: t('memory.deleteOk'),
        cancelLabel: t('common.cancel'),
        danger: true,
      });
      if (!ok) return;
      try {
        await memoryStore.removeById(id);
        this.toast(t('memory.deleted'));
        this.renderMemoryDashboard();
      } catch (err) {
        console.error('[pure] memory delete failed:', err);
        this.toast(t('memory.deleteFailed'));
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

    // Keyboard: Escape collapses the expanded provider panel first, then the
    // default-model menu, and only then leaves Settings.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !this.visible) return;
      const defaultMenu = document.getElementById('llm-default-model-menu');
      if (this.editingProvider) {
        this.collapseProviderPanel();
        return;
      }
      if (defaultMenu && !defaultMenu.hidden) {
        this.closeDefaultModelMenu();
        return;
      }
      this.close();
    });
  }

  // ── LLM page: default-model bar + provider card grid ──

  /** Provider mark letters per built-in id (kept short for the card chip). */
  private static readonly PROVIDER_MARKS: Record<string, string> = {
    'deepseek-openai': 'DS',
    qwen: 'Q',
    glm: 'GLM',
    moonshot: 'K',
    minimax: 'MM',
    openai: 'AI',
    openrouter: 'OR',
    nvidia: 'NV',
  };

  /** Toggle the expanded panel for a provider (one at a time). Clicking the
   *  card again — or ✕ / 保存 — collapses it; edits are auto-saved, so the
   *  panel always reflects the persisted config on re-open. */
  private toggleProviderPanel(provider: string): void {
    if (this.editingProvider === provider) {
      this.collapseProviderPanel();
      return;
    }
    if (this.editingProvider) this.flushAutoSave();
    this.editingProvider = provider;
    this.renderProviderGrid();
    const nameEl = document.getElementById('cfg-custom-name-edit') as HTMLInputElement | null;
    nameEl?.focus();
    nameEl?.select();
  }

  /** Collapse the expanded panel (auto-saves pending edits first). */
  private collapseProviderPanel(): void {
    this.flushAutoSave();
    this.editingProvider = null;
    this.renderProviderGrid();
    this.renderDefaultBar();
  }

  /** 保存 button: flush, collapse, toast. */
  private saveAndCollapsePanel(): void {
    this.flushAutoSave();
    this.editingProvider = null;
    this.renderProviderGrid();
    this.renderDefaultBar();
    this.toast(t('llm.panel.saved'));
  }

  /** Render the provider grid: collapsed cards (2-col) + the expanded panel
   *  (full width) when one provider is being edited + the add-provider card. */
  private renderProviderGrid(): void {
    const grid = document.getElementById('llm-provider-grid');
    if (!grid) return;
    const cfg = loadConfig() ?? defaults();
    const customs = cfg.customProviders ?? [];
    const overrides = cfg.providerOverrides ?? {};
    const cards: string[] = [];
    const editing = this.editingProvider;

    const cardOrPanel = (id: string, label: string, defaultModel: string, hasKey: boolean, custom: boolean, mark: string, markClass: string): string => {
      if (editing === id) {
        return this.expandedPanelTemplate(id, label, defaultModel, hasKey, custom, mark, markClass);
      }
      const status = hasKey ? t('llm.card.configured') : t('llm.card.notConfigured');
      return `<button type="button" class="llm-provider-card" data-provider="${escapeHtml(id)}" title="${t('llm.card.open')}">
        <span class="llm-provider-card-top">
          <span class="provider-card-mark ${markClass}">${escapeHtml(mark)}</span>
          <span class="llm-provider-card-status${hasKey ? '' : ' llm-provider-card-status-empty'}">${escapeHtml(status)}</span>
        </span>
        <span class="llm-provider-card-name">${escapeHtml(label)}</span>
        <span class="llm-provider-card-id" data-copy-provider-id="${escapeHtml(id)}" title="${t('llm.card.id.copy')}"><code>${escapeHtml(id)}</code><i aria-hidden="true">⧉</i></span>
        <span class="llm-provider-card-meta">${escapeHtml(defaultModel || '—')}</span>
      </button>`;
    };

    // Built-ins first (registry order), then custom providers, then the add card.
    for (const def of PROVIDERS) {
      const custom = customProviderFor(customs, def.id);
      const override = providerOverrideFor(overrides, def.id);
      const label = custom?.name ?? override?.name ?? t(def.i18nKey);
      const defaultModel = custom?.defaultModel
        ?? (def.id === cfg.provider ? cfg.model.trim() : cfg.providerModels?.[def.id]?.[0])
        ?? def.defaultModel;
      const hasKey = providerHasKey(cfg, def.id);
      cards.push(cardOrPanel(
        def.id,
        label,
        defaultModel,
        hasKey,
        !!custom,
        SettingsPanel.PROVIDER_MARKS[def.id] ?? (def.label.slice(0, 2) || 'P').toUpperCase(),
        `provider-mark-${def.id}`,
      ));
    }
    for (const c of customs) {
      cards.push(cardOrPanel(
        c.id,
        c.name,
        c.defaultModel || c.models[0] || '',
        providerHasKey(cfg, c.id),
        true,
        (c.name.slice(0, 2) || 'C').toUpperCase(),
        c.id === 'ollama' ? 'provider-mark-ollama' : 'provider-mark-custom',
      ));
    }
    cards.push(`<button type="button" class="llm-provider-card llm-provider-add-card" data-add-provider data-i18n="llm.addProvider">
      <span class="llm-provider-add-plus" aria-hidden="true">＋</span>
      <span class="llm-provider-add-label" data-i18n="llm.addProvider">＋ 新增供应商</span>
      <span class="llm-provider-add-hint" data-i18n="llm.addProvider.hint">添加 OpenAI 兼容的自定义端点</span>
    </button>`);

    grid.innerHTML = cards.join('');
    const count = document.getElementById('llm-provider-count');
    if (count) count.textContent = String(PROVIDERS.length + customs.length);
    if (editing) this.renderModelList(editing);
    applyTranslations();
  }

  /** Full-width expanded configuration panel for one provider. Field ids are
   *  stable (cfg-apikey / cfg-baseurl / cfg-model-list / …) so the shared
   *  gather / model-editor logic keeps working; only one panel exists at a
   *  time, so the ids never collide. */
  private expandedPanelTemplate(id: string, label: string, defaultModel: string, hasKey: boolean, custom: boolean, mark: string, markClass: string): string {
    const cfg = loadConfig() ?? defaults();
    const customEntry = customProviderFor(cfg.customProviders ?? [], id);
    const def = providerDef(id);
    const override = providerOverrideFor(cfg.providerOverrides, id);
    const baseURL = customEntry?.baseURL ?? override?.baseURL ?? '';
    const savedKey = isTauriRuntime() && (customEntry?.hasApiKey === true || override?.hasApiKey === true || (id === cfg.provider && cfg.hasApiKey === true));
    const imageGen = customEntry?.imageGen === true;
    const imageGenModel = customEntry?.imageGenModel ?? '';
    const keyPlaceholder = savedKey
      ? t('llm.apiKey.savedPlaceholder')
      : (customEntry?.local ? t('llm.custom.apiKeyOptional.hint') : t('llm.apiKey.placeholder'));
    const urlPlaceholder = custom
      ? t('llm.baseURL.placeholder')
      : t('llm.baseURL.builtinPlaceholder').replace('{url}', def?.baseURL ?? '');
    const namePlaceholder = custom ? t('llm.custom.name.ph') : t('llm.panel.name.placeholder');
    return `<div class="llm-provider-panel" data-provider="${escapeHtml(id)}">
      <div class="llm-provider-panel-head">
        <span class="provider-card-mark ${markClass}">${escapeHtml(mark)}</span>
        <div class="llm-provider-panel-head-copy">
          <span class="llm-kicker">${custom ? t('llm.custom.formTitle') : t('llm.connection.settings')}</span>
        </div>
        <button type="button" class="llm-provider-panel-close" data-close-panel aria-label="${t('llm.panel.collapse')}" title="${t('llm.panel.collapse')}">✕</button>
      </div>
      <div class="llm-provider-panel-body">
        <div class="llm-form-row">
          <label class="llm-form-label" for="cfg-provider-id" data-i18n="llm.panel.id" data-i18n-title="llm.panel.id.hint" title="直连例外等场景使用的机器标识，点击复制">供应商 ID</label>
          <div class="llm-form-input-group">
            <input id="cfg-provider-id" class="setting-input llm-form-input" type="text" value="${escapeHtml(id)}" readonly aria-label="${t('llm.panel.id')}" />
            <button id="cfg-copy-provider-id" class="setting-icon-btn" type="button" data-copy-provider-id="${escapeHtml(id)}" data-i18n-title="llm.card.id.copy" title="复制供应商 ID（用于代理直连例外）" aria-label="${t('llm.card.id.copy')}">⧉</button>
          </div>
        </div>
        <div class="llm-form-row">
          <label class="llm-form-label" for="cfg-custom-name-edit" data-i18n="llm.panel.name">供应商名称</label>
          <input id="cfg-custom-name-edit" class="setting-input llm-form-input" type="text" value="${escapeHtml(label)}" placeholder="${escapeHtml(namePlaceholder)}" aria-label="${t('llm.panel.name')}" />
        </div>
        <div class="llm-form-row">
          <label class="llm-form-label" for="cfg-baseurl" data-i18n="llm.baseURL">Base URL</label>
          <input id="cfg-baseurl" class="setting-input llm-form-input" type="text" value="${escapeHtml(baseURL)}" placeholder="${escapeHtml(urlPlaceholder)}" autocomplete="off" />
        </div>
        <div class="llm-form-row">
          <label class="llm-form-label" for="cfg-apikey" data-i18n="llm.apiKey">API Key</label>
          <div class="llm-form-input-group">
            <input id="cfg-apikey" class="setting-input llm-form-input" type="password" placeholder="${escapeHtml(keyPlaceholder)}" autocomplete="off" />
            <button id="cfg-toggle-key" class="setting-icon-btn" type="button" data-i18n-title="llm.apiKey.toggle" title="Toggle visibility"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button>
            <button id="cfg-test-conn-btn" class="setting-btn llm-test-conn-btn" type="button" data-i18n="llm.connection.verify">连通性验证</button>
          </div>
        </div>
        <div class="llm-form-row llm-form-row-models">
          <span class="llm-form-label" data-i18n="llm.model.library">模型列表</span>
          <div class="llm-form-row-actions">
            <span class="setting-hint" data-i18n="llm.model.hint">模型标识符（可添加多个，点击模型行设为默认）</span>
            ${custom ? `<button id="cfg-fetch-models-btn" class="fetch-models-btn" type="button" data-i18n="llm.custom.fetch" title="从 API 获取模型列表">⟳ 获取模型</button>` : ''}
            <button id="cfg-add-model-btn" class="provider-model-add-btn" type="button" data-i18n="llm.custom.addModel" data-i18n-title="llm.custom.addModelTitle" title="将输入框中的模型加入列表">＋ 添加模型</button>
            <button id="cfg-clear-models-btn" class="provider-model-clear-btn" type="button" data-i18n="llm.custom.clearModels" data-i18n-title="llm.custom.clearModelsTitle" title="删除除默认模型外的所有模型">全部删除</button>
          </div>
        </div>
        <div class="llm-model-rows-wrap">
          <input id="cfg-model" type="hidden" value="${escapeHtml(defaultModel)}" />
          <div id="cfg-model-list" class="llm-model-rows" role="list"></div>
        </div>
        ${custom ? `
        <div class="llm-form-row">
          <label class="llm-form-label" for="cfg-imagegen" data-i18n="llm.custom.imageGen">图片生成（文生图）</label>
          <div class="llm-form-input-group">
            <input id="cfg-imagegen-model" class="setting-input llm-form-input" type="text" placeholder="gpt-image-1" value="${escapeHtml(imageGenModel)}" aria-label="Image model" />
            <label class="toggle"><input type="checkbox" id="cfg-imagegen" ${imageGen ? 'checked' : ''} /><span class="toggle-slider"></span></label>
          </div>
        </div>` : ''}
      </div>
      <div class="llm-provider-panel-foot">
        ${custom ? `<button id="provider-delete-btn" class="setting-btn danger" data-i18n="llm.custom.deleteBtn">删除</button>` : ''}
        <span class="llm-provider-panel-spacer"></span>
        <button type="button" class="setting-btn primary" data-save-panel data-i18n="llm.panel.save">保存</button>
      </div>
    </div>`;
  }

  /** Provider-level connectivity test (the API-key row button): runs the SAME
   *  probe real chats use (Rust reqwest on desktop, fetch mirror in browser),
   *  passing the current default model so a typo'd / retired model name fails
   *  loudly instead of passing a generic endpoint check. The button shows
   *  ✓ / ✗ briefly. */
  private async testProviderConnection(): Promise<void> {
    const provider = this.editingProvider;
    if (!provider) return;
    const cfg = loadConfig() ?? defaults();
    const custom = customProviderFor(cfg.customProviders ?? [], provider);
    const def = providerDef(provider);
    const baseURL = ((document.getElementById('cfg-baseurl') as HTMLInputElement | null)?.value.trim()
      || custom?.baseURL
      || def?.baseURL
      || '').replace(/\/+$/, '');
    const apiKey = (document.getElementById('cfg-apikey') as HTMLInputElement | null)?.value.trim() || '';
    if (!baseURL) {
      this.toast(t('llm.custom.needURL'));
      return;
    }
    if (!apiKey && !custom?.local && !(custom?.hasApiKey || providerOverrideFor(cfg.providerOverrides, provider)?.hasApiKey)) {
      this.toast(t('llm.model.testNeedKey'));
      return;
    }
    const btn = document.getElementById('cfg-test-conn-btn') as HTMLButtonElement | null;
    if (!btn) return;
    if (this.testConnResetTimer) clearTimeout(this.testConnResetTimer);
    btn.disabled = true;
    btn.textContent = t('llm.connection.testing');
    const started = performance.now();
    let probe: { ok: boolean; status?: number; latencyMs?: number; error?: string };
    if (isTauriRuntime()) {
      const proxy = normalizeProxyConfig(cfg.proxy);
      try {
        const core = await loadTauriCore();
        if (!core) throw new Error('Tauri runtime unavailable');
        const override = providerOverrideFor(cfg.providerOverrides, provider);
        probe = await core.invoke('test_llm_connection', {
          baseUrl: baseURL,
          apiKey,
          secretKey: custom ? customSecretKey(custom.id)
            : override?.hasApiKey ? customSecretKey(provider)
            : undefined,
          proxyUrl: effectiveProxyUrl(proxy, 'llm') ?? '',
          proxyBypassProviders: proxy?.bypassProviders ?? [],
          provider,
        });
      } catch (err) {
        probe = { ok: false, error: (err as Error)?.message || String(err) };
      }
    } else {
      probe = await probeLlmEndpoint(baseURL, apiKey);
    }
    const elapsed = Math.max(0, Math.round(performance.now() - started));
    btn.disabled = false;
    btn.classList.remove('llm-model-test-ok', 'llm-model-test-fail');
    if (probe.ok) {
      btn.textContent = t('llm.connection.testOk').replace('{ms}', String(probe.latencyMs ?? elapsed));
      btn.classList.add('llm-model-test-ok');
      btn.title = t('llm.model.testOk').replace('{ms}', String(probe.latencyMs ?? elapsed));
    } else {
      btn.textContent = '✗ ' + t('llm.connection.testFailed');
      btn.classList.add('llm-model-test-fail');
      btn.title = t('llm.model.testErr').replace('{err}', probe.error || t('llm.model.testFailed'));
    }
    this.testConnResetTimer = setTimeout(() => {
      btn.textContent = t('llm.connection.verify');
      btn.classList.remove('llm-model-test-ok', 'llm-model-test-fail');
    }, 2500);
  }

  // ── Default-model bar (top strip) ──

  /** The bar shows the default model + its provider; empty state when no
   *  model is configured. Picking from the dropdown writes BOTH cfg.model and
   *  cfg.provider (derived from the model's provider) — there is no separate
   *  "active provider" concept anymore. */
  private renderDefaultBar(): void {
    const nameEl = document.getElementById('llm-default-model-name');
    const providerEl = document.getElementById('llm-default-model-provider');
    if (!nameEl || !providerEl) return;
    const cfg = loadConfig() ?? defaults();
    const model = cfg.model.trim();
    if (model) {
      nameEl.textContent = model;
      nameEl.classList.remove('llm-default-model-name-empty');
      providerEl.textContent = customProviderLabel(cfg.customProviders ?? [], cfg.provider, cfg.providerOverrides);
    } else {
      nameEl.textContent = t('llm.defaultBar.empty');
      nameEl.classList.add('llm-default-model-name-empty');
      providerEl.textContent = '';
    }
  }

  private toggleDefaultModelMenu(): void {
    const menu = document.getElementById('llm-default-model-menu');
    const btn = document.getElementById('llm-default-model-btn');
    if (!menu) return;
    if (menu.hidden) {
      this.renderDefaultModelMenu();
      menu.hidden = false;
      btn?.setAttribute('aria-expanded', 'true');
    } else {
      this.closeDefaultModelMenu();
    }
  }

  private closeDefaultModelMenu(): void {
    const menu = document.getElementById('llm-default-model-menu');
    const btn = document.getElementById('llm-default-model-btn');
    if (!menu) return;
    menu.hidden = true;
    btn?.setAttribute('aria-expanded', 'false');
  }

  /** Grouped model picker: every provider's model library, grouped by
   *  provider, current default marked. Empty libraries are skipped. */
  private renderDefaultModelMenu(): void {
    const menu = document.getElementById('llm-default-model-menu');
    if (!menu) return;
    const cfg = loadConfig() ?? defaults();
    const customs = cfg.customProviders ?? [];
    const groups: Array<{ id: string; label: string; models: string[] }> = [];
    for (const def of PROVIDERS) {
      const custom = customProviderFor(customs, def.id);
      const override = providerOverrideFor(cfg.providerOverrides, def.id);
      const label = custom?.name ?? override?.name ?? t(def.i18nKey);
      const models = modelListForProvider(cfg, def.id);
      if (models.length > 0) groups.push({ id: def.id, label, models });
    }
    for (const c of customs) {
      const models = modelListForProvider(cfg, c.id);
      if (models.length > 0) groups.push({ id: c.id, label: c.name, models });
    }
    menu.innerHTML = groups.map(g => {
      const custom = customProviderFor(customs, g.id);
      const names = custom?.modelNames ?? cfg.providerModelNames?.[g.id] ?? {};
      return `
      <div class="llm-default-menu-group">
        <div class="llm-default-menu-group-title">${escapeHtml(g.label)}</div>
        ${g.models.map(m => {
          const isDefault = g.id === cfg.provider && m === cfg.model;
          const displayName = names[m];
          return `<button type="button" class="llm-default-menu-item${isDefault ? ' active' : ''}" data-default-model="${escapeHtml(g.id)}::${escapeHtml(m)}">
            <span class="llm-default-menu-check" aria-hidden="true">${isDefault ? '✓' : ''}</span>
            <span class="llm-default-menu-model">${escapeHtml(displayName ? `${m} · ${displayName}` : m)}</span>
          </button>`;
        }).join('')}
      </div>`;
    }).join('');
    applyTranslations();
  }

  /** Pick a default model from the dropdown: the provider is derived from the
   *  model's library, the model is ensured to be in that library, and the
   *  choice persists immediately. */
  private setDefaultModelFromMenu(provider: string, model: string): void {
    const prev = loadConfig() ?? defaults();
    const cfg = withDefaultModel(prev, provider, model);
    persistConfig(cfg);
    invalidateConfigCache();
    this.closeDefaultModelMenu();
    this.renderDefaultBar();
    this.renderProviderGrid();
    this.autoSave();
    this.toast(t('llm.custom.defaultChanged').replace('{m}', model));
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
    const url = composeProxyUrl(
      (document.getElementById('cfg-proxy-scheme') as HTMLSelectElement | null)?.value ?? '',
      (document.getElementById('cfg-proxy-host') as HTMLInputElement | null)?.value ?? '',
      (document.getElementById('cfg-proxy-port') as HTMLInputElement | null)?.value ?? '',
    );
    const username = (document.getElementById('cfg-proxy-username') as HTMLInputElement | null)?.value ?? '';
    const password = (document.getElementById('cfg-proxy-password') as HTMLInputElement | null)?.value ?? '';
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
    const probeUrls = [0, 1, 2]
      .map((i) => {
        const enabled = (document.getElementById(`cfg-proxy-probe-${i}-enabled`) as HTMLInputElement | null)?.checked ?? false;
        const probeUrl = (document.getElementById(`cfg-proxy-probe-${i}-url`) as HTMLInputElement | null)?.value.trim() ?? '';
        return enabled && probeUrl ? probeUrl : null;
      })
      .filter((u): u is string => Boolean(u));
    if (probeUrls.length === 0) {
      this.toast(t('proxy.test.noProbes'));
      return;
    }
    if (btn) {
      btn.disabled = true;
      btn.textContent = t('proxy.testing');
    }
    try {
      const core = await loadTauriCore();
      const reached = await core?.invoke<string>('test_proxy', { proxyUrl: proxyUrlWithAuth(url, username, password), probeUrls });
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

  /**
   * Read the OS-level system proxy (macOS scutil / Windows registry) or the
   * standard proxy environment variables and back-fill the scheme/host/port
   * fields — a Clash / VPN / corporate proxy already active on the machine is
   * one click away instead of hand-typed. Desktop-only: browser JS cannot
   * read the OS proxy, so be honest instead of pretending a detection ran.
   */
  private async detectSystemProxy(): Promise<void> {
    const btn = document.getElementById('cfg-proxy-detect-btn') as HTMLButtonElement | null;
    if (!isTauriRuntime()) {
      this.toast(t('proxy.detect.browserOnly'));
      return;
    }
    if (btn) {
      btn.disabled = true;
      btn.textContent = t('proxy.detecting');
    }
    try {
      const core = await loadTauriCore();
      const found = await core?.invoke<
        { scheme: string; host: string; port: string; source: string; detail: string } | null
      >('detect_system_proxy');
      if (!found) {
        this.toast(t('proxy.detect.none'));
        return;
      }
      const schemeEl = document.getElementById('cfg-proxy-scheme') as HTMLSelectElement | null;
      const hostEl = document.getElementById('cfg-proxy-host') as HTMLInputElement | null;
      const portEl = document.getElementById('cfg-proxy-port') as HTMLInputElement | null;
      if (schemeEl) schemeEl.value = found.scheme;
      if (hostEl) hostEl.value = found.host;
      if (portEl) portEl.value = found.port;
      this.autoSave();
      const source = found.detail
        ? `${t(`proxy.detect.source.${found.source}`)} ${found.detail}`
        : t(`proxy.detect.source.${found.source}`);
      this.toast(`${t('proxy.detect.ok')}：${source}`);
    } catch (err) {
      console.warn('[pure] system proxy detection failed:', err);
      this.toast(t('proxy.detect.fail') + '：' + ((err as Error)?.message || String(err)));
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = t('proxy.detect');
      }
    }
  }

  /**
   * Show/hide the manual-address-only proxy fields (address row, username,
   * password) based on the 代理方式 selector. In system mode the app resolves
   * the OS proxy transparently, so the hand-typed address is irrelevant.
   */
  private updateProxyModeVisibility(): void {
    const mode = (document.getElementById('cfg-proxy-mode') as HTMLSelectElement | null)?.value;
    const system = mode === 'system';
    document.querySelectorAll('.proxy-manual-field').forEach(el => {
      el.classList.toggle('hidden', system);
    });
  }

  /** Show/hide the max-rounds field based on the auto-continue toggle: the cap
   *  is meaningless while the feature is off, so it stays collapsed then. */
  private updateAutoContinueVisibility(): void {
    const on = (document.getElementById('cfg-auto-continue') as HTMLInputElement | null)?.checked ?? false;
    document.querySelectorAll('.auto-continue-rounds-row').forEach(el => {
      el.classList.toggle('hidden', !on);
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

  // ── System permissions: native macOS status (Tauri only) ──

  /** Refresh the location / camera / microphone status rows in Settings →
   * General. Each row shows a colored dot + localized status; the request
   * button stays visible while the OS can still prompt (not determined) and
   * is hidden once the user has already decided (authorized / denied / …). */
  private async refreshSystemPermissions(): Promise<void> {
    if (!isTauriRuntime()) return;
    const core = await loadTauriCore();
    if (!core) return;
    const kinds = ['location', 'camera', 'microphone'] as const;
    for (const kind of kinds) {
      const dot = document.getElementById(`perm-${kind}-dot`);
      const statusEl = document.getElementById(`perm-${kind}-status`);
      const btn = document.querySelector(
        `.perm-request-btn[data-perm="${kind}"]`
      ) as HTMLButtonElement | null;
      if (!dot || !statusEl) continue;
      let status = 'unsupported';
      try {
        status = (await core.invoke<string>('check_system_permission', { kind })) || 'unsupported';
      } catch (err) {
        console.warn(`[pure] check_system_permission(${kind}) failed:`, err);
      }
      dot.className = `perm-dot perm-dot-${status}`;
      statusEl.textContent = status === 'denied'
        ? `${t('perm.status.denied')} · ${t('perm.status.deniedHint')}`
        : t(`perm.status.${status}`);
      if (btn) {
        btn.hidden = status === 'authorized' || status === 'unsupported' || status === 'disabled';
      }
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

  // ── Load config into form ──

  private loadToForm() {
    // Re-apply translations for dynamic content
    applyTranslations();
    const cfg = loadConfig() || defaults();
    // LLM page is fully re-rendered on open: collapsed provider grid + the
    // default-model bar. Nothing is "selected" — the default model drives
    // which provider serves requests (see setDefaultModelFromMenu).
    this.editingProvider = null;
    this.renderProviderGrid();
    this.renderDefaultBar();
    (document.getElementById('cfg-language') as HTMLSelectElement).value = cfg.language;
    const cityEl = document.getElementById('cfg-city') as HTMLInputElement | null;
    if (cityEl) cityEl.value = cfg.city ?? '';

    const streamingRenderEl = document.getElementById('cfg-streaming-render') as HTMLInputElement | null;
    if (streamingRenderEl) streamingRenderEl.checked = cfg.streamingRender;
    const autoContinueEl = document.getElementById('cfg-auto-continue') as HTMLInputElement | null;
    if (autoContinueEl) autoContinueEl.checked = cfg.autoContinue;
    const autoContinueRoundsEl = document.getElementById('cfg-auto-continue-rounds') as HTMLInputElement | null;
    if (autoContinueRoundsEl) autoContinueRoundsEl.value = String(cfg.autoContinueMaxRounds ?? DEFAULT_AUTO_CONTINUE_MAX_ROUNDS);
    this.updateAutoContinueVisibility();
    const mapTileCacheMbEl = document.getElementById('cfg-map-tile-cache-mb') as HTMLInputElement | null;
    if (mapTileCacheMbEl) mapTileCacheMbEl.value = String(cfg.mapTileCacheMB ?? DEFAULT_MAP_TILE_CACHE_MB);
    const mapTianDiTuKeyEl = document.getElementById('cfg-map-tianditu-key') as HTMLInputElement | null;
    if (mapTianDiTuKeyEl) mapTianDiTuKeyEl.value = cfg.mapTileKey ?? '';

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
    const searxngUrlEl = document.getElementById('cfg-searxng-url') as HTMLInputElement | null;
    if (searxngUrlEl) searxngUrlEl.value = cfg.searxngUrl ?? '';
    const proxy = normalizeProxyConfig(cfg.proxy);
    const proxyEnabledEl = document.getElementById('cfg-proxy-enabled') as HTMLInputElement | null;
    if (proxyEnabledEl) proxyEnabledEl.checked = proxy.enabled;
    const proxyModeEl = document.getElementById('cfg-proxy-mode') as HTMLSelectElement | null;
    if (proxyModeEl) proxyModeEl.value = proxy.mode;
    this.updateProxyModeVisibility();
    const proxyLlmEl = document.getElementById('cfg-proxy-llm') as HTMLInputElement | null;
    if (proxyLlmEl) proxyLlmEl.checked = proxy.llmEnabled;
    const proxyToolsEl = document.getElementById('cfg-proxy-tools') as HTMLInputElement | null;
    if (proxyToolsEl) proxyToolsEl.checked = proxy.toolsEnabled;
    const proxyUrlEl = document.getElementById('cfg-proxy-url') as HTMLInputElement | null;
    const proxySchemeEl = document.getElementById('cfg-proxy-scheme') as HTMLSelectElement | null;
    const proxyHostEl = document.getElementById('cfg-proxy-host') as HTMLInputElement | null;
    const proxyPortEl = document.getElementById('cfg-proxy-port') as HTMLInputElement | null;
    const parsed = parseProxyUrl(proxy.url);
    if (proxyUrlEl) proxyUrlEl.value = proxy.url;
    if (proxySchemeEl) proxySchemeEl.value = parsed.scheme;
    if (proxyHostEl) proxyHostEl.value = parsed.host;
    if (proxyPortEl) proxyPortEl.value = parsed.port;
    const proxyUsernameEl = document.getElementById('cfg-proxy-username') as HTMLInputElement | null;
    if (proxyUsernameEl) proxyUsernameEl.value = proxy.username;
    const proxyPasswordEl = document.getElementById('cfg-proxy-password') as HTMLInputElement | null;
    if (proxyPasswordEl) {
      proxyPasswordEl.value = proxy.password;
      if (proxy.hasPassword) {
        proxyPasswordEl.placeholder = t('proxy.password.savedPlaceholder');
        delete proxyPasswordEl.dataset.touched;
      } else {
        proxyPasswordEl.placeholder = t('proxy.password.placeholder');
      }
    }
    const proxyProvidersEl = document.getElementById('cfg-proxy-bypass-providers') as HTMLInputElement | null;
    if (proxyProvidersEl) proxyProvidersEl.value = proxy.bypassProviders.join(', ');
    proxy.probeUrls.forEach((probe, i) => {
      const enabledEl = document.getElementById(`cfg-proxy-probe-${i}-enabled`) as HTMLInputElement | null;
      const urlEl = document.getElementById(`cfg-proxy-probe-${i}-url`) as HTMLInputElement | null;
      if (enabledEl) enabledEl.checked = probe.enabled;
      if (urlEl) urlEl.value = probe.url;
    });

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

    // System permission statuses refresh on every panel open.
    void this.refreshSystemPermissions();
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
    'user_preference', 'error_pattern', 'successful_pattern', 'project_convention', 'procedure', 'tool_preference',
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
        // 机器级全局记忆（tool_preference 常驻注入作用域）不归属任何项目：
        // 显示"机器级"标签而非哨兵字符串。
        const isGlobalScope = project === GLOBAL_MEMORY_SCOPE;
        const projectShort = isGlobalScope
          ? t('memory.globalScope', '机器级')
          : (project.split('/').filter(Boolean).pop() || project);
        const knownType = SettingsPanel.MEMORY_TYPES.has(e.type) ? e.type : undefined;
        const typeClass = knownType ? ` memory-type-${knownType}` : '';
        const typeLabel = escapeHtml(knownType ? t(`memory.type.${knownType}`, knownType) : e.type);
        // 工具偏好额外显示平台徽章（darwin / win32 / linux），让用户一眼看出
        // 这条偏好是在哪个系统上验证的；无 platform（用户明说）则不显示。
        const platformBadge = e.type === 'tool_preference' && e.platform
          ? `<span class="memory-badge memory-badge-platform" title="${escapeHtml(t('memory.platformTitle').replace('{p}', e.platform))}">${escapeHtml(e.platform)}</span>`
          : '';
        return `<div class="memory-card">
          <div class="memory-card-header">
            <span class="memory-badge memory-badge-type${typeClass}">${typeLabel}</span>
            ${platformBadge}
            <span class="memory-badge memory-badge-life memory-life-${lifecycle}">${t(`memory.lifecycle.${lifecycle}`, lifecycle)}</span>
            ${superseded}
            <button type="button" class="memory-delete-btn" data-mem-del="${escapeHtml(e.id)}" title="${escapeHtml(t('memory.deleteTitle'))}" aria-label="${escapeHtml(t('memory.deleteTitle'))}">✕</button>
          </div>
          <div class="memory-content" title="${escapeHtml(e.content)}">${escapeHtml(this.truncateForMemory(e.content, 160))}</div>
          <div class="memory-meta">
            <span class="memory-score" title="${escapeHtml(t('memory.health'))}: ${pct}%">
              <span class="memory-score-track"><i class="memory-score-bar memory-bar-${lifecycle}" style="width:${pct}%"></i></span>
              <b>${pct}%</b>
            </span>
            <span class="memory-meta-item">${t('memory.hits').replace('{n}', String(e.hitCount ?? 0))}</span>
            <span class="memory-meta-item">${t('memory.lastUsed').replace('{t}', this.relativeTime(lastUsed, now))}</span>
            ${project ? `<span class="memory-meta-item memory-project" title="${escapeHtml(isGlobalScope ? t('memory.globalScopeTitle') : project)}">${escapeHtml(projectShort)}</span>` : ''}
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
  private gatherProviderModels(): Record<string, string[]> {
    const cfg = loadConfig() ?? defaults();
    const result = normalizeProviderModels(cfg.providerModels);
    // The open panel's rows are the live source for the editing provider;
    // carry every other provider's library through untouched.
    const editing = this.editingProvider || '';
    if (editing && !customProviderFor(cfg.customProviders ?? [], editing)) {
      const rows = this.readModelRowsFromDom();
      if (rows.models.length > 0) result[editing] = rows.models;
    }
    return result;
  }

  private gatherProviderModelNames(): Record<string, Record<string, string>> {
    const prev = (loadConfig() ?? defaults()).providerModelNames ?? {};
    const out: Record<string, Record<string, string>> = { ...prev };
    const editing = this.editingProvider || '';
    if (editing && !customProviderFor((loadConfig() ?? defaults()).customProviders ?? [], editing)) {
      out[editing] = this.readModelRowsFromDom().names;
    }
    return out;
  }

  /** Carry the custom-provider list through, applying the expanded panel's
   *  live edits (no panel open = unchanged list). */
  private gatherCustomProviders(): PureConfig['customProviders'] {
    const prev = (loadConfig() ?? defaults()).customProviders ?? [];
    const list = prev.map(p => ({ ...p }));
    const provider = this.editingProvider || '';
    const idx = list.findIndex(p => p.id === provider);
    if (idx < 0) return list;
    const entry = { ...list[idx] };
    const name = (document.getElementById('cfg-custom-name-edit') as HTMLInputElement | null)?.value.trim();
    const baseURL = (document.getElementById('cfg-baseurl') as HTMLInputElement | null)?.value.trim().replace(/\/+$/, '') ?? '';
    const model = (document.getElementById('cfg-model') as HTMLInputElement | null)?.value.trim() ?? '';
    if (name) entry.name = name;
    if (baseURL) entry.baseURL = baseURL;
    // 模型库由下方行列表管理（每行：模型 ID + 可选名称 + 默认圆点）；这里
    // 直接读取行输入框，击键即生效。默认模型 = 行列表圆点（否则回退旧默认
    // 或列表首项），名称同步进 modelNames。
    const rows = this.readModelRowsFromDom();
    if (rows.models.length > 0) {
      entry.models = rows.models;
      entry.modelNames = rows.names;
      entry.defaultModel = rows.defaultModel
        || (entry.models.includes(entry.defaultModel) ? entry.defaultModel : entry.models[0] ?? '');
    }
    if (model) entry.defaultModel = model;
    else if (!entry.models.includes(entry.defaultModel)) entry.defaultModel = entry.models[0] ?? '';
    // 文生图开关 + 图片模型名（仅自定义供应商表单里存在这些字段）。
    const imageGenToggle = document.getElementById('cfg-imagegen') as HTMLInputElement | null;
    const imageGenModel = (document.getElementById('cfg-imagegen-model') as HTMLInputElement | null)?.value.trim();
    entry.imageGen = imageGenToggle?.checked === true;
    if (imageGenModel) entry.imageGenModel = imageGenModel;
    else delete entry.imageGenModel;
    // Raw key from the field; autoSave() scrubs/redirects it per platform.
    entry.apiKey = (document.getElementById('cfg-apikey') as HTMLInputElement | null)?.value.trim() ?? '';
    list[idx] = entry;
    return list;
  }

  /**
   * Collect name / Base URL overrides for the BUILT-IN provider currently
   * being edited (custom providers own those fields on their entry, so they
   * never appear in this map). An empty input clears the override and the
   * registry default takes over again. API keys are handled separately in
   * autoSave() (Rust secrets on desktop) and are carried through untouched.
   */
  private gatherProviderOverrides(): PureConfig['providerOverrides'] {
    const prev = (loadConfig() ?? defaults()).providerOverrides ?? {};
    const out: PureConfig['providerOverrides'] = { ...prev };
    const editing = this.editingProvider || '';
    if (!editing || customProviderFor((loadConfig() ?? defaults()).customProviders ?? [], editing)) {
      return out;
    }
    const name = (document.getElementById('cfg-custom-name-edit') as HTMLInputElement | null)?.value.trim() || '';
    const baseURL = (document.getElementById('cfg-baseurl') as HTMLInputElement | null)?.value.trim().replace(/\/+$/, '') ?? '';
    const next = { ...(prev[editing] ?? {}) };
    if (name) next.name = name; else delete next.name;
    if (baseURL) next.baseURL = baseURL; else delete next.baseURL;
    out[editing] = next;
    return out;
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
      id = nextCustomProviderId(customs);
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
    // The provider only enters service once the user picks one of its models
    // from the default-model bar — the blank card just opens for editing.
    const cfg: PureConfig = { ...prev, customProviders: customs };
    persistConfig(cfg);
    invalidateConfigCache();
    this.editingProvider = id;
    this.renderProviderGrid();
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
      const provider = this.editingProvider || '';
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
        persistConfig(cfg);
        invalidateConfigCache();
        this.renderProviderGrid();
      }
      this.renderModelList(provider);
      this.autoSave();
      this.toast(t('llm.custom.fetchOk').replace('{n}', String(fetchedModels.length)));
    } catch (err) {
      console.warn('[pure] fetch models failed:', err);
      this.toast(t('llm.custom.fetchFail') + '：' + ((err as Error)?.message || ''));
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // ── Multi-model editor: editable rows (id + optional name), min 2 rows ──

  /** Read the current model rows straight from the DOM: the inputs are the
   *  source of truth while the panel is open, so typing a new id (or renaming
   *  an existing one) is picked up by the debounced autosave without a
   *  re-render racing the caret. Rows with an empty id are add-slots. */
  private readModelRowsFromDom(): { models: string[]; names: Record<string, string>; defaultModel: string } {
    const list = document.getElementById('cfg-model-list');
    const rows = list ? [...list.querySelectorAll<HTMLElement>('.llm-model-row')] : [];
    const models: string[] = [];
    const names: Record<string, string> = {};
    let defaultModel = '';
    for (const row of rows) {
      const idInput = row.querySelector<HTMLInputElement>('.llm-model-row-id');
      const nameInput = row.querySelector<HTMLInputElement>('.llm-model-row-name');
      const radio = row.querySelector<HTMLInputElement>('.llm-model-row-radio');
      const id = (idInput?.value ?? '').trim();
      if (!id) continue;
      if (!models.includes(id)) models.push(id);
      const name = (nameInput?.value ?? '').trim();
      if (name) names[id] = name;
      if (radio?.checked) defaultModel = id;
    }
    return { models, names, defaultModel };
  }

  private renderModelList(provider: string): void {
    const list = document.getElementById('cfg-model-list');
    if (!list) return;
    const cfg = loadConfig() ?? defaults();
    const custom = customProviderFor(cfg.customProviders ?? [], provider);
    const models = modelListForProvider(cfg, provider);
    const names = custom?.modelNames ?? cfg.providerModelNames?.[provider] ?? {};
    const defaultModel = custom?.defaultModel
      || (provider === cfg.provider ? cfg.model.trim() : cfg.providerModels?.[provider]?.[0])
      || models[0]
      || '';

    // Always show at least 2 rows: real models first, then empty add-slots.
    const rows = models.length >= 2 ? models : [...models, '', ''].slice(0, 2);
    const hidden = document.getElementById('cfg-model') as HTMLInputElement | null;
    if (hidden) hidden.value = defaultModel;
    list.hidden = false;
    list.innerHTML = rows.map((model, i) => this.modelRowHtml(model, i, defaultModel, models.length, names)).join('');
    applyTranslations();
  }

  /** One editable model row: radio (set default) + id input + optional name
   *  input + a remove × button. An empty id is an add-slot (no × button). */
  private modelRowHtml(model: string, i: number, defaultModel: string, modelCount: number, names: Record<string, string>): string {
    const isDefault = !!model && model === defaultModel;
    const canRemove = !!model && modelCount > 1;
    return `<div class="llm-model-row${isDefault ? ' llm-model-row-default' : ''}" data-row="${i}">
      <input type="radio" name="cfg-model-default" class="llm-model-row-radio" data-radio-row="${i}" ${isDefault ? 'checked' : ''} title="${t('llm.model.setDefault')}" aria-label="${t('llm.model.setDefault')}" />
      <input class="setting-input llm-model-row-id" data-row-id="${i}" type="text" value="${escapeHtml(model)}" placeholder="${t('llm.model.idPlaceholder')}" autocomplete="off" />
      <input class="setting-input llm-model-row-name" data-row-name="${i}" type="text" value="${escapeHtml(model ? (names[model] ?? '') : '')}" placeholder="${t('llm.model.namePlaceholder')}" autocomplete="off" />
      ${canRemove ? `<button type="button" class="llm-model-row-remove" data-remove-row="${i}" title="${t('llm.custom.removeModel')}" aria-label="${t('llm.custom.removeModel')}">×</button>` : ''}
    </div>`;
  }

  /** Commit the current row edits: id/name inputs → models + names, radio →
   *  default. Re-renders so rows re-sync with what was just saved. The toast
   *  only fires when the default model actually moved (Enter-to-add or a
   *  rename should not claim a default change). */
  private commitModelRows(): void {
    const provider = this.editingProvider || '';
    if (!provider) return;
    const { models, names, defaultModel } = this.readModelRowsFromDom();
    const prev = loadConfig() ?? defaults();
    const custom = customProviderFor(prev.customProviders ?? [], provider);
    const oldDefault = custom?.defaultModel
      || (provider === prev.provider ? prev.model.trim() : '')
      || '';
    const fallbackDefault = oldDefault || models[0] || '';
    const nextDefault = defaultModel || (models.includes(fallbackDefault) ? fallbackDefault : (models[0] ?? ''));
    let cfg: PureConfig;
    if (custom) {
      const entry = { ...custom, models, modelNames: names, defaultModel: nextDefault };
      cfg = { ...prev, customProviders: (prev.customProviders ?? []).map(p => p.id === provider ? entry : p) };
    } else {
      cfg = { ...prev, providerModels: { ...normalizeProviderModels(prev.providerModels), [provider]: models }, providerModelNames: { ...(prev.providerModelNames ?? {}), [provider]: names } };
      if (provider === prev.provider) cfg.model = nextDefault;
    }
    persistConfig(cfg);
    invalidateConfigCache();
    const hidden = document.getElementById('cfg-model') as HTMLInputElement | null;
    if (hidden) hidden.value = nextDefault;
    const defaultMoved = oldDefault !== nextDefault && !!nextDefault;
    this.renderModelList(provider);
    this.renderDefaultBar();
    if (defaultMoved) this.toast(t('llm.custom.defaultChanged').replace('{m}', nextDefault));
  }

  /** 全部删除: keep only the default model, drop the rest (rows re-render). */
  private clearModels(): void {
    const provider = this.editingProvider || '';
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
    persistConfig(cfg);
    invalidateConfigCache();
    const modelEl = document.getElementById('cfg-model') as HTMLInputElement | null;
    if (modelEl) modelEl.value = keep;
    this.renderModelList(provider);
    this.autoSave();
    this.toast(t('llm.custom.clearModelsDone'));
  }

  /** ＋ 添加模型: commit any pending row edits, then append a fresh add-slot
   *  row and focus its id input so a new model can be typed immediately. */
  private addModelRow(): void {
    const provider = this.editingProvider || '';
    if (!provider) return;
    this.commitModelRows();
    const list = document.getElementById('cfg-model-list');
    if (!list) return;
    const index = list.querySelectorAll('.llm-model-row').length;
    const row = document.createElement('div');
    row.className = 'llm-model-row';
    row.dataset.row = String(index);
    row.innerHTML = this.modelRowHtml('', index, '', 0, {});
    list.appendChild(row);
    applyTranslations();
    row.querySelector<HTMLInputElement>('.llm-model-row-id')?.focus();
  }

  /** Remove the model in DOM row `index`; rows re-render after the commit. */
  private removeModelRow(index: number): void {
    const provider = this.editingProvider || '';
    const rows = this.readModelRowsFromDom();
    const model = rows.models[index];
    if (!model) return;
    const prev = loadConfig() ?? defaults();
    const custom = customProviderFor(prev.customProviders ?? [], provider);
    if (rows.models.length <= 1) return;
    const remaining = rows.models.filter((_, i) => i !== index);
    const names = { ...rows.names };
    delete names[model];
    const currentDefault = custom?.defaultModel || (provider === prev.provider ? prev.model.trim() : '') || rows.models[0];
    const defaultModel = currentDefault === model ? remaining[0] : currentDefault;
    let cfg: PureConfig;
    if (custom) {
      const nextEntry = { ...custom, models: remaining, modelNames: names, defaultModel };
      cfg = { ...prev, customProviders: (prev.customProviders ?? []).map(p => p.id === provider ? nextEntry : p) };
    } else {
      cfg = { ...prev, providerModels: { ...normalizeProviderModels(prev.providerModels), [provider]: remaining }, providerModelNames: { ...(prev.providerModelNames ?? {}), [provider]: names } };
      if (provider === prev.provider) cfg.model = defaultModel;
    }
    persistConfig(cfg);
    invalidateConfigCache();
    const modelEl = document.getElementById('cfg-model') as HTMLInputElement | null;
    if (modelEl) modelEl.value = defaultModel;
    this.renderModelList(provider);
    this.autoSave();
    this.toast(t('llm.custom.removedModel').replace('{m}', model));
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
   * Add a quick-preset entry (idempotent) and open its expanded panel. The
   * provider only enters service when the user picks one of its models from
   * the default-model bar.
   */
  private addCustomPreset(preset: CustomProvider): void {
    const prev = loadConfig() ?? defaults();
    const customs = [...(prev.customProviders ?? [])];
    if (!customs.some(p => p.id === preset.id)) {
      customs.push({ ...preset });
    }
    const cfg: PureConfig = { ...prev, customProviders: customs };
    persistConfig(cfg);
    invalidateConfigCache();
    this.editingProvider = preset.id;
    this.renderProviderGrid();
    this.toast(t('llm.custom.addedConfig').replace('{name}', preset.name));
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
    persistConfig(cfg);
    invalidateConfigCache();
    // Deleting the provider whose panel is open also collapses the panel;
    // the default model falls back to the first registry default.
    if (this.editingProvider === id) this.editingProvider = null;
    this.renderProviderGrid();
    this.renderDefaultBar();
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

    // The default model (chosen from the top bar) drives which provider
    // serves requests; the expanded panel edits that provider's entry
    // (models / overrides / custom fields) without changing the active
    // provider unless the user picks a new default model.
    const prev = loadConfig() ?? defaults();
    const editing = this.editingProvider;
    const editingActive = editing !== null && editing === prev.provider;
    const apiKey = editing
      ? ((document.getElementById('cfg-apikey') as HTMLInputElement | null)?.value.trim() ?? '')
      : '';
    const model = editing
      ? ((document.getElementById('cfg-model') as HTMLInputElement | null)?.value.trim() ?? '')
      : '';

    return {
      provider: prev.provider,
      customProviders: this.gatherCustomProviders(),
      providerModels: this.gatherProviderModels(),
      providerModelNames: this.gatherProviderModelNames(),
      providerOverrides: this.gatherProviderOverrides(),
      apiKey: editingActive ? apiKey : prev.apiKey,
      model: editingActive ? model : prev.model,
      // The legacy global baseURL is frozen after the v10 migration (a stale
      // value once hijacked every provider's endpoint); per-provider edits now
      // land in providerOverrides via gatherProviderOverrides().
      baseURL: prev.baseURL,
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
      searxngUrl: (document.getElementById('cfg-searxng-url') as HTMLInputElement | null)?.value.trim() ?? '',
      mcpExcludedPrefixes: (document.getElementById('cfg-mcp-exclude-prefixes') as HTMLInputElement | null)?.value.split(',').map((p) => p.trim()).filter(Boolean) ?? [],
      proxy: normalizeProxyConfig({
        enabled: (document.getElementById('cfg-proxy-enabled') as HTMLInputElement | null)?.checked ?? false,
        mode: ((document.getElementById('cfg-proxy-mode') as HTMLSelectElement | null)?.value ?? 'manual') as 'manual' | 'system',
        llmEnabled: (document.getElementById('cfg-proxy-llm') as HTMLInputElement | null)?.checked ?? false,
        toolsEnabled: (document.getElementById('cfg-proxy-tools') as HTMLInputElement | null)?.checked ?? false,
        url: composeProxyUrl(
          (document.getElementById('cfg-proxy-scheme') as HTMLSelectElement | null)?.value ?? '',
          (document.getElementById('cfg-proxy-host') as HTMLInputElement | null)?.value ?? '',
          (document.getElementById('cfg-proxy-port') as HTMLInputElement | null)?.value ?? '',
        ),
        username: (document.getElementById('cfg-proxy-username') as HTMLInputElement | null)?.value ?? '',
        password: (document.getElementById('cfg-proxy-password') as HTMLInputElement | null)?.value ?? '',
        bypassProviders: normalizeProxyList((document.getElementById('cfg-proxy-bypass-providers') as HTMLInputElement | null)?.value),
        probeUrls: [0, 1, 2].map((i) => ({
          url: (document.getElementById(`cfg-proxy-probe-${i}-url`) as HTMLInputElement | null)?.value ?? '',
          enabled: (document.getElementById(`cfg-proxy-probe-${i}-enabled`) as HTMLInputElement | null)?.checked ?? false,
        })),
      }),
      skills,
      hubSkills,
      mcpServers: [...this.mcpServers],
      streamingRender: (document.getElementById('cfg-streaming-render') as HTMLInputElement | null)?.checked ?? true,
      autoContinue: (document.getElementById('cfg-auto-continue') as HTMLInputElement | null)?.checked ?? false,
      // Max auto rounds per user message (Settings → General, next to the
      // auto-continue toggle). Clamp to 1..20 so a typed value can't zero out
      // the chain or spin it forever.
      autoContinueMaxRounds: Math.min(20, Math.max(1, parseInt((document.getElementById('cfg-auto-continue-rounds') as HTMLInputElement | null)?.value ?? '', 10) || DEFAULT_AUTO_CONTINUE_MAX_ROUNDS)),
      mapTileCacheMB: Math.min(2000, Math.max(10, parseInt((document.getElementById('cfg-map-tile-cache-mb') as HTMLInputElement | null)?.value ?? '', 10) || DEFAULT_MAP_TILE_CACHE_MB)),
      mapTileKey: (document.getElementById('cfg-map-tianditu-key') as HTMLInputElement | null)?.value.trim().slice(0, 128) ?? '',
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

    // API keys belong to the provider whose panel is open (per-provider slots
    // for built-ins, the entry for customs). The legacy global key is frozen:
    // existing setups keep working, but new keys never land there.
    const editing = this.editingProvider;
    const keyInput = document.getElementById('cfg-apikey') as HTMLInputElement | null;
    const selectedCustom = editing ? customProviderFor(cfg.customProviders ?? [], editing) : undefined;
    if (selectedCustom) {
      // Custom provider: its key lives in its OWN Rust secret slot
      // (llm.apiKey.<id>, desktop) or the config entry (browser). Keyless
      // locals (Ollama) simply stay empty on both platforms.
      if (isTauriRuntime()) {
        if (selectedCustom.apiKey) {
          void storeCustomSecretInRust(selectedCustom.id, selectedCustom.apiKey);
          selectedCustom.hasApiKey = true;
        } else if (selectedCustom.hasApiKey && keyInput?.dataset.touched === '1') {
          // User edited the field and cleared it → revoke the stored key.
          void revokeCustomSecretFromRust(selectedCustom.id);
          selectedCustom.hasApiKey = false;
          delete keyInput.dataset.touched;
        }
        selectedCustom.apiKey = ''; // never persist the raw key
      } else {
        selectedCustom.hasApiKey = !!selectedCustom.apiKey;
      }
    } else if (editing) {
      if (!cfg.model) {
        cfg.model = defaultModelFor(cfg.provider);
      }
      // Built-in provider being edited: its key lives in the override slot
      // 'llm.apiKey.<id>' (desktop Rust secrets / browser entry).
      const override = cfg.providerOverrides[editing] ?? {};
      const hasOverrideKey = !!override.apiKey || override.hasApiKey === true;
      const typedKey = keyInput?.value.trim() ?? '';
      if (isTauriRuntime()) {
        if (typedKey) {
          void storeCustomSecretInRust(editing, typedKey);
          cfg.providerOverrides[editing] = { ...override, hasApiKey: true };
        } else if (hasOverrideKey && keyInput?.dataset.touched === '1') {
          // User edited the field and cleared it → revoke the stored key.
          void revokeCustomSecretFromRust(editing);
          cfg.providerOverrides[editing] = { ...override, hasApiKey: false };
          delete keyInput.dataset.touched;
        }
      } else if (typedKey) {
        // Browser: the key lives in the override entry (plain storage).
        cfg.providerOverrides[editing] = { ...override, apiKey: typedKey };
      } else if (hasOverrideKey && keyInput?.dataset.touched === '1') {
        // User edited the field and cleared it → drop the stored key.
        cfg.providerOverrides[editing] = { ...override, apiKey: '', hasApiKey: false };
        delete keyInput.dataset.touched;
      }
    }

    // Proxy password: desktop keeps it in Rust secrets (slot proxy.password)
    // and only a hasPassword flag in localStorage; browser falls back to the
    // plaintext entry. The raw value must never be persisted on desktop.
    const proxyPasswordInput = document.getElementById('cfg-proxy-password') as HTMLInputElement | null;
    const typedProxyPassword = proxyPasswordInput?.value ?? '';
    if (isTauriRuntime()) {
      if (typedProxyPassword) {
        void storeProxyPasswordInRust(typedProxyPassword);
        cfg.proxy = { ...cfg.proxy, hasPassword: true, password: '' };
        // Clear the field so the plaintext never lingers in the DOM.
        if (proxyPasswordInput) {
          proxyPasswordInput.value = '';
          delete proxyPasswordInput.dataset.touched;
        }
      } else if (prev.proxy?.hasPassword && proxyPasswordInput?.dataset.touched === '1') {
        // User edited the field and cleared it → revoke the stored password.
        void revokeProxyPasswordFromRust();
        cfg.proxy = { ...cfg.proxy, hasPassword: false, password: '' };
        delete proxyPasswordInput.dataset.touched;
      } else {
        cfg.proxy = { ...cfg.proxy, hasPassword: prev.proxy?.hasPassword === true, password: '' };
      }
    } else {
      cfg.proxy = { ...cfg.proxy, hasPassword: false, password: typedProxyPassword };
    }
    if (proxyPasswordInput) {
      proxyPasswordInput.placeholder = cfg.proxy.hasPassword
        ? t('proxy.password.savedPlaceholder')
        : t('proxy.password.placeholder');
    }

    persistConfig(cfg);
    // Drop the cached config so the next loadConfig() re-reads the saved state.
    invalidateConfigCache();

    updateLanguage(cfg.language as I18nLanguage);
    this.applyTheme(cfg.theme);

    document.documentElement.style.setProperty('--font-size',
      cfg.fontSize === 'small' ? '13px' : cfg.fontSize === 'large' ? '15px' : '14px');
    document.documentElement.style.setProperty('--spacing',
      cfg.density === 'compact' ? '8px' : cfg.density === 'spacious' ? '16px' : '12px');

    // Refresh the grid + default-model bar after a save — card labels, status
    // pills and the bar must reflect the state the user just changed. BUT skip
    // the grid re-render while the caret is inside a model row: the panel is
    // rebuilt from config and would kill the focus mid-typing (the row inputs
    // are the source of truth until commit/blur).
    const caretInRows = document.activeElement instanceof HTMLElement
      && !!document.activeElement.closest('#cfg-model-list');
    if (this.editingProvider && !caretInRows) {
      // The rebuilt panel renders #cfg-apikey value-less by design (the raw
      // secret never persists in markup), so a debounced save firing mid-edit
      // would visually swallow what was just pasted/typed. Capture the
      // in-progress state and restore it into the fresh input — type=password
      // keeps it masked as ●●●●.
      const keyBefore = document.getElementById('cfg-apikey') as HTMLInputElement | null;
      const keyValue = keyBefore?.value ?? '';
      const keyTouched = keyBefore?.dataset.touched === '1';
      const keyHadFocus = !!keyBefore && document.activeElement === keyBefore;
      this.renderProviderGrid();
      if ((keyValue || keyTouched || keyHadFocus)) {
        const keyAfter = document.getElementById('cfg-apikey') as HTMLInputElement | null;
        if (keyAfter) {
          if (keyValue && !keyAfter.value) keyAfter.value = keyValue;
          if (keyTouched) keyAfter.dataset.touched = '1';
          if (keyHadFocus) keyAfter.focus();
        }
      }
    }
    this.renderDefaultBar();

    this.onSave();
  }

  // ── Toast ──

  /** Copy a provider id to the clipboard (proxy bypass rules / debugging). */
  private async copyProviderId(id: string): Promise<void> {
    if (!id) return;
    const ok = await copyTextToClipboard(id);
    this.toast(ok ? t('llm.id.copied').replace('{id}', id) : t('llm.card.id.copy'));
  }

  private toast(msg: string) {
    const el = document.getElementById('toast')!;
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => el.classList.add('hidden'), 2000);
  }
}
