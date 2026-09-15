// src/shared/plantuml-core.d.ts
// Ambient declarations for @plantuml/core — the official PlantUML engine built
// to JavaScript with TeaVM (no Java, no server, no network). The package ships
// no .d.ts, so the two exported entry points and the three on-demand sibling
// bundles we load are typed here. Picked up automatically from src/shared/ via
// the project's include config; no explicit import is needed at use sites.

declare module '@plantuml/core' {
  interface PlantumlRenderOptions {
    /** Emit the dark palette instead of the default light one. */
    dark?: boolean;
    /** Upper bound for the emitted SVG size in bytes; -1 means unlimited. */
    maxSvgSize?: number;
  }

  /** Render `lines` into the DOM element with `targetId` (asynchronous). */
  export function render(lines: string[], targetId: string, options?: PlantumlRenderOptions): void;

  /**
   * Render `lines` and deliver the SVG source to `onSuccess`; a failure
   * message goes to `onError`. Renders must be SERIALIZED — the engine keeps
   * shared internal state and concurrent calls overwrite each other.
   */
  export function renderToString(
    lines: string[],
    onSuccess: (svg: string) => void,
    onError: (message: string) => void,
    options?: PlantumlRenderOptions,
  ): void;
}

// Sibling bundles the engine pulls in on demand (loaded locally by
// plantumlDiagram.ts through PLANTUML_STDLIB_LOADER — never over the network).
declare module '@plantuml/core/themes.js';
declare module '@plantuml/core/emoji.js';
declare module '@plantuml/core/openiconic.js';

// Vite's `?url` suffix: the asset is emitted next to the bundle and the import
// resolves to its URL.
declare module '*?url' {
  const url: string;
  export default url;
}
