// src/shared/plantuml-encoder.d.ts
// Ambient module declaration for plantuml-encoder (which ships no .d.ts).
// Loaded automatically by TypeScript from src/shared/ via the project's
// typeRoots / include config; no explicit import is necessary at use sites.

declare module 'plantuml-encoder' {
  const enc: {
    encode(input: string): string;
  };
  export default enc;
}
