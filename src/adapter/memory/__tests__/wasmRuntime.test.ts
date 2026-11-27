// src/adapter/memory/__tests__/wasmRuntime.test.ts
// Worker 迁移 P0：wasm 资产基准 URI 必须可注入——Worker 没有 document，
// 用 self.location 会拼出 assets/wasm 的错误路径（见 wasmRuntime.ts 注释）。
import { describe, expect, it } from 'bun:test';
import { configureTransformersWasm, resolveWasmAsset } from '../wasmRuntime';

describe('resolveWasmAsset', () => {
  it('以注入的页面基准解析 dist/wasm 资产', () => {
    expect(resolveWasmAsset('ort-wasm-simd-threaded.wasm', 'https://pure.local/index.html'))
      .toBe('https://pure.local/wasm/ort-wasm-simd-threaded.wasm');
  });

  it('页面在子路径时保留子路径，不被 worker 脚本目录改写', () => {
    expect(resolveWasmAsset('x.wasm', 'https://pure.local/app/index.html'))
      .toBe('https://pure.local/app/wasm/x.wasm');
  });

  it('显式空基准退回裸文件名，不拼出错误目录', () => {
    expect(resolveWasmAsset('x.wasm', '')).toBe('x.wasm');
  });
});

describe('configureTransformersWasm', () => {
  it('注入 baseUri 时把 wasmPaths 固定到页面基准', () => {
    const env = { backends: { onnx: { wasm: {} as { wasmPaths?: unknown; numThreads?: number } } } };
    configureTransformersWasm(env, { baseUri: 'https://pure.local/index.html' });
    expect(env.backends.onnx.wasm.wasmPaths).toEqual({
      wasm: 'https://pure.local/wasm/ort-wasm-simd-threaded.wasm',
      mjs: 'https://pure.local/wasm/ort-wasm-simd-threaded.mjs',
    });
  });
});
