import { describe, expect, it, vi } from 'vitest';
import { onRequest } from '../../functions/index.js';

describe('Pages VoiceDrop homepage routing', () => {
  it('opens the VoiceDrop homepage on the configured public host', async () => {
    const response = await onRequest({
      request: new Request('https://test.example.com/?source=android'),
      env: { VOICEDROP_PUBLIC_HOST: 'test.example.com' },
      next: vi.fn(),
    });
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('https://test.example.com/voicedrop/?source=android');
  });
  it('preserves the default website on unrelated hosts', async () => {
    const original = new Response('default website');
    const next = vi.fn(async () => original);
    expect(await onRequest({ request: new Request('https://jianshuo.dev/'),
      env: { VOICEDROP_PUBLIC_HOST: 'test.example.com' }, next })).toBe(original);
  });
  it('keeps the production VoiceDrop redirect without optional configuration', async () => {
    const response = await onRequest({ request: new Request('https://voicedrop.cn/'), next: vi.fn() });
    expect(response.headers.get('Location')).toBe('https://voicedrop.cn/voicedrop/');
  });
  it('supports the existing EdgeOne forwarded host', async () => {
    const response = await onRequest({ request: new Request('https://upstream.pages.dev/', {
      headers: { 'X-Forwarded-Host': 'www.voicedrop.cn' },
    }), next: vi.fn() });
    expect(response.headers.get('Location')).toBe('https://www.voicedrop.cn/voicedrop/');
  });
});
