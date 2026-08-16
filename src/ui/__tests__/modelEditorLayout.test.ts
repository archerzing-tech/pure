import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

const index = readFileSync(new URL('../../../index.html', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const styles = readFileSync(new URL('../styles.css', import.meta.url), 'utf8').replaceAll('\r\n', '\n');

function sectionBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  return startIndex >= 0 && endIndex >= 0 ? source.slice(startIndex, endIndex) : '';
}

describe('scheme 4 model library layout', () => {
  it('keeps the default outside the drawer and places the model library before add controls', () => {
    const drawer = sectionBetween(index, 'id="provider-v4-model-drawer"', 'id="provider-v4-connection-default"');
    expect(drawer).toContain('id="provider-v4-model-drawer-body" class="provider-v4-model-drawer-body" hidden');
    expect(drawer).toContain('provider-v4-model-drawer-toggle');
    expect(drawer).toContain('id="cfg-model" type="hidden"');
    expect(drawer).toContain('id="cfg-model-add"');
    expect(drawer).toContain('id="cfg-model-list"');
    expect(drawer).not.toContain('provider-model-default-section');
    expect(drawer).not.toContain('provider-model-library-section');
    const listIndex = drawer.indexOf('id="cfg-model-list"');
    const addIndex = drawer.indexOf('provider-model-input-group');
    expect(listIndex).toBeGreaterThan(-1);
    expect(addIndex).toBeGreaterThan(listIndex);
    expect(drawer).toContain('id="cfg-clear-models-btn"');
  });

  it('keeps the default surfaces separate from their exclusive drawers', () => {
    const shellStart = index.indexOf('id="provider-v4-shell"');
    const summary = index.indexOf('class="provider-v4-summary"', shellStart);
    const providerDrawer = index.indexOf('id="provider-v4-provider-drawer"', shellStart);
    const modelDefault = index.indexOf('id="provider-v4-current-model"', shellStart);
    const modelDrawer = index.indexOf('id="provider-v4-model-drawer"', shellStart);
    const connectionDefault = index.indexOf('id="provider-v4-connection-default"', shellStart);
    const connectionDrawer = index.indexOf('id="provider-v4-connection-drawer"', shellStart);
    expect(summary).toBeGreaterThan(shellStart);
    expect(summary).toBeLessThan(providerDrawer);
    expect(providerDrawer).toBeLessThan(modelDefault);
    expect(modelDefault).toBeLessThan(modelDrawer);
    expect(modelDrawer).toBeLessThan(connectionDefault);
    expect(connectionDefault).toBeLessThan(connectionDrawer);
    expect(index).toContain('id="provider-v4-connection-drawer" hidden');
    expect(index).toContain('data-close-connection');
    expect(index).toContain('data-open-provider');
    expect(index).toContain('id="provider-v4-model-drawer-body" class="provider-v4-model-drawer-body" hidden');
    expect(index).not.toContain('provider-v4-connection-toggle');
    const connectionDefaultSection = sectionBetween(index, 'id="provider-v4-connection-default"', 'id="provider-v4-connection-drawer"');
    expect(connectionDefaultSection).toContain('id="provider-v4-test-btn"');
    expect(connectionDefaultSection).toContain('data-open-connection');
  });

  it('does not put the model editor back into connection settings', () => {
    const connection = sectionBetween(index, 'id="provider-v4-connection-drawer"', '<!-- Tools -->');
    expect(connection).not.toContain('provider-model-row');
    expect(connection).not.toContain('cfg-model-add');
  });

  it('uses drawer model rows and the same hidden-drawer contract for every surface', () => {
    const drawerStyles = sectionBetween(styles, '.provider-v4-model-drawer #provider-v4-model-editor', '.provider-v4-connection-drawer {');
    expect(styles).toContain('.provider-v4-model-drawer {\n  position: relative;\n  z-index: 1;\n  margin: 0;');
    expect(styles).toContain('.provider-v4-provider-drawer[hidden],\n.provider-v4-connection-drawer[hidden],\n.provider-v4-model-drawer-body[hidden] { display: none; }');
    expect(styles).not.toContain('.provider-v4-model-drawer[hidden]');
    expect(styles).toContain('.provider-v4-model-drawer-body {');
    expect(styles).toContain('.provider-v4-connection-default {');
    expect(styles).toContain('.provider-v4-shell > .provider-v4-summary,\n.provider-v4-shell > .provider-v4-provider-drawer,\n.provider-v4-shell > .provider-v4-current-model,');
    expect(styles).toContain('width: 100%;\n  box-sizing: border-box;\n  margin-inline: 0;');
    expect(styles).toContain('.provider-v4-connection-drawer .provider-config-fields .setting-row[hidden] { display: none; }');
    expect(styles).not.toContain('.provider-v4-connection-toggle');
    expect(drawerStyles).toContain('.provider-v4-model-drawer #provider-v4-model-editor {\n  padding: 10px 10px 12px;\n  overflow: visible;');
    expect(drawerStyles).toContain('.provider-v4-model-drawer #cfg-model-list {\n  display: flex;');
    expect(drawerStyles).toContain('border-radius: 0;\n  background: transparent;');
    expect(drawerStyles).toContain('max-height: none;\n  margin: 0;');
    expect(drawerStyles).toContain('overflow: visible;');
    expect(drawerStyles).toContain('.provider-v4-model-drawer .provider-model-input-group {\n  display: flex;');
    expect(drawerStyles).toContain('margin: 10px 0 0;');
    expect(drawerStyles).not.toContain('provider-model-add-section');
    expect(drawerStyles).not.toContain('.provider-v4-model-drawer .provider-model-editor-section {');
    expect(drawerStyles).toContain('min-height: 42px;');
    expect(drawerStyles).toContain('.provider-v4-model-drawer .provider-model-clear-btn:disabled {');
  });
});
