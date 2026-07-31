// src/ui/main.ts
// pure v0.8 — Notion-style sidebar + modal settings

import { ChatController } from './chat';
import { SettingsPanel, loadConfig, hasConfiguredKey } from './settings';
import { loadSessionList, loadSession, deleteSession, type SessionMeta, type StoredMessage } from './store';
import { checkForUpdatesSilently } from './updater';
import { escapeHtml } from '../shared/html';
import { t, applyTranslations, updateLanguage } from '../shared/i18n';
import type { Language as I18nLanguage } from '../shared/i18n';
import { renderMarkdown } from './markdown';

const chat = new ChatController();
let hasStartedChat = false;

const settings = new SettingsPanel(
  onConfigSaved,
  () => {}, // onOpen
  () => { enableInputIfReady(); }, // onClose
);

// ── Streaming state → update both send buttons ──

chat.onStreamingStateChange((streaming) => {
  const sendBtn = document.getElementById('send-btn') as HTMLButtonElement;
  const promptEl = document.getElementById('prompt') as HTMLTextAreaElement;
  const landingSend = document.getElementById('landing-send-btn') as HTMLButtonElement;
  const landingPrompt = document.getElementById('landing-prompt') as HTMLTextAreaElement;

  if (streaming) {
    const stopSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>`;
    sendBtn.innerHTML = stopSvg;
    sendBtn.title = 'Stop generating (Esc)';
    sendBtn.classList.add('stopping');
    promptEl.placeholder = 'pure is generating… (Esc or click ■ to stop)';
    promptEl.disabled = true;
    landingSend.innerHTML = stopSvg;
    landingSend.title = 'Stop';
  } else {
    const sendSvg = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>`;
    sendBtn.innerHTML = sendSvg;
    sendBtn.title = 'Send';
    sendBtn.classList.remove('stopping');
    sendBtn.disabled = !promptEl.value.trim();
    promptEl.placeholder = t('input.placeholder');
    promptEl.disabled = !hasConfiguredKey(loadConfig());
    landingSend.innerHTML = sendSvg;
    landingSend.title = 'Send';
    landingSend.disabled = !landingPrompt.value.trim();
  }
});

function onConfigSaved() {
  chat.setWorkspace(settings.getWorkspace());
  updateSidebarModel();
  enableInputIfReady();
}

// ── DOM refs ──
const chatView = document.getElementById('chat-view')!;
const promptEl = document.getElementById('prompt') as HTMLTextAreaElement;
const sendBtn = document.getElementById('send-btn') as HTMLButtonElement;
const landingPrompt = document.getElementById('landing-prompt') as HTMLTextAreaElement;
const landingSend = document.getElementById('landing-send-btn') as HTMLButtonElement;
const sidebarNewChat = document.getElementById('sidebar-new-chat') as HTMLButtonElement;
const sidebarSettingsBtn = document.getElementById('sidebar-settings-btn') as HTMLButtonElement;

// ── Init ──
(async () => {
  applySavedAppearance();
  chat.setWorkspace(settings.getWorkspace());
  updateSidebarModel();
  enableInputIfReady();

  await restoreLastSession();
  checkLandingState();

  refreshSidebarSessions();
  setTimeout(() => checkForUpdatesSilently(), 3000);
})().catch(err => console.error('[pure] init failed:', err));

/** Ensure the landing class is set correctly based on chat state */
function checkLandingState() {
  if (!hasStartedChat) {
    chatView.classList.add('landing');
  } else {
    chatView.classList.remove('landing');
  }
}

/** Transition from landing to chat view */
function enterChatMode() {
  if (hasStartedChat) return;
  hasStartedChat = true;
  chatView.classList.remove('landing');
  promptEl.focus();
}

/** Update sidebar model badge from config */
function updateSidebarModel() {
  const cfg = loadConfig();
  const el = document.getElementById('sidebar-model');
  if (!el) return;
  el.textContent = cfg?.model || cfg?.provider || '';
}

/** Reset to landing state for a new conversation */
function goToLanding() {
  hasStartedChat = false;
  chatView.classList.add('landing');
  landingPrompt.value = '';
  landingPrompt.style.height = 'auto';
  landingSend.disabled = true;
}

/** Apply saved theme, language, font size, and density on initial load */
function applySavedAppearance() {
  const cfg = loadConfig();
  if (!cfg) return;

  if (cfg.theme === 'system') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
  } else {
    document.documentElement.setAttribute('data-theme', cfg.theme);
  }

  updateLanguage(cfg.language as I18nLanguage);

  document.documentElement.style.setProperty('--font-size',
    cfg.fontSize === 'small' ? '13px' : cfg.fontSize === 'large' ? '15px' : '14px');
  document.documentElement.style.setProperty('--spacing',
    cfg.density === 'compact' ? '8px' : cfg.density === 'spacious' ? '16px' : '12px');
}

