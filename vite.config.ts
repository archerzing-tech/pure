import { createReadStream, existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';
import { defineConfig } from 'vite';

const require = createRequire(import.meta.url);
const APP_VERSION = JSON.parse(readFileSync(join(import.meta.dirname, 'package.json'), 'utf8')).version as string;
let ORT_WASM_DIR = dirname(require.resolve('onnxruntime-web/ort-wasm-simd-threaded.wasm'));
let ORT_OUTPUT_DIR = join(process.cwd(), 'dist');
const ORT_WASM_FILES = [
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.mjs',
] as const;

function onnxWasmAssets(): Plugin {
  return {
    name: 'pure-onnx-wasm-assets',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('/node_modules/@huggingface/transformers/')
        && !id.includes('/node_modules/onnxruntime-web/')) return;
      if (!code.includes('ort-wasm-simd-threaded')) return;
      return {
        code: code
          .replaceAll('ort-wasm-simd-threaded.asyncify.wasm', 'ort-wasm-simd-threaded.wasm')
          .replaceAll('ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.mjs')
          .replaceAll('new URL("ort-wasm-simd-threaded.wasm", import.meta.url).href', '"wasm/ort-wasm-simd-threaded.wasm"')
          .replaceAll("new URL('ort-wasm-simd-threaded.wasm', import.meta.url).href", "'wasm/ort-wasm-simd-threaded.wasm'")
          .replaceAll('new URL("ort-wasm-simd-threaded.wasm", void 0).href', '"wasm/ort-wasm-simd-threaded.wasm"')
          .replaceAll("new URL('ort-wasm-simd-threaded.wasm', void 0).href", "'wasm/ort-wasm-simd-threaded.wasm'")
          .replaceAll('new URL("ort-wasm-simd-threaded.mjs", import.meta.url).href', '"wasm/ort-wasm-simd-threaded.mjs"')
          .replaceAll("new URL('ort-wasm-simd-threaded.mjs', import.meta.url).href", "'wasm/ort-wasm-simd-threaded.mjs'")
          .replaceAll('new URL("ort-wasm-simd-threaded.mjs", void 0).href', '"wasm/ort-wasm-simd-threaded.mjs"')
          .replaceAll("new URL('ort-wasm-simd-threaded.mjs', void 0).href", "'wasm/ort-wasm-simd-threaded.mjs'"),
        map: null,
      };
    },
    configResolved(config: ResolvedConfig) {
      ORT_WASM_DIR = dirname(require.resolve('onnxruntime-web/ort-wasm-simd-threaded.wasm'));
      ORT_OUTPUT_DIR = config.build.outDir.startsWith('/')
        ? config.build.outDir
        : join(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use('/wasm', (req, res, next) => {
        const name = (req.url ?? '').split('?')[0].split('/').filter(Boolean).pop() ?? '';
        if (!ORT_WASM_FILES.includes(name as typeof ORT_WASM_FILES[number])) {
          next();
          return;
        }
        const source = join(ORT_WASM_DIR, name);
        if (!existsSync(source)) {
          next();
          return;
        }
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
        createReadStream(source).pipe(res);
      });
    },
    generateBundle() {
      for (const name of ORT_WASM_FILES) {
        this.emitFile({ type: 'asset', fileName: `wasm/${name}`, source: readFileSync(join(ORT_WASM_DIR, name)) });
      }
    },
    writeBundle() {
      // Rollup's static new URL(import.meta.url) analysis emits the unused
      // asyncify fallback after generateBundle. The runtime module explicitly
      // points Transformers.js at the standard SIMD assets above, so remove
      // only that unreferenced fallback after all assets have been written.
      const outputDirs = [ORT_OUTPUT_DIR, join(ORT_OUTPUT_DIR, 'assets')]
        .filter((dir) => existsSync(dir));
      const outputScripts = outputDirs.flatMap((dir) =>
        readdirSync(dir)
          .filter((fileName) => /\.(?:m?js)$/.test(fileName))
          .map((fileName) => join(dir, fileName)),
      );
      for (const dir of outputDirs) {
        for (const fileName of readdirSync(dir)) {
          const isUnusedFallback = /^ort-wasm-.*\.asyncify\./.test(fileName);
          const isHashedStandard = /^ort-wasm-simd-threaded-[A-Za-z0-9_-]+\.wasm$/.test(fileName);
          if (!isUnusedFallback && !isHashedStandard) continue;
          if (isHashedStandard) {
            for (const script of outputScripts) {
              const source = readFileSync(script, 'utf8');
              if (!source.includes(fileName)) continue;
              writeFileSync(script, source.replaceAll(fileName, 'wasm/ort-wasm-simd-threaded.wasm'));
            }
          }
          const referenced = outputScripts.some((script) =>
            readFileSync(script, 'utf8').includes(fileName));
          if (!referenced) unlinkSync(join(dir, fileName));
        }
      }
    },
  };
}

const plugins = [onnxWasmAssets()];

export default defineConfig({
  plugins,
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    // Transformers.js 4 uses BigInt64Array and bigint literals in its browser
    // runtime. Safari 13 cannot parse those modules; Safari 14 is the first
    // macOS WebKit target that matches the dependency's actual baseline.
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari14',
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    // Mermaid's parser is a lazy, upstream-generated module that is roughly
    // 680KB by itself; keep the warning threshold just above that known lazy
    // boundary while the application entry and eager chunks stay much smaller.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalizedId = id.replaceAll('\\\\', '/');
          if (!normalizedId.includes('/node_modules/')) return undefined;

          // Keep the initial app chunk focused on application code. These
          // libraries are either used by the markdown renderer or only after a
          // diagram/chart is requested, so stable vendor boundaries improve
          // cache reuse and prevent unrelated UI changes from invalidating
          // them.
          if (normalizedId.includes('/zrender/')) return 'zrender-vendor';
          const chartMatch = normalizedId.match(/\/echarts\/lib\/chart\/([^/]+)/);
          if (chartMatch) return `echarts-chart-${chartMatch[1]}`;
          if (normalizedId.includes('/echarts/lib/component/')) return 'echarts-components';
          if (normalizedId.includes('/echarts/lib/core/')) return 'echarts-core';
          if (normalizedId.includes('/echarts/')) return 'echarts-vendor';
          if (normalizedId.includes('/@anthropic-ai/sdk/') || normalizedId.includes('/openai/')) {
            return 'llm-vendor';
          }
          if (normalizedId.includes('/@tauri-apps/')) return 'tauri-vendor';
          if (normalizedId.includes('/marked/')
            || normalizedId.includes('/dompurify/')
            || normalizedId.includes('/plantuml-encoder/')) {
            return 'markdown-vendor';
          }
          if (normalizedId.includes('/@huggingface/transformers/')) return 'transformers-runtime';
          if (normalizedId.includes('/@mermaid-js/parser/')) return 'mermaid-parser';
          if (normalizedId.includes('/onnxruntime-web/')) return 'onnxruntime-web';
          if (normalizedId.includes('/katex/')) return 'katex';
          if (normalizedId.includes('/highlight.js/')) return 'highlight';
          return undefined;
        },
      },
    },
  },
});
