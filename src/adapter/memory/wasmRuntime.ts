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

function wasmAsset(name: string): string {
  if (typeof document === 'undefined') return name;
  return new URL(`wasm/${name}`, document.baseURI).href;
}

export function configureTransformersWasm(environment: TransformersEnvironmentWithWasm): void {
  const wasm = environment.backends.onnx.wasm;
  if (!wasm) return;
  wasm.wasmPaths = {
    wasm: wasmAsset('ort-wasm-simd-threaded.wasm'),
    mjs: wasmAsset('ort-wasm-simd-threaded.mjs'),
  };
  if (typeof SharedArrayBuffer === 'undefined'
    || typeof Worker === 'undefined'
    || (typeof crossOriginIsolated !== 'undefined' && !crossOriginIsolated)) {
    wasm.numThreads = 1;
  }
}
