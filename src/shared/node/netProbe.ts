// src/shared/node/netProbe.ts
// CLI 宿主的网络探测适配层：**只**提供 node 原语（TCP connect / TLS 握手与
// 证书读取），判定与归因全部委托给 src/shared/netProbeCore.ts。
//
// 为什么核心与本层分开：`src/shared/` 的模块会被 Vite 打进 WebView 包，而
// node:net / node:tls 在浏览器构建里是 __vite-browser-external 空壳，rollup 在
// 解析期就报 `"connect" is not exported by ...`，整个 WebView 构建失败——不是
// 运行期降级。把拨号能力放在 `src/shared/node/` 这一个目录里，「哪些模块会
// 拖 node 进 bundle」就从靠人记住变成看路径。
//
// 被放弃的方案：(a) 让核心自己动态 import node:net —— Vite 仍会把
// `import('node:net')` 打进 chunk 并留下同样的 external 桩；(b) 下沉 Rust 做
// 四步探测 —— Rust 侧只有 test_proxy / web_fetch_probe 这类「一次性 HTTP 请求」
// 原语，没有暴露分层握手结果，要做四步必须新增 command。

import { connect as tcpConnect } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import {
  certMatchesHost,
  diagnoseNetwork as diagnoseNetworkCore,
  type NetProbeReport,
  type ProbeDeps,
  type ProbeOptions,
  type TcpProbeErr,
  type TcpProbeOk,
  type TlsProbeErr,
  type TlsProbeOk,
} from '../netProbeCore';

// 判定核心的公开面在这里整体转发：调用方（NodeToolAdapter、测试）只需要认
// 一个入口，不必知道判定在 core、拨号在本文件。
export {
  DOH_ENDPOINTS,
  ProbeGuardError,
  PROBE_TIMEOUTS,
  certMatchesHost,
  checkProbeTarget,
  classifyDnsAnswers,
  diagnoseNetwork as diagnoseNetworkWithoutPrimitives,
  fetchHttpProbe,
  httpStepFromClassified,
  isReservedIPv4,
  probeDnsStep,
  renderProbeReport,
  renderProbeReportForHuman,
  skippedStep,
} from '../netProbeCore';
export type {
  CapabilityReport,
  Confidence,
  DnsProbeOutcome,
  HttpProbe,
  NetProbeReport,
  NetVerdict,
  ProbeDeps,
  ProbeOptions,
  ProbeStep,
  ProbeStepResult,
  StepStatus,
  TargetCheck,
  TcpProbeErr,
  TcpProbeOk,
  TlsProbeErr,
  TlsProbeOk,
} from '../netProbeCore';

function nowMs(): number {
  return Date.now();
}

/** 默认 TCP 探测：连完即弃，只为区分「秒回 RST」与「SYN 被静默丢弃」。 */
export async function defaultTcpProbe(host: string, port: number, timeoutMs: number): Promise<TcpProbeOk | TcpProbeErr> {
  const started = nowMs();
  return new Promise<TcpProbeOk | TcpProbeErr>((resolve) => {
    let settled = false;
    let socket: ReturnType<typeof tcpConnect> | null = null;
    const finish = (r: TcpProbeOk | TcpProbeErr): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket?.destroy(); } catch { /* already closed */ }
      resolve(r);
    };
    socket = tcpConnect({ host, port });
    const timer = setTimeout(
      () => finish({ ok: false, ms: nowMs() - started, code: 'ETIMEDOUT', kind: 'timeout' }),
      timeoutMs,
    );
    socket.setTimeout(timeoutMs, () => {
      finish({ ok: false, ms: nowMs() - started, code: 'ETIMEDOUT', kind: 'timeout' });
    });
    socket.once('connect', () => {
      finish({ ok: true, ms: nowMs() - started, localPort: socket?.localPort ?? 0 });
    });
    socket.once('error', (err: NodeJS.ErrnoException) => {
      const code = err.code ?? 'ECONNFAILED';
      const kind = code === 'ECONNREFUSED' ? 'refused'
        : /ENETUNREACH|EHOSTUNREACH|EHOSTDOWN/.test(code) ? 'unreachable'
        : 'other';
      finish({ ok: false, ms: nowMs() - started, code, kind });
    });
  });
}

export async function defaultTlsProbe(host: string, port: number, timeoutMs: number): Promise<TlsProbeOk | TlsProbeErr> {
  const started = nowMs();
  return new Promise<TlsProbeOk | TlsProbeErr>((resolve) => {
    let settled = false;
    let socket: TLSSocket | null = null;
    const finish = (r: TlsProbeOk | TlsProbeErr): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket?.destroy(); } catch { /* already closed */ }
      resolve(r);
    };
    const timer = setTimeout(
      () => finish({ ok: false, ms: nowMs() - started, code: 'ETIMEDOUT', reason: 'TLS 握手超时（SYN 被丢弃或被 RST 后无响应）' }),
      timeoutMs,
    );
    try {
      // servername = 目标域名：缺了它 CDN 会回默认证书，看起来「握手成功」实则
      // 证书与目标无关——那正是「带 SNI 才能判 TLS 通」的全部理由。
      socket = tlsConnect({ host, port, servername: host, rejectUnauthorized: true });
    } catch (err) {
      finish({ ok: false, ms: nowMs() - started, code: 'TLSSETUP', reason: (err as Error).message });
      return;
    }
    socket.once('secureConnect', () => {
      const cert = socket?.getPeerCertificate() ?? {};
      const subject = typeof cert.subject === 'object' ? cert.subject : {};
      const commonName = typeof subject.CN === 'string' ? subject.CN : undefined;
      const san = typeof cert.subjectaltname === 'string' ? cert.subjectaltname : undefined;
      finish({
        ok: true,
        ms: nowMs() - started,
        certMatches: certMatchesHost(san, commonName, host),
        certSubject: commonName ?? san,
        certIssuer: typeof cert.issuer === 'object' && typeof (cert.issuer as { O?: string }).O === 'string'
          ? (cert.issuer as { O?: string }).O
          : undefined,
      });
    });
    socket.once('error', (err: NodeJS.ErrnoException) => {
      const code = err.code ?? 'TLSERROR';
      finish({ ok: false, ms: nowMs() - started, code, reason: `TLS 握手失败（${code}）：${err.message}` });
    });
  });
}

/**
 * CLI 版四步探测 = 核心判定 + 本文件的 node 原语。
 *
 * 注入仍然三态可覆盖（`deps.tcpProbe` 不传 = 用 node 实现，传 null = 明说
 * 「本宿主没有该原语」，传函数 = 打桩）：能力自陈依赖这个区分。
 */
export async function diagnoseNetwork(rawTarget: string, opts: ProbeOptions = {}): Promise<NetProbeReport> {
  const deps: ProbeDeps = {
    ...(opts.deps ?? {}),
    ...('tcpProbe' in (opts.deps ?? {}) ? {} : { tcpProbe: defaultTcpProbe }),
    ...('tlsProbe' in (opts.deps ?? {}) ? {} : { tlsProbe: defaultTlsProbe }),
  };
  return diagnoseNetworkCore(rawTarget, { ...opts, deps });
}