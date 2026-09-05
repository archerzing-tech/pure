// src/shared/__tests__/netGuard.test.ts
// Covers the host circuit breaker + failure classification shared by the GUI
// and CLI tool adapters: two consecutive network failures trip a host, the
// blocked window fails instantly with a skip directive, any success clears
// it, and classifyFailure maps real error strings to recovery classes.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import {
  blockedHostMessage,
  blockedHosts,
  classifyFailure,
  hostBlocked,
  hostOf,
  isNetworkError,
  netFailureHint,
  recordNetFailure,
  recordNetSuccess,
} from '../netGuard';

beforeAll(() => {
  GlobalRegistrator.register();
  localStorage.removeItem('pure.netGuard.hosts.v1');
});
afterAll(() => GlobalRegistrator.unregister());

describe('host circuit breaker', () => {
  it('extracts the host from a URL and rejects garbage', () => {
    expect(hostOf('https://cdn.example.com/a/lib.js')).toBe('cdn.example.com');
    expect(hostOf('not a url')).toBeNull();
  });

  it('distinguishes connection-level failures from HTTP status errors', () => {
    expect(isNetworkError('request: error sending request for url (https://nominatim.openstreetmap.org/search)')).toBe(true);
    expect(isNetworkError('Connection reset by peer')).toBe(true);
    expect(isNetworkError('请求超时：operation timed out after 8000ms')).toBe(true);
    // A 404 means the host answered — the resource is the problem, not the network.
    expect(isNetworkError('HTTP 404 not found')).toBe(false);
  });

  it('trips after two consecutive network failures and blocks the host', () => {
    const url = 'https://dead-host.example.com/file.zip';
    expect(hostBlocked(url)).toBe(false);
    const first = recordNetFailure(url);
    expect(first.tripped).toBe(false);
    const second = recordNetFailure(url);
    expect(second.tripped).toBe(true);
    expect(hostBlocked(url)).toBe(true);
    expect(blockedHosts()).toContain('dead-host.example.com');
    // Other hosts are untouched.
    expect(hostBlocked('https://healthy.example.com/x')).toBe(false);
  });

  it('clears the trip on success and fails blocked hosts instantly with guidance', () => {
    const url = 'https://flaky-host.example.com/a';
    recordNetFailure(url);
    recordNetSuccess(url);
    recordNetFailure(url); // consecutive counter restarted — not tripped yet
    expect(hostBlocked(url)).toBe(false);

    recordNetFailure(url);
    recordNetFailure(url);
    expect(hostBlocked(url)).toBe(true);
    const msg = blockedHostMessage(url, 'connection reset');
    expect(msg).toContain('flaky-host.example.com');
    expect(msg).toContain('熔断');
    expect(msg).toContain('connection reset');
    expect(netFailureHint(url, 'timeout')).toContain('请勿原样重试');
  });

  it('persists trip history so a NEW session inherits the planning knowledge', () => {
    const url = 'https://persist-dead.example.com/x';
    recordNetFailure(url);
    recordNetFailure(url); // trip → written to localStorage
    const stored = JSON.parse(localStorage.getItem('pure.netGuard.hosts.v1') ?? '[]') as { host: string }[];
    expect(stored.some(p => p.host === 'persist-dead.example.com')).toBe(true);

    // Simulate a fresh session: the in-memory cooldowns are gone, but the
    // planner brief (blockedHosts) still lists the historically dead host —
    // while hostBlocked (instant-fail) correctly does NOT, because the
    // cooldown may have expired and the host could have recovered.
    localStorage.setItem('pure.netGuard.hosts.v1', JSON.stringify([{ host: 'history-dead.example.com', lastTripAt: Date.now() }]));
    expect(blockedHosts()).toContain('history-dead.example.com');
    expect(hostBlocked('https://history-dead.example.com/a')).toBe(false);

    // Entries older than the 24h retention fall out of the brief.
    localStorage.setItem('pure.netGuard.hosts.v1', JSON.stringify([{ host: 'ancient.example.com', lastTripAt: Date.now() - 25 * 60 * 60_000 }]));
    expect(blockedHosts()).not.toContain('ancient.example.com');
  });
});

describe('classifyFailure', () => {
  it('maps real error strings to recovery classes', () => {
    expect(classifyFailure('request: error sending request for url (https://x)')).toBe('network');
    expect(classifyFailure('operation timed out after 30000ms')).toBe('timeout');
    expect(classifyFailure('HTTP 401 Unauthorized: bad api key')).toBe('auth');
    expect(classifyFailure('permission denied: /etc/hosts')).toBe('permission');
    expect(classifyFailure('HTTP 404 — resource not found')).toBe('not-found');
    expect(classifyFailure('HTTP 429 too many requests')).toBe('rate-limit');
    expect(classifyFailure('Unsupported content type: application/json')).toBe('content');
    expect(classifyFailure('something inexplicable happened')).toBe('generic');
  });
});
