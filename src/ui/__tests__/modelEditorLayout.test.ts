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
    expect(styles).toContain('.provider-model-chip-test {');
    expect(styles).toContain('.provider-model-chip-test.llm-model-test-ok {');
    expect(styles).toContain('.provider-model-chip-test.llm-model-test-fail {');
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
    expect(settings).toContain("id=\"cfg-model-add\"");
    expect(settings).toContain("id=\"cfg-clear-models-btn\"");
    expect(settings).toContain("data-test-model");
    expect(settings).toContain("data-save-panel");
    expect(settings).toContain("data-add-provider");
  });
});
