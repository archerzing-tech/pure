// src/shared/desktopToolkit.ts
// 桌面控制工具包（电脑端操作能力 P3，2026-11-08）：鼠标键盘不内化——按用户
// 定调以插件形态提供。载体=pure 现成的外部脚本工具接缝（~/.pure/tools/
// <name>/TOOL.json，执行=execute_command 既有体系，零新安全面）：install
// 工具把预置 manifest 落盘，注册表扫描到即在下一轮生效（外部工具常驻可见）。
//
// 模板在此单源：CLI 壳（node:fs 原语）与 GUI 壳（Rust write_file command）
// 共用同一份 manifest 数据，改文案/坐标语义两边同步。

/** macOS 预置包：cliclick（brew install cliclick）三件。坐标=逻辑点
 *  （CGEvent 空间，与 screencapture 截图的像素坐标在 Retina 上差 scale
 *  因子——截图像素坐标 ×(logical/pixel) 换算）。辅助功能授权是系统级前置：
 *  系统设置 → 隐私与安全性 → 辅助功能 → 勾选 pure。 */
export interface DesktopToolManifest {
  version: number;
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  exec: string;
  tags?: string[];
  riskLevel?: 'low' | 'medium' | 'high';
  timeoutMs?: number;
}

const RETINA_NOTE = 'Coordinates are logical points (CGEvent space). If you located the target on a screencapture screenshot, convert first: logical = pixel × (logicalSize/pixelSize) — on standard Retina that is pixel/2. Take a screenshot (execute_command "screencapture -x /tmp/shot.png") and read_file the image to find the target before clicking.';

export const DESKTOP_TOOL_MANIFESTS: DesktopToolManifest[] = [
  {
    version: 1,
    name: 'desktop_click',
    description: `Click at a point on the macOS desktop (via cliclick). ${RETINA_NOTE} Requires cliclick (brew install cliclick) and the Accessibility permission for the pure app (System Settings → Privacy & Security → Accessibility); without the permission clicks land nowhere.`,
    input_schema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Logical x coordinate of the click point' },
        y: { type: 'number', description: 'Logical y coordinate of the click point' },
      },
      required: ['x', 'y'],
    },
    exec: 'cliclick -e 80 c:{x},{y}',
    tags: ['write'],
    riskLevel: 'low',
    timeoutMs: 15000,
  },
  {
    description: 'Type text at the current keyboard focus on the macOS desktop (via cliclick t:). The text is typed verbatim — click into the target field first (desktop_click). Does NOT press Enter afterwards; use desktop_key with "return" when a submit is needed. Requires cliclick (brew install cliclick) and the Accessibility permission for the pure app.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to type, e.g. a search query or form field value' },
      },
      required: ['text'],
    },
    exec: 'cliclick t:{text}',
    version: 1,
    name: 'desktop_type',
    tags: ['write'],
    riskLevel: 'low',
    timeoutMs: 30000,
  },
  {
    description: 'Press a single key on the macOS desktop (via cliclick kp:) — return, tab, esc, space, delete, arrow-up/down/left/right, f1-f12. Modifier combos are not covered; fall back to execute_command with osascript System Events for those. Requires cliclick (brew install cliclick) and the Accessibility permission for the pure app.',
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key name: return, tab, esc, space, delete, arrow-up, arrow-down, arrow-left, arrow-right, f1…f12' },
      },
      required: ['key'],
    },
    exec: 'cliclick kp:{key}',
    version: 1,
    name: 'desktop_key',
    tags: ['write'],
    riskLevel: 'low',
    timeoutMs: 15000,
  },
];

const DESKTOOL_MANIFEST_NAMES = DESKTOP_TOOL_MANIFESTS.map((m) => m.name);

export interface DesktopToolkitDeps {
  platform: string;
  /** cliclick 是否已在 PATH（壳侧自测后注入——CLI 用 node:fs 探，GUI 跑
   *  execute_command 探，两侧原语不同）。 */
  cliclickFound: boolean;
  ensureDir(dir: string): Promise<void> | void;
  writeFile(file: string, content: string): Promise<void> | void;
}

export interface DesktopToolkitInstallResult {
  ok: boolean;
  installed: string[];
  message: string;
}

/** 安装：落盘 TOOL.json 三件到 ~/.pure/tools/<name>/。幂等（重复安装覆盖
 *  同名文件）。macOS only——Windows SendInput 预置包未提供，如实回话并给
 *  第三方 MCP 路线。 */
export async function installDesktopControl(deps: DesktopToolkitDeps, pureDir: string): Promise<DesktopToolkitInstallResult> {
  if (deps.platform !== 'darwin') {
    return {
      ok: false,
      installed: [],
      message: '桌面控制预置包目前只提供 macOS 版（cliclick 三件：desktop_click / desktop_type / desktop_key）。Windows 可以接入第三方 computer-use MCP 服务器获得同等能力（register_mcp_server）。没有写入任何文件。',
    };
  }
  const toolsDir = `${pureDir}/tools`;
  try {
    for (const manifest of DESKTOP_TOOL_MANIFESTS) {
      const dir = `${toolsDir}/${manifest.name}`;
      await deps.ensureDir(dir);
      await deps.writeFile(`${dir}/TOOL.json`, JSON.stringify(manifest, null, 2) + '\n');
    }
  } catch (err: unknown) {
    return {
      ok: false,
      installed: [],
      message: `安装失败：${err instanceof Error ? err.message : String(err)}。没有写入或只写入了部分文件，可重新安装覆盖。`,
    };
  }
  const names = DESKTOOL_MANIFEST_NAMES.join(' / ');
  const cliclickLine = deps.cliclickFound
    ? 'cliclick 已检测到 ✓'
    : 'cliclick 未检测到 ✗ ——先安装：brew install cliclick（装完无需重装本包，直接可用）';
  return {
    ok: true,
    installed: DESKTOOL_MANIFEST_NAMES,
    message: `桌面控制工具包已安装（${DESKTOP_TOOL_MANIFESTS.length} 个工具，下一轮对话生效）：\n` +
      `1. desktop_click — 点击屏幕坐标\n` +
      `2. desktop_type — 在当前焦点键入文本\n` +
      `3. desktop_key — 按单个键（回车/Tab/方向键…）\n` +
      `前置条件（缺一个就点不动）：\n` +
      `- ${cliclickLine}\n` +
      `- 辅助功能授权：系统设置 → 隐私与安全性 → 辅助功能 → 勾选 pure\n` +
      `使用建议：先 screencapture -x 截屏 → read_file 看图定位目标 → desktop_click 点击（Retina 截图像素坐标要先换算成逻辑点）。\n` +
      `已安装工具：${names}。`,
  };
}

/** install_desktop_control 的工具 schema（两侧壳共用）。 */
export const INSTALL_DESKTOP_CONTROL_DEF = {
  name: 'install_desktop_control',
  description: 'Install the desktop-control toolkit (desktop_click / desktop_type / desktop_key, macOS via cliclick) into ~/.pure/tools/ as external tools; they become visible next turn. Use when the user asks to operate the desktop GUI — click buttons, type into apps, navigate windows. Idempotent: reinstalling overwrites the same files. Prerequisites (reported after install): cliclick (brew install cliclick) and the Accessibility permission for the pure app. On the very first install the tools are NOT callable in this same turn — tell the user they take effect next turn, or finish this turn with the plan.',
  input_schema: {
    type: 'object',
    properties: {},
    required: [],
  },
};
