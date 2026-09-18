// src/adapter/memory/ortAssets.d.ts
// E0.4 — bun's file loader embeds these ort-web assets into the compiled CLI
// and hands back a runtime path (see OrtWebEmbedder.ts). ort-web's own
// types.d.ts only declares the code subpaths, so give the two asset imports
// their shape here.
declare module 'onnxruntime-web/ort-wasm-simd-threaded.wasm' {
  /** Path/URL of the embedded WASM binary (bun file loader). */
  const src: string;
  export default src;
}

declare module 'onnxruntime-web/ort-wasm-simd-threaded.mjs' {
  /** Path/URL of the embedded WASM factory (bun file loader). */
  const src: string;
  export default src;
}
