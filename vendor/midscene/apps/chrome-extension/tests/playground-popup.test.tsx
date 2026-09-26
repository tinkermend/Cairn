/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, rs } from '@rstest/core';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useCairnStore } from '../src/store';

const configProviderThemes: Array<unknown> = [];

rs.mock('antd', () => ({
  App: ({ children }: { children: React.ReactNode }) => children,
  ConfigProvider: ({
    children,
    theme,
  }: {
    children: React.ReactNode;
    theme?: unknown;
  }) => {
    configProviderThemes.push(theme);
    return children;
  },
  Button: ({
    children,
    onClick,
    'aria-label': ariaLabel,
  }: {
    children?: React.ReactNode;
    onClick?: () => void;
    'aria-label'?: string;
  }) => (
    <button type="button" onClick={onClick} aria-label={ariaLabel}>
      {children}
    </button>
  ),
  theme: {
    darkAlgorithm: 'dark-algorithm',
    defaultAlgorithm: 'default-algorithm',
  },
}));

rs.mock('../src/components/CairnConnectModal', () => ({
  CairnConnectModal: ({ open }: { open: boolean }) =>
    open ? <div>识途登录窗口已打开</div> : null,
}));

rs.mock('../src/extension/recorder', () => ({
  default: () => <div>录制器内容</div>,
}));

describe('CairnRecorderPopup', () => {
  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    configProviderThemes.length = 0;
    useCairnStore.setState({
      authStatus: 'authenticated',
      token: 'test-token',
      account: {
        id: 'author-1',
        email: 'author@example.test',
        displayName: '编写者',
        roles: [],
      },
      targetId: null,
      targets: [],
      binding: null,
      initialize: async () => {},
    });
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: rs.fn(() => ({
        matches: true,
        media: '(prefers-color-scheme: dark)',
        addEventListener: rs.fn(),
        removeEventListener: rs.fn(),
      })),
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
    document.documentElement.removeAttribute('data-theme');
  });

  it('keeps the recorder light and Chinese even when the system prefers dark', async () => {
    const { CairnRecorderPopup } = await import('../src/extension/popup');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<CairnRecorderPopup />);
    });

    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.lang).toBe('zh-CN');
    expect(configProviderThemes.at(-1)).toEqual(
      expect.objectContaining({
        algorithm: 'default-algorithm',
        token: expect.objectContaining({ colorPrimary: '#245ce5' }),
      }),
    );
    expect(container.textContent).toContain('识途协同录制');
    expect(container.textContent).toContain('录制器内容');
    expect(container.textContent).not.toContain('Playground');
    expect(container.textContent).not.toContain('Midscene');
    expect(container.textContent).not.toContain('GitHub');

    await act(async () => root.unmount());
  });

  it('requires a platform login before rendering the recorder', async () => {
    useCairnStore.setState({
      authStatus: 'unauthenticated',
      token: null,
      account: null,
    });
    const { CairnRecorderPopup } = await import('../src/extension/popup');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<CairnRecorderPopup />);
    });

    expect(container.textContent).toContain('登录识途后开始录制');
    expect(container.textContent).toContain('识途登录窗口已打开');
    expect(container.textContent).not.toContain('录制器内容');

    await act(async () => root.unmount());
  });

  it('opens platform settings from the target selector', async () => {
    const { CairnRecorderPopup } = await import('../src/extension/popup');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<CairnRecorderPopup />);
    });
    expect(container.textContent).not.toContain('识途登录窗口已打开');

    await act(async () => {
      container.querySelector<HTMLButtonElement>('.cairn-recorder-target')?.click();
    });
    expect(container.textContent).toContain('识途登录窗口已打开');

    await act(async () => root.unmount());
  });
});
