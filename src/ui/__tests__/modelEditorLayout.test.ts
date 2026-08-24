import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

const index = readFileSync(new URL('../../../index.html', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const styles = readFileSync(new URL('../styles.css', import.meta.url), 'utf8').replaceAll('\r\n', '\n');

function sectionBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  return startIndex >= 0 && endIndex >= 0 ? source.slice(startIndex, endIndex) : '';
}

describe('LLM page layout (default-model bar + provider grid)', () => {
  it('starts with the default-model bar, then the provider grid', () => {
    const page = sectionBetween(index, 'data-page="llm"', '<!-- Tools -->');
    const bar = page.indexOf('id="llm-default-bar"');
    const gridHead = page.indexOf('class="llm-grid-head"');
    const grid = page.indexOf('id="llm-provider-grid"');
    expect(bar).toBeGreaterThan(-1);
    expect(gridHead).toBeGreaterThan(bar);
    expect(grid).toBeGreaterThan(gridHead);
    expect(page).toContain('id="llm-default-model-name"');
    expect(page).toContain('id="llm-default-model-provider"');
    expect(page).toContain('id="llm-default-model-btn"');
    expect(page).toContain('id="llm-default-model-menu"');
    expect(page).toContain('id="llm-provider-count"');
  });

  it('no longer ships the provider-v4 drawers or the active-provider select', () => {
    expect(index).not.toContain('provider-v4-shell');
    expect(index).not.toContain('provider-v4-provider-drawer');
    expect(index).not.toContain('provider-v4-connection-drawer');
    expect(index).not.toContain('provider-v4-current-model');
    expect(index).not.toContain('id="cfg-provider"');
    expect(index).not.toContain('deepseek-anthropic');
    expect(index).not.toContain('provider-config-card');
    expect(index).not.toContain('provider-activate-btn');
  });

  it('renders the grid as a 2-column responsive grid', () => {
    expect(styles).toContain('.llm-provider-grid {\n  display: grid;\n  grid-template-columns: repeat(2, minmax(0, 1fr));');
  });

  it('styles the default bar, dropdown menu, cards and expanded panel', () => {
    expect(styles).toContain('.llm-default-bar {');
    expect(styles).toContain('.llm-default-model-menu[hidden] { display: none; }');
    expect(styles).toContain('.llm-default-menu-item.active {');
    expect(styles).toContain('.llm-provider-card {');
    expect(styles).toContain('.llm-provider-add-card {');
    expect(styles).toContain('.llm-provider-panel {\n  grid-column: 1 / -1;');
    expect(styles).toContain('.llm-provider-panel-head {');
    expect(styles).toContain('.llm-provider-panel-foot {');
    expect(styles).toContain('.llm-test-conn-btn {');
    expect(styles).toContain('.llm-test-conn-btn.llm-model-test-ok {');
    expect(styles).toContain('.llm-test-conn-btn.llm-model-test-fail {');
    expect(styles).toContain('.cs-trigger {');
    expect(styles).toContain('.cs-popup {\n  position: fixed;');
    expect(styles).toContain('.cs-item[aria-selected="true"] {');
    expect(styles).toContain('.llm-model-row {');
    expect(styles).toContain('.llm-model-row-id {');
    expect(styles).toContain('.llm-model-row-name {');
    expect(styles).toContain('.llm-model-row-radio {');
    // Marks for every built-in registry entry.
    for (const id of ['deepseek', 'qwen', 'glm', 'moonshot', 'minimax', 'openai', 'openrouter', 'nvidia']) {
      expect(styles).toContain(`.provider-mark-${id} {`);
    }
  });

  it('keeps the model editor ids shared with the settings panel code', () => {
    // The expanded panel is rendered by settings.ts, but its field ids are
    // part of the contract (single panel ⇒ ids never collide).
    expect(index).toContain('id="llm-provider-grid"');
    // settings.ts must reference the same ids it renders into.
    const settings = readFileSync(new URL('../settings.ts', import.meta.url), 'utf8');
    expect(settings).toContain("id=\"cfg-model-list\"");
    expect(settings).toContain("id=\"cfg-test-conn-btn\"");
    expect(settings).toContain("id=\"cfg-clear-models-btn\"");
    expect(settings).toContain("llm-model-row-id");
    expect(settings).toContain("llm-model-row-name");
    expect(settings).toContain("data-remove-row");
    expect(settings).toContain("data-save-panel");
    expect(settings).toContain("data-add-provider");
  });

  it('renders the expanded panel as a vertical form: name → base URL → API key + verify → model list', () => {
    const settings = readFileSync(new URL('../settings.ts', import.meta.url), 'utf8');
    // Order of the form rows inside the panel body.
    const body = sectionBetween(settings, '<div class="llm-provider-panel-body">', '<div class="llm-provider-panel-foot">');
    const nameRow = body.indexOf('cfg-custom-name-edit');
    const baseUrlRow = body.indexOf('cfg-baseurl');
    const apiKeyRow = body.indexOf('cfg-apikey');
    const verifyBtn = body.indexOf('cfg-test-conn-btn');
    const modelRow = body.indexOf('cfg-model-list');
    expect(nameRow).toBeGreaterThan(-1);
    expect(baseUrlRow).toBeGreaterThan(nameRow);
    expect(apiKeyRow).toBeGreaterThan(baseUrlRow);
    expect(verifyBtn).toBeGreaterThan(apiKeyRow);
    expect(modelRow).toBeGreaterThan(verifyBtn);
    // The name input lives in the body as the first form row (not the head).
    expect(settings).toContain('<label class="llm-form-label" for="cfg-custom-name-edit"');
    // Model rows: radio + id input + optional name input, min 2 rows.
    expect(settings).toContain('class="llm-model-row');
    expect(settings).toContain('llm-model-row-radio');
    expect(settings).toContain('llm.model.idPlaceholder');
    expect(settings).toContain('llm.model.namePlaceholder');
    // Padding to a minimum of 2 rows (real models + empty add-slots).
    expect(settings).toContain('models.length >= 2 ? models :');
    expect(settings).toContain('[...models, \'\', \'\'].slice(0, 2)');
  });

  it('keeps proxy bypass rules at provider scope only', () => {
    const settings = readFileSync(new URL('../settings.ts', import.meta.url), 'utf8');
    expect(index).toContain('id="cfg-proxy-bypass-providers"');
    expect(index).not.toContain('id="cfg-proxy-bypass-models"');
    expect(settings).toContain('cfg-proxy-bypass-providers');
    expect(settings).not.toContain('cfg-proxy-bypass-models');
    expect(settings).not.toContain('bypassModels: normalizeProxyList');
  });
});
