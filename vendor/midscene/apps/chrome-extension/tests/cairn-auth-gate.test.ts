// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, rs } from '@rstest/core';
import { useCairnStore } from '../src/store';
import { loginToCairn } from '../src/utils/cairn';
import { CAIRN_ENVIRONMENTS } from '../src/utils/cairn-environments';

const account = {
  id: 'user-1',
  email: 'author@example.test',
  displayName: '编写者',
  roles: [{ id: 'role-author', key: 'author', name: '编写者', kind: 'custom' }],
};

describe('识途扩展登录门禁', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    localStorage.clear();
    useCairnStore.setState({
      token: null,
      account: null,
      authStatus: 'checking',
      targets: [],
      error: null,
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('没有保存的登录信息时保持未登录', async () => {
    globalThis.fetch = rs.fn();
    await useCairnStore.getState().initialize();
    expect(useCairnStore.getState().authStatus).toBe('unauthenticated');
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(useCairnStore.getState().apiOrigin).toBe('http://localhost:5173');
  });

  it('平台账号 admin 使用与 Web 控制台相同的登录接口', async () => {
    globalThis.fetch = rs.fn(async () => new Response(JSON.stringify({
      accessToken: 'signed-token',
      account,
    }), { status: 200 })) as typeof fetch;

    await loginToCairn(CAIRN_ENVIRONMENTS.development.origin, 'admin', 'test-password');

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://localhost:5173/api/auth/login',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ email: 'admin', password: 'test-password' }),
      }),
    );
    expect(CAIRN_ENVIRONMENTS.testing.origin).toBeNull();
    expect(CAIRN_ENVIRONMENTS.production.origin).toBeNull();
  });

  it('旧版开发端口的会话改走 Web 代理，不明地址的 Token 不跨环境复用', async () => {
    localStorage.setItem('cairn-api-origin', 'http://localhost:3030');
    localStorage.setItem('cairn-auth-token', 'saved-token');
    globalThis.fetch = rs.fn(async () => new Response(JSON.stringify({ account }), { status: 200 })) as typeof fetch;
    await useCairnStore.getState().initialize();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://localhost:5173/api/me',
      expect.any(Object),
    );

    localStorage.setItem('cairn-api-origin', 'https://unrecognized.example');
    localStorage.setItem('cairn-auth-token', 'other-token');
    globalThis.fetch = rs.fn();
    await useCairnStore.getState().initialize();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(useCairnStore.getState().token).toBeNull();
  });

  it('只在 /api/me 验证成功后放行', async () => {
    localStorage.setItem('cairn-auth-token', 'saved-token');
    let resolveMe!: (value: Response) => void;
    const meResponse = new Promise<Response>((resolve) => { resolveMe = resolve; });
    globalThis.fetch = rs.fn((url: string | URL | Request) => {
      if (String(url).endsWith('/api/me')) {
        return meResponse;
      }
      return Promise.resolve(new Response(JSON.stringify({ items: [], binding: null }), { status: 200 }));
    }) as typeof fetch;

    const initializing = useCairnStore.getState().initialize();
    await Promise.resolve();
    expect(useCairnStore.getState().authStatus).toBe('checking');
    expect(useCairnStore.getState().token).toBeNull();

    resolveMe(new Response(JSON.stringify({ account }), { status: 200 }));
    await initializing;
    expect(useCairnStore.getState().authStatus).toBe('authenticated');
    expect(useCairnStore.getState().account).toEqual(account);
  });

  it('过期 Token 清除登录，网络错误阻止放行并允许重试', async () => {
    localStorage.setItem('cairn-auth-token', 'expired-token');
    globalThis.fetch = rs.fn(async () => new Response(JSON.stringify({ message: 'expired' }), { status: 401 })) as typeof fetch;
    await useCairnStore.getState().initialize();
    expect(useCairnStore.getState().authStatus).toBe('unauthenticated');
    expect(localStorage.getItem('cairn-auth-token')).toBeNull();

    localStorage.setItem('cairn-auth-token', 'saved-token');
    globalThis.fetch = rs.fn(async () => { throw new Error('offline'); }) as typeof fetch;
    await useCairnStore.getState().initialize();
    expect(useCairnStore.getState().authStatus).toBe('error');
    expect(useCairnStore.getState().token).toBeNull();
    expect(localStorage.getItem('cairn-auth-token')).toBe('saved-token');
  });
});
