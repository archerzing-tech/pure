// Skill Hub 的 GitHub 加速档（设置 → 通用）：镜像只负责“先试一次”，没命中
// 就退回原来的直连阶梯。这里锁三件事：关闭时零额外请求、开启时先打镜像、
// 镜像回了错误页（200 + HTML）不能当成正文装进技能库。

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { fetchHubIndex, fetchSkillBody, hubIndexUrls } from '../skillHub';

const realFetch = globalThis.fetch;
let calls: string[] = [];

function stubFetch(handler: (url: string) => Response | Promise<Response>): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    return handler(url);
  }) as unknown as typeof fetch;
}

const jsonIndex = (name: string): Response =>
  new Response(JSON.stringify({ skills: [{ name, description: 'd' }] }), { status: 200 });
const htmlErrorPage = (): Response =>
  new Response('<!DOCTYPE html><html><body>mirror error</body></html>', { status: 200 });
const skillMarkdown = (): Response =>
  new Response('---\ndescription: demo\n---\n# Demo\n\nDo the thing.', { status: 200 });

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('Skill Hub · GitHub 加速档', () => {
  it('加速关闭（没有前缀）时只走原来的直连阶梯，一次镜像请求都不发', async () => {
    stubFetch(() => jsonIndex('alpha'));
    const index = await fetchHubIndex('o/r');
    expect(index.skills[0]?.name).toBe('alpha');
    expect(calls).toEqual([hubIndexUrls('o/r')[0]!]);
  });

  it('开启后先打镜像前缀；命中就不必再走直连', async () => {
    stubFetch(() => jsonIndex('beta'));
    const index = await fetchHubIndex('o/r', '', ['https://mirror.example']);
    expect(index.skills[0]?.name).toBe('beta');
    expect(calls[0]).toBe(`https://mirror.example/${hubIndexUrls('o/r')[0]}`);
    expect(calls.every((url) => url.startsWith('https://mirror.example/'))).toBe(true);
  });

  it('镜像回了 200 + HTML 错误页：索引丢弃、正文拒收，退回直连', async () => {
    stubFetch((url) => (url.startsWith('https://mirror.example/') ? htmlErrorPage() : jsonIndex('gamma')));
    const index = await fetchHubIndex('o/r', '', ['https://mirror.example']);
    expect(index.skills[0]?.name).toBe('gamma');
    expect(calls.some((url) => url === hubIndexUrls('o/r')[0])).toBe(true);

    calls = [];
    stubFetch((url) => (url.startsWith('https://mirror.example/') ? htmlErrorPage() : skillMarkdown()));
    const body = await fetchSkillBody('o/r', 'demo', '', ['https://mirror.example']);
    // 错误页不能变成 SKILL.md 正文；直连那份 Markdown 才是结果。
    expect(body).toContain('Do the thing');
    expect(body).not.toContain('<html');
  });

  it('镜像命中正文时直接返回，不再打直连（加速的价值在这里）', async () => {
    stubFetch(() => skillMarkdown());
    const body = await fetchSkillBody('o/r', 'demo', '', ['https://mirror.example']);
    expect(body).toContain('Do the thing');
    expect(calls.every((url) => url.startsWith('https://mirror.example/'))).toBe(true);
  });
});
