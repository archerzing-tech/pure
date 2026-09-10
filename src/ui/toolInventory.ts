// src/ui/toolInventory.ts
// Single source of truth for how the Settings → Tools toggles gate tools, plus
// the display grouping behind the "当前可用工具" inventory. The gate logic
// moved here verbatim from chat.ts so the settings page and the chat path can
// never drift apart: both import isToolEnabled from this module.

import { BUILT_IN_TOOL_DEFS, IMAGE_GEN_TOOL_DEF, isPublicToolName } from '../shared/toolDefs';
import { DYNAMIC_CAPABILITY_TOOL_DEFS, isDynamicCapabilityTool } from '../shared/dynamicCapabilityTools';
import { imageGenEnabled } from '../shared/providers';
import { isWebSearchLike } from './toolRow';
import type { PureConfig } from './config';

/** Which Settings → Tools toggle gates a tool. */
export type ToolGate = 'fs' | 'cmd' | 'git' | 'browser';

/** Why a tool is unavailable right now. */
export type ToolDisabledReason =
  | `toggle:${ToolGate}` // the matching settings toggle is off
  | 'needWorkspace' // plain-chat mode: fs/cmd/git tools would have no root
  | 'imageGenUnsupported'; // the connected provider/model can't generate images

export interface ToolInventoryEntry {
  name: string;
  description: string;
  enabled: boolean;
  /** The settings toggle that gates this tool (undefined = not toggleable). */
  gate?: ToolGate;
  /** Present only when enabled === false. */
  disabledReason?: ToolDisabledReason;
}

export interface ToolInventoryGroup {
  id: 'fs' | 'cmd' | 'git' | 'web' | 'other';
  tools: ToolInventoryEntry[];
}

// File-system tool family — gated by the `toolFS` settings toggle so users can
// disable read/write/edit/search as a group from Settings → Tools.
export const FS_TOOL_NAMES: ReadonlySet<string> = new Set([
  'read_file', 'write_file', 'edit_file', 'search_files', 'find_files', 'list_files',
  'glob_files', 'create_directory', 'diff_files', 'replace_files',
]);

function isFsTool(name: string): boolean {
  return FS_TOOL_NAMES.has(name);
}

/**
 * Map a tool name to its settings-toggle gate. Unknown tools (subagents,
 * MCP-discovered, future additions) default to enabled so the gate never
 * silently hides a tool the user didn't explicitly disable.
 */
export function isToolEnabled(name: string, config: PureConfig): boolean {
  if (isWebSearchLike(name)) return config.toolBrowser;
  if (name === 'execute_command') return config.toolCmd;
  if (name.startsWith('git_')) return config.toolGit;
  if (isFsTool(name)) return config.toolFS;
  return true;
}

/** Inverse of isToolEnabled: which toggle (if any) gates this name. */
export function toolGate(name: string): ToolGate | undefined {
  if (isWebSearchLike(name)) return 'browser';
  if (name === 'execute_command') return 'cmd';
  if (name.startsWith('git_')) return 'git';
  if (isFsTool(name)) return 'fs';
  return undefined;
}

// Display grouping for the settings inventory. Groups are semantic; a row's
// on/off state always comes from the real gates above, never from group
// membership — e.g. code_searcher sits with the file tools but is NOT gated by
// the fs toggle, and download_file sits with the web tools while nothing gates
// it. Anything not listed lands in "other", so a future tool can never
// silently vanish from the inventory.
const DISPLAY_GROUPS: Array<{ id: ToolInventoryGroup['id']; names: ReadonlySet<string> }> = [
  { id: 'fs', names: new Set([...FS_TOOL_NAMES, 'code_searcher']) },
  { id: 'cmd', names: new Set(['execute_command']) },
  { id: 'git', names: new Set(['git_diff', 'git_log', 'git_status']) },
  {
    id: 'web',
    names: new Set([
      'web_search', 'web_fetch', 'web_scrape', 'web_public_api',
      'researcher_web', 'researcher_docs', 'download_file',
    ]),
  },
  {
    id: 'other',
    names: new Set(['sys_info', 'create_document', 'generate_image',
      ...DYNAMIC_CAPABILITY_TOOL_DEFS.map((t) => t.name)]),
  },
];

const GROUP_ORDER: ToolInventoryGroup['id'][] = ['fs', 'cmd', 'git', 'web', 'other'];

/** Plain-chat second gate, mirrored from chat.ts createToolAdapter: without a
 *  workspace only web tools, sys_info, generate_image and the dynamic
 *  capability tools are exposed — everything else would have no root. */
function availableWithoutWorkspace(name: string): boolean {
  return isWebSearchLike(name)
    || name === 'sys_info'
    || name === 'generate_image'
    || DYNAMIC_CAPABILITY_TOOL_DEFS.some((tool) => tool.name === name);
}

/** Effective tool inventory for the Settings → Tools page: every built-in,
 *  conditional and dynamic-capability tool with its current availability. */
export function listToolInventory(config: PureConfig, opts: { hasWorkspace: boolean }): ToolInventoryGroup[] {
  const imageGen = imageGenEnabled(config.customProviders, config.provider, config.model);
  const descriptions = new Map<string, string>();
  for (const def of [...BUILT_IN_TOOL_DEFS, IMAGE_GEN_TOOL_DEF, ...DYNAMIC_CAPABILITY_TOOL_DEFS]) {
    // Mirror the adapters' model-visibility filter: legacy-hidden aliases
    // (web_search / web_fetch) still execute for replayed sessions but never
    // appear in model tool lists, so they must not show up as available here.
    if (!isPublicToolName(def.name) && !isDynamicCapabilityTool(def.name)) continue;
    descriptions.set(def.name, def.description);
  }

  const entry = (name: string): ToolInventoryEntry => {
    const description = descriptions.get(name) ?? '';
    const gate = toolGate(name);
    if (!isToolEnabled(name, config)) {
      // isToolEnabled is false only for gated tools, so `gate` is set here;
      // the fallback keeps the reason type total for TypeScript.
      return { name, description, enabled: false, gate, disabledReason: gate ? `toggle:${gate}` : 'needWorkspace' };
    }
    if (!opts.hasWorkspace && !availableWithoutWorkspace(name)) {
      return { name, description, enabled: false, gate, disabledReason: 'needWorkspace' };
    }
    if (name === 'generate_image' && !imageGen) {
      return { name, description, enabled: false, gate, disabledReason: 'imageGenUnsupported' };
    }
    return { name, description, enabled: true, gate };
  };

  // Bucket every definition by display group (unknowns → "other"), then emit
  // the groups in the fixed fs → cmd → git → web → other order.
  const buckets = new Map<ToolInventoryGroup['id'], ToolInventoryEntry[]>();
  for (const name of descriptions.keys()) {
    const group = DISPLAY_GROUPS.find((g) => g.names.has(name))?.id ?? 'other';
    const bucket = buckets.get(group) ?? [];
    bucket.push(entry(name));
    buckets.set(group, bucket);
  }
  return GROUP_ORDER.map((id) => ({ id, tools: buckets.get(id) ?? [] }));
}
