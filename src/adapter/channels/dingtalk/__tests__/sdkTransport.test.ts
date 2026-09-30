import { describe, it, expect } from 'bun:test';
import {
  dingTalkImageRequest,
  postDingTalkOpenApi,
  uploadDingTalkMedia,
} from '../sdkTransport';

function jsonResponse(payload: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as unknown as Response;
}

describe('dingtalk image message routing', () => {
  it('routes a group conversation through groupMessages/send with openConversationId', () => {
    const { url, body } = dingTalkImageRequest('robot_1', 'media_9', {
      conversationType: '2',
      openConversationId: 'cid_group',
      senderStaffId: 'staff_1',
    });
    expect(url).toBe('https://api.dingtalk.com/v1.0/robot/groupMessages/send');
    expect(body.robotCode).toBe('robot_1');
    expect(body.openConversationId).toBe('cid_group');
    expect(body.msgKey).toBe('sampleImageMsg');
    expect(JSON.parse(body.msgParam as string)).toEqual({ photoURL: 'media_9' });
  });

  it('routes a one-to-one conversation through batchSend with the sender staff id', () => {
    const { url, body } = dingTalkImageRequest('robot_1', 'media_9', {
      conversationType: '1',
      openConversationId: 'cid_dm',
      senderStaffId: 'staff_1',
    });
    expect(url).toBe('https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend');
    expect(body.userIds).toEqual(['staff_1']);
    expect(JSON.parse(body.msgParam as string)).toEqual({ photoURL: 'media_9' });
  });
});

describe('uploadDingTalkMedia', () => {
  it('posts the bytes as multipart media and returns the media_id', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({ media_id: 'media_abc' });
    }) as unknown as typeof fetch;

    const mediaId = await uploadDingTalkMedia('tok_1', new Uint8Array([137, 80, 78, 71]), 'diagram-1.png', fetchImpl);

    expect(mediaId).toBe('media_abc');
    expect(calls[0].url).toBe('https://oapi.dingtalk.com/media/upload?access_token=tok_1&type=image');
    expect(calls[0].init?.method).toBe('POST');
    const form = calls[0].init?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect((form.get('media') as File).name).toBe('diagram-1.png');
  });

  it('throws with the platform error message when no media_id comes back', async () => {
    const fetchImpl = (async () => jsonResponse({ errmsg: 'media.type.invalid' }, { ok: false, status: 400 })) as unknown as typeof fetch;
    await expect(uploadDingTalkMedia('tok_1', new Uint8Array([1]), 'x.png', fetchImpl)).rejects.toThrow(/media\.type\.invalid/);
  });
});

describe('postDingTalkOpenApi', () => {
  it('sends the access token header and JSON body', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({ processQueryKey: 'q1' });
    }) as unknown as typeof fetch;

    await postDingTalkOpenApi('tok_1', 'https://api.dingtalk.com/v1.0/robot/groupMessages/send', { a: 1 }, fetchImpl);

    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers['x-acs-dingtalk-access-token']).toBe('tok_1');
    expect(headers['content-type']).toBe('application/json');
    expect(calls[0].init?.body).toBe(JSON.stringify({ a: 1 }));
  });

  it('throws with status and detail on a non-2xx response', async () => {
    const fetchImpl = (async () => jsonResponse({ code: 'robotCode.invalid' }, { ok: false, status: 400 })) as unknown as typeof fetch;
    await expect(postDingTalkOpenApi('tok', 'https://api.dingtalk.com/x', {}, fetchImpl)).rejects.toThrow(/HTTP 400/);
  });
});
