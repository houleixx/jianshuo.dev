import { afterEach, describe, expect, it, vi } from 'vitest';
import gateway from '../../infra/voicedrop-gateway/index.mjs';

const origin = 'https://gateway.example.test';
function environment() {
  return {
    AGENT: { fetch: vi.fn(async () => new Response('agent')) },
    RECO: { fetch: vi.fn(async () => new Response('reco')) },
    PAGES_ORIGIN: 'https://pages.example.test',
  };
}
afterEach(() => vi.unstubAllGlobals());

describe('unified VoiceDrop gateway', () => {
  it.each([
    ['/agent', 'AGENT'], ['/agent/wechat-pay/status?x=1', 'AGENT'],
    ['/reco', 'RECO'], ['/reco/feed?limit=2', 'RECO'],
  ])('routes %s through its service binding', async (path, binding) => {
    const env = environment();
    const request = new Request(origin + path);
    const external = vi.fn();
    vi.stubGlobal('fetch', external);
    await gateway.fetch(request, env);
    expect(env[binding].fetch).toHaveBeenCalledWith(request);
    expect(external).not.toHaveBeenCalled();
  });

  it('preserves the exact payment callback body and authentication headers', async () => {
    const env = environment();
    const xml = '<xml><sign><![CDATA[test-sign]]></sign>\n<note>a+b%2F</note></xml>';
    const request = new Request(origin + '/agent/wechat-pay/contract-notify?a=%2F', {
      method: 'POST', body: xml,
      headers: { 'Content-Type': 'text/xml', Authorization: 'Bearer fake-test-token' },
    });
    await gateway.fetch(request, env);
    const received = env.AGENT.fetch.mock.calls[0][0];
    expect(received.url).toBe(request.url);
    expect(received.method).toBe('POST');
    expect(received.headers.get('Authorization')).toBe('Bearer fake-test-token');
    expect(await received.text()).toBe(xml);
  });

  it('passes a WebSocket upgrade response through without reconstruction', async () => {
    const env = environment();
    const upgrade = { status: 101, webSocket: {} };
    env.AGENT.fetch.mockResolvedValue(upgrade);
    const request = new Request(origin + '/agent/status', { headers: { Upgrade: 'websocket' } });
    expect(await gateway.fetch(request, env)).toBe(upgrade);
    expect(env.AGENT.fetch).toHaveBeenCalledWith(request);
  });

  it.each(['/files/api/list?limit=2', '/agent-other', '/recovery', '/voicedrop/help/'])
  ('sends %s to Pages without changing its path or query', async (path) => {
    const env = environment();
    const external = vi.fn(async () => new Response('pages'));
    vi.stubGlobal('fetch', external);
    await gateway.fetch(new Request(origin + path), env);
    expect(external.mock.calls[0][0].url).toBe(env.PAGES_ORIGIN + path);
    expect(env.AGENT.fetch).not.toHaveBeenCalled();
    expect(env.RECO.fetch).not.toHaveBeenCalled();
  });

  it('streams Files uploads and preserves query, headers and response status', async () => {
    const env = environment();
    const payload = new Uint8Array([0, 1, 128, 255]);
    const response = new Response('failure', { status: 401, headers: { 'Cache-Control': 'no-store' } });
    const external = vi.fn(async () => response);
    vi.stubGlobal('fetch', external);
    const request = new Request(origin + '/files/api/upload?key=a%2Fb', {
      method: 'POST', body: payload,
      headers: { Authorization: 'Bearer fake-test-token', 'Content-Type': 'application/octet-stream',
        'X-Forwarded-Host': 'untrusted.example.test' },
    });
    expect(await gateway.fetch(request, env)).toBe(response);
    const [upstream, options] = external.mock.calls[0];
    expect(upstream.url).toBe(env.PAGES_ORIGIN + '/files/api/upload?key=a%2Fb');
    expect(upstream.method).toBe('POST');
    expect(upstream.headers.get('Authorization')).toBe('Bearer fake-test-token');
    expect(upstream.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(upstream.headers.get('X-Forwarded-Host')).toBe('gateway.example.test');
    expect(new Uint8Array(await upstream.arrayBuffer())).toEqual(payload);
    expect(options.redirect).toBe('manual');
  });

  it('keeps Pages redirects on the gateway without following them', async () => {
    const external = vi.fn(async () => new Response(null, { status: 308, headers: {
      Location: 'https://pages.example.test/voicedrop/help/?a=%2F',
      'Cache-Control': 'no-store', 'Set-Cookie': 'test=1; Secure; HttpOnly',
    } }));
    vi.stubGlobal('fetch', external);
    const response = await gateway.fetch(new Request(origin + '/voicedrop/help'), environment());
    expect(response.status).toBe(308);
    expect(response.headers.get('Location')).toBe(origin + '/voicedrop/help/?a=%2F');
    expect(response.headers.get('Set-Cookie')).toBe('test=1; Secure; HttpOnly');
    expect(external).toHaveBeenCalledTimes(1);
  });

  it('returns external redirects as-is instead of forwarding credentials', async () => {
    const response = new Response(null, { status: 302, headers: { Location: 'https://auth.example.test/' } });
    const external = vi.fn(async () => response);
    vi.stubGlobal('fetch', external);
    expect(await gateway.fetch(new Request(origin + '/files/api/login'), environment())).toBe(response);
    expect(external).toHaveBeenCalledTimes(1);
  });

  it('keeps protocol-relative request paths on the configured Pages origin', async () => {
    const external = vi.fn(async () => new Response('pages'));
    vi.stubGlobal('fetch', external);
    await gateway.fetch(new Request(origin + '//untrusted.example.test/path'), environment());
    expect(new URL(external.mock.calls[0][0].url).origin).toBe('https://pages.example.test');
  });

  it('opens the VoiceDrop test website from the root', async () => {
    const response = await gateway.fetch(new Request(origin + '/?source=test'), environment());
    expect(response.headers.get('Location')).toBe(origin + '/voicedrop/?source=test');
  });
});
