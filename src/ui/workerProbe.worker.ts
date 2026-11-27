// src/ui/workerProbe.worker.ts
// P0-3 探针的最小 Worker。只做三件事：报告 ready、回 ping、量 payload 克隆。
// 不 import 任何业务模块——探针要量的是「Worker 能不能加载、消息多贵」，
// 不是引擎体积；引擎图由 `bun run check:worker` 单独把关。

type ProbeMessage = {
  type?: string;
  id?: number;
  payload?: unknown;
};

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<ProbeMessage>) => void) | null;
  postMessage: (message: unknown) => void;
};

scope.onmessage = (event) => {
  const data = event.data ?? {};
  if (data.type === 'ping') {
    scope.postMessage({ type: 'pong', id: data.id });
    return;
  }
  if (data.type === 'echo') {
    const payload = data.payload as { messages?: unknown[] } | string | undefined;
    const messages = typeof payload === 'object' && payload !== null && Array.isArray(payload.messages)
      ? payload.messages.length
      : 0;
    scope.postMessage({
      type: 'echoed',
      id: data.id,
      bytes: typeof payload === 'string' ? payload.length : 0,
      messages,
    });
  }
};

scope.postMessage({ type: 'ready' });
