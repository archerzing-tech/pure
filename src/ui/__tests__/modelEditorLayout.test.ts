import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

const index = readFileSync(new URL('../../../index.html', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

function sectionBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  return startIndex >= 0 && endIndex >= 0 ? source.slice(startIndex, endIndex) : '';
}

describe('scheme 4 model library layout', () => {
  it('keeps the canonical model value hidden and uses a separate add-model input', () => {
    const drawer = sectionBetween(index, 'id="provider-v4-model-drawer"', 'id="provider-v4-connection-drawer"');
    expect(drawer).toContain('id="cfg-model" type="hidden"');
    expect(drawer).toContain('id="cfg-model-add"');
    expect(drawer).toContain('id="cfg-model-list"');
    expect(drawer).toContain('provider-model-default-section');
    expect(drawer).not.toContain('provider-model-add-section');
    const library = sectionBetween(drawer, 'provider-model-library-section', '</section>');
    expect(library).toContain('id="cfg-model-add"');
    expect(library).toContain('id="cfg-model-list"');
    expect(library).toContain('id="cfg-clear-models-btn"');
  });

  it('does not put the model editor back into connection settings', () => {
    const connection = sectionBetween(index, 'id="provider-v4-connection-drawer"', '<!-- Tools -->');
    expect(connection).not.toContain('provider-model-row');
    expect(connection).not.toContain('cfg-model-add');
  });

  it('uses sectioned default, add, and model-list controls', () => {
    const drawerStyles = sectionBetween(styles, '.provider-v4-model-drawer #provider-v4-model-editor', '.provider-v4-connection-drawer {');
    expect(styles).toContain('.provider-v4-model-drawer {\n  overflow: visible;');
    expect(drawerStyles).toContain('.provider-v4-model-drawer #provider-v4-model-editor {\n  padding: 10px 14px 12px;\n  overflow: visible;');
    expect(drawerStyles).toContain('.provider-v4-model-drawer #cfg-model-list {\n  display: flex;');
    expect(drawerStyles).toContain('border-radius: 0;\n  background: transparent;');
    expect(drawerStyles).toContain('max-height: none;\n  margin: 0;');
    expect(drawerStyles).toContain('overflow: visible;');
    expect(drawerStyles).toContain('.provider-v4-model-drawer .provider-model-input-group {\n  display: flex;');
    expect(drawerStyles).toContain('margin: 0 12px 8px;');
    expect(drawerStyles).not.toContain('provider-model-add-section');
    expect(drawerStyles).toContain('height: 32px;\n  min-height: 32px;');
    expect(drawerStyles).toContain('.provider-v4-model-drawer .provider-model-editor-section {');
    expect(drawerStyles).toContain('.provider-v4-model-drawer .provider-model-clear-btn:disabled {');
  });
});