async function restoreLastSession() {
  const saved = await chat.restoreLastSession();
  if (!saved) return;
  renderSessionMessages(saved);
  currentActiveId = chat.getSessionId();
  setActiveSession(currentActiveId);
}

function renderSessionMessages(messages: StoredMessage[]) {
  enterChatMode();
  chat.loadFromStorage(messages);

  const chatEl = document.getElementById('chat')!;
  chatEl.innerHTML = '';
  const toolExecs: Array<{ toolName: string; success: boolean; duration: number }> = [];

  for (const m of messages) {
    if (m.role === 'tool' && m.toolExec) {
      toolExecs.push(m.toolExec);
      continue;
    }
    if (m.role === 'assistant' && m.content) {
      flushToolExecs(toolExecs, chatEl);
      toolExecs.length = 0;
      const wrapper = document.createElement('div');
      wrapper.className = 'bubble-row assistant';
      const label = document.createElement('span');
      label.className = 'bubble-label';
      label.textContent = 'pure';
      wrapper.appendChild(label);
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      wrapper.appendChild(bubble);
      chatEl.appendChild(wrapper);
      void renderMarkdown(m.content, bubble);
    } else if (m.role === 'user' && m.content) {
      flushToolExecs(toolExecs, chatEl);
      toolExecs.length = 0;
      const wrapper = document.createElement('div');
      wrapper.className = 'bubble-row user';
      const label = document.createElement('span');
      label.className = 'bubble-label';
      label.textContent = 'You';
      wrapper.appendChild(label);
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      bubble.textContent = m.content;
      wrapper.appendChild(bubble);
      chatEl.appendChild(wrapper);
    }
  }
  flushToolExecs(toolExecs, chatEl);
  chatEl.scrollTop = chatEl.scrollHeight;
}

function flushToolExecs(execs: Array<{ toolName: string; success: boolean; duration: number }>, parent: HTMLElement) {
  for (const te of execs) {
    const sw = document.createElement('div');
    sw.className = 'bubble-row status';
    const sb = document.createElement('div');
    sb.className = 'bubble status';
    const icon = te.success ? '✓' : '✗';
    sb.textContent = `🔧 ${te.toolName}: ${icon} (${te.duration}ms)`;
    sw.appendChild(sb);
    parent.appendChild(sw);
  }
}

// ── Input handling ──

function enableInputIfReady() {
  const config = loadConfig();
  const ready = hasConfiguredKey(config);
  promptEl.disabled = !ready;
  sendBtn.disabled = !ready;
  landingSend.disabled = !ready;
  if (!ready) {
    promptEl.placeholder = t('input.placeholderDisabled');
    landingPrompt.placeholder = t('input.placeholderDisabled');
  } else {
    promptEl.placeholder = t('input.placeholder');
    landingPrompt.placeholder = t('landing.placeholder');
  }
}

// ── Landing input auto-resize ──

landingPrompt.addEventListener('input', () => {
  landingPrompt.style.height = 'auto';
  landingPrompt.style.height = Math.min(landingPrompt.scrollHeight, 200) + 'px';
  if (!chat.isStreaming()) {
    landingSend.disabled = !landingPrompt.value.trim();
  }
});

landingPrompt.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleLandingSendOrStop();
  }
  if (e.key === 'Escape' && chat.isStreaming()) {
    chat.cancel();
  }
});

// ── Chat (bottom) input auto-resize ──

promptEl.addEventListener('input', () => {
  promptEl.style.height = 'auto';
  promptEl.style.height = Math.min(promptEl.scrollHeight, 120) + 'px';
  if (!chat.isStreaming()) {
    sendBtn.disabled = !promptEl.value.trim();
  }
});

promptEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleSendOrStop();
  }
  if (e.key === 'Escape' && chat.isStreaming()) {
    chat.cancel();
  }
});

sendBtn.addEventListener('click', handleSendOrStop);
landingSend.addEventListener('click', handleLandingSendOrStop);

function handleSendOrStop() {
  if (chat.isStreaming()) {
    chat.cancel();
    return;
  }
  sendMessage(promptEl);
}

function handleLandingSendOrStop() {
  if (chat.isStreaming()) {
    chat.cancel();
    return;
  }
  sendMessage(landingPrompt);
}

