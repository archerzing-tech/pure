// src/shared/signalShutdown.ts
// 审计批 6④ — 双击 Ctrl-C 的逃生门。旧写法 `if (stopping) return` 把第二个
// 信号整个吞掉：gateway.stop() 一旦挂死，进程没有任何手段退出，只能外部
// kill -9。契约：第一个信号触发优雅停机（不等待、不阻塞信号处理器）；优雅
// 停机尚未落定期间的第二个信号立即强制退出。130 = 128+2（SIGINT 惯例码；
// SIGTERM 的二次点击同样走这里——优雅路径已完成时进程已死，多退无害）。

export type SignalName = 'SIGINT' | 'SIGTERM';

/** 停机状态机。三个依赖全部注入（优雅停机、强制退出、日志），测试不碰真实
 *  进程；宿主接线时 graceful 内部自行负责 `process.exit(0)`。 */
export function createSignalShutdown(
  graceful: (signal: SignalName) => Promise<void> | void,
  exit: (code: number) => void,
  log: (message: string) => void,
): (signal: SignalName) => void {
  let stopping = false;
  return (signal: SignalName) => {
    if (!stopping) {
      stopping = true;
      log(`收到 ${signal}，正在停止…`);
      void graceful(signal);
      return;
    }
    log('停止尚未完成，再次收到信号 — 强制退出');
    exit(130);
  };
}
