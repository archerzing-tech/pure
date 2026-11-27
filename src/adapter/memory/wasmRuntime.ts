// src/adapter/memory/wasmRuntime.ts
interface TransformersEnvironmentWithWasm {
  backends: {
    onnx: {
      wasm?: {
        wasmPaths?: unknown;
        numThreads?: number;
      };
    };
  };
}

/**
 * 解析 ort wasm 资产 URL。
 *
 * 为什么不是一行 `document.baseURI`：Worker 里没有 `document`，而 wasm 资产是按
 * **页面**基准放在 `dist/wasm/` 的。用 `self.location.href` 会指向 worker 脚本所在的
 * `assets/` 目录，拼出 `assets/wasm/...` 的错误路径。所以基准 URI 由调用方注入
 * （Worker 在 attach 时从主线程拿到）；没有页面上文时才退回脚本自身 URL，最后退回
 * 裸文件名（Node/测试环境，调用方另有路径解析）。
 */
export function resolveWasmAsset(name: string, baseUri?: string): string {
  const base = baseUri
    ?? (typeof document !== 'undefined' ? document.baseURI : undefined)
    ?? (typeof self !== 'undefined' && typeof self.location?.href === 'string'
      ? self.location.href
      : undefined);
  if (!base) return name;
  return new URL(`wasm/${name}`, base).href;
}

export function configureTransformersWasm(
  environment: TransformersEnvironmentWithWasm,
  options?: { baseUri?: string },
): void {
  const wasm = environment.backends.onnx.wasm;
  if (!wasm) return;
  wasm.wasmPaths = {
    wasm: resolveWasmAsset('ort-wasm-simd-threaded.wasm', options?.baseUri),
    mjs: resolveWasmAsset('ort-wasm-simd-threaded.mjs', options?.baseUri),
  };
  if (typeof SharedArrayBuffer === 'undefined'
    || typeof Worker === 'undefined'
    || (typeof crossOriginIsolated !== 'undefined' && !crossOriginIsolated)) {
    wasm.numThreads = 1;
  }
}
