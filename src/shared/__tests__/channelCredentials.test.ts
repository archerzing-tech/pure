// src/shared/__tests__/channelCredentials.test.ts
// 粘贴解析（一键开通与 configure_channel 的共享地基）+ 平台探活的三族结果。
// 探活用注入 fetchImpl：fetchStub 对未知 URL 抛错自愈（跨文件 mock 污染判例）。
import { describe, it, expect } from 'bun:test';
import { parseCredentialPaste, verifyChannelCredentials } from '../channelCredentials';

describe('parseCredentialPaste', () => {
  it('识别 key:value 两行（中英文冒号、等号）', () => {
    expect(parseCredentialPaste('AppID: 1903065122\nAppSecret: abc123XYZ', 'qq')).toEqual({
      primary: '1903065122',
      secondary: 'abc123XYZ',
    });
    expect(parseCredentialPaste('app_id = cli_a1b2c3\napp_secret = s3cr3t', 'feishu')).toEqual({
      primary: 'cli_a1b2c3',
      secondary: 's3cr3t',
    });
    expect(parseCredentialPaste('ClientID：ding888\nClientSecret：dingSecret99', 'dingtalk')).toEqual({
      primary: 'ding888',
      secondary: 'dingSecret99',
    });
  });

  it('识别 JSON 形态（含 ```json 围栏）', () => {
    expect(parseCredentialPaste('{"appId":"1903065122","appSecret":"sec99"}', 'qq')).toEqual({
      primary: '1903065122',
      secondary: 'sec99',
    });
    expect(parseCredentialPaste('复制如下：\n```json\n{"AppID": "123456789", "AppSecret": "zzz"}\n```', 'qq')).toEqual({
      primary: '123456789',
      secondary: 'zzz',
    });
    // 钉钉的别名表（appKey/appSecret）
    expect(parseCredentialPaste('{"appKey":"ding888","appSecret":"s9"}', 'dingtalk')).toEqual({
      primary: 'ding888',
      secondary: 's9',
    });
  });

  it('识别裸两值（纯数字 id / 带前缀 id 自动归位）', () => {
    expect(parseCredentialPaste('1903065122\nabc123XYZsecret', 'qq')).toEqual({
      primary: '1903065122',
      secondary: 'abc123XYZsecret',
    });
    expect(parseCredentialPaste('cli_a1b2c3d4 s3cr3txyz', 'feishu')).toEqual({
      primary: 'cli_a1b2c3d4',
      secondary: 's3cr3txyz',
    });
  });

  it('裸两值都看不出形状时按粘贴顺序', () => {
    expect(parseCredentialPaste('firstvalue12 secondvalue34', 'qq')).toEqual({
      primary: 'firstvalue12',
      secondary: 'secondvalue34',
    });
  });

  it('只有一半凭据时返回那一半，不整体失败', () => {
    expect(parseCredentialPaste('AppID: 1903065122', 'qq')).toEqual({ primary: '1903065122' });
    expect(parseCredentialPaste('AppSecret: onlysecret', 'qq')).toEqual({ secondary: 'onlysecret' });
  });

  it('空文本与无凭据文本返回 null', () => {
    expect(parseCredentialPaste('', 'qq')).toBeNull();
    expect(parseCredentialPaste('   \n  ', 'qq')).toBeNull();
    expect(parseCredentialPaste('今天天气不错', 'qq')).toBeNull();
  });

  it('JSON 里混入无关字段不影响提取', () => {
    expect(parseCredentialPaste('{"name":"mybot","appId":"1903065122","note":"x","appSecret":"sec9"}', 'qq')).toEqual({
      primary: '1903065122',
      secondary: 'sec9',
    });
  });
});

// fetch 桩：只认构造时登记的 URL，未知 URL 抛错（假 invoke 自愈判例）。
function fetchStub(routes: Map<string, (body: unknown) => { status: number; text: string }>) {
  return (async (url: string, init?: { body?: string }) => {
    const route = routes.get(url);
    if (!route) throw new Error(`fetchStub: no route for ${url}`);
    const out = route(JSON.parse(init?.body ?? '{}'));
    return new Response(out.text, { status: out.status });
  }) as typeof fetch;
}

describe('verifyChannelCredentials', () => {
  const QQ_URL = 'https://bots.qq.com/app/getAppAccessToken';
  const FEISHU_URL = 'https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal';
  const DING_URL = 'https://api.dingtalk.com/v1.0/oauth2/accessToken';

  it('QQ：access_token 在 = 有效', async () => {
    const routes = new Map([[QQ_URL, () => ({ status: 200, text: '{"access_token":"tok","expires_in":"7200"}' })]]);
    expect(await verifyChannelCredentials('qq', '123', 'sec', fetchStub(routes))).toEqual({ ok: true });
  });

  it('QQ：HTTP 200 包错误 = rejected 且带平台原话', async () => {
    const routes = new Map([[QQ_URL, () => ({ status: 200, text: '{"code":111,"message":"invalid appid"}' })]]);
    const out = await verifyChannelCredentials('qq', '123', 'sec', fetchStub(routes));
    expect(out).toEqual({ ok: false, kind: 'rejected', detail: 'invalid appid' });
  });

  it('飞书：code=0 且 app_access_token 在 = 有效', async () => {
    const routes = new Map([[FEISHU_URL, () => ({ status: 200, text: '{"code":0,"app_access_token":"t"}' })]]);
    expect(await verifyChannelCredentials('feishu', 'cli_x', 's', fetchStub(routes))).toEqual({ ok: true });
    const bad = new Map([[FEISHU_URL, () => ({ status: 200, text: '{"code":10003,"msg":"invalid app_id"}' })]]);
    const out = await verifyChannelCredentials('feishu', 'cli_x', 's', fetchStub(bad));
    expect(out.ok).toBe(false);
    if (!out.ok && out.kind === 'rejected') expect(out.detail).toContain('10003');
  });

  it('钉钉：accessToken 在 = 有效', async () => {
    const routes = new Map([[DING_URL, () => ({ status: 200, text: '{"accessToken":"t","expireIn":7200}' })]]);
    expect(await verifyChannelCredentials('dingtalk', 'k', 's', fetchStub(routes))).toEqual({ ok: true });
  });

  it('网络失败 = network 族（与凭据被拒分开）', async () => {
    const fail = (async () => { throw new Error('connect ECONNREFUSED'); }) as unknown as typeof fetch;
    const out = await verifyChannelCredentials('qq', '1', '2', fail);
    expect(out).toEqual({ ok: false, kind: 'network', detail: 'connect ECONNREFUSED' });
  });

  it('非 2xx 状态按 rejected 报并带状态码', async () => {
    const routes = new Map([[QQ_URL, () => ({ status: 502, text: 'bad gateway' })]]);
    const out = await verifyChannelCredentials('qq', '1', '2', fetchStub(routes));
    expect(out.ok).toBe(false);
    if (!out.ok && out.kind === 'rejected') expect(out.detail).toContain('HTTP 502');
  });
});