async function sendMessage(sourceEl: HTMLTextAreaElement) {
  const text = sourceEl.value.trim();
  if (!text || chat.isStreaming()) return;

  if (!hasConfiguredKey(loadConfig())) {
    showToast(t('toast.setApiKey'));
    settings.open();
    return;
  }

  sourceEl.value = '';
  sourceEl.style.height = 'auto';
  if (sourceEl === landingPrompt) {
    landingSend.disabled = true;
  }
  sendBtn.disabled = true;

  try {
    enterChatMode();
    await chat.send(text);
  } catch (err: any) {
    showToast(`Error: ${err?.message || err}`);
    console.error('[pure] sendMessage failed:', err);
  } finally {
    sendBtn.disabled = !promptEl.value.trim();
    promptEl.focus();
    refreshSidebarSessions();
  }
}

// ── Sidebar: new chat ──

const sidebarToggle = document.getElementById('sidebar-toggle') as HTMLButtonElement;
const sidebar = document.getElementById('sidebar')!;

sidebarToggle.addEventListener('click', () => {
  sidebar.classList.toggle('collapsed');
});

// ── Sidebar: new chat ──

sidebarNewChat.addEventListener('click', () => {
  chat.clear();
  goToLanding();
  landingPrompt.focus();
  setActiveSession(null);
});

// ── Sidebar: settings ──

sidebarSettingsBtn.addEventListener('click', () => {
  settings.open();
});

// ── Right-side floating settings button ──

const rightSettingsBtn = document.getElementById('right-settings-btn') as HTMLButtonElement;
if (rightSettingsBtn) {
  rightSettingsBtn.addEventListener('click', () => {
    settings.open();
  });
}

// ── Sidebar sessions ──

let currentActiveId: string | null = null;

function setActiveSession(id: string | null) {
  currentActiveId = id;
  document.querySelectorAll('.sidebar-session-item').forEach(el => {
    el.classList.toggle('active', el.getAttribute('data-sid') === id);
  });
}

async function refreshSidebarSessions() {
  const container = document.getElementById('sidebar-session-list')!;
  try {
    const list = await loadSessionList();
    if (!list || list.length === 0) {
      container.innerHTML = `<div class="sidebar-session-empty">${t('sidebar.noSessions')}</div>`;
      return;
    }

    const sorted = [...list].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 20);

    container.innerHTML = sorted.map(s => {
      const title = escapeHtml(s.title.slice(0, 50));
      return `<div class="sidebar-session-item" data-sid="${s.id}">
        <span class="sidebar-session-item-title" title="${title}">${title}</span>          <button class="sidebar-session-delete" data-sid="${s.id}" title="${t('sidebar.delete.title')}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>`;
    }).join('');

    // Restore active state
    setActiveSession(currentActiveId);

    // Click session → load it
    container.querySelectorAll('.sidebar-session-item').forEach(el => {
      el.addEventListener('click', (e) => {
        const sid = el.getAttribute('data-sid');
        if (sid && !(e.target as HTMLElement).closest('.sidebar-session-delete')) {
          loadAndDisplaySession(sid);
        }
      });
    });

    // Delete session
    container.querySelectorAll('.sidebar-session-delete').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const sid = btn.getAttribute('data-sid');
        if (!sid) return;
        if (!confirm(t('confirm.deleteSession'))) return;
        await deleteSession(sid);
        if (currentActiveId === sid) {
          chat.clear();
          goToLanding();
          setActiveSession(null);
        }
        refreshSidebarSessions();
      });
    });
  } catch {
    container.innerHTML = `<div class="sidebar-session-empty">${t('session.loadError')}</div>`;
  }
}

async function loadAndDisplaySession(id: string) {
  const messages = await loadSession(id);
  if (!messages || messages.length === 0) return;
  chat.setSessionId(id);
  renderSessionMessages(messages);
  setActiveSession(id);
}

function showToast(msg: string) {
  const el = document.getElementById('toast')!;
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout((showToast as any)._timer);
  (showToast as any)._timer = setTimeout(() => el.classList.add('hidden'), 2500);
}

// ── Theme: respond to system preference change ──

const darkModeMedia = window.matchMedia('(prefers-color-scheme: dark)');
darkModeMedia.addEventListener('change', () => {
  const cfg = loadConfig();
  if (cfg?.theme === 'system') {
    document.documentElement.setAttribute('data-theme', darkModeMedia.matches ? 'dark' : 'light');
  }
});

// ── Global keyboard shortcuts ──

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === ',') {
    e.preventDefault();
    if (settings.isVisible()) {
      settings.close();
    } else {
      settings.open();
    }
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
    e.preventDefault();
    if (!settings.isVisible()) {
      chat.clear();
      goToLanding();
      landingPrompt.focus();
    }
  }
  if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
    e.preventDefault();
    sidebar.classList.toggle('collapsed');
  }
  if (e.key === 'Escape' && settings.isVisible()) {
    settings.close();
  }
});
