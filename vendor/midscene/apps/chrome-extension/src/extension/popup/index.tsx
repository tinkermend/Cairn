/// <reference types="chrome" />
import {
  ApiOutlined,
  CloudUploadOutlined,
  MenuOutlined,
  SendOutlined,
  VideoCameraOutlined,
} from '@ant-design/icons';
import { runConnectivityTest } from '@midscene/core/ai-model';
import type { PlaygroundSDK } from '@midscene/playground';
import { ModelConfigManager, type TModelConfig } from '@midscene/shared/env';
import {
  type CommonAgentOptions,
  NavActions,
  globalThemeConfig,
  useEnvConfig,
} from '@midscene/visualizer';
import { App as AntdApp, Badge, Button, ConfigProvider, Dropdown, Segmented, Tag, Tooltip, theme } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { BrowserExtensionPlayground } from '../../components/playground';
import { CairnConnectModal } from '../../components/CairnConnectModal';
import { useCairnStore } from '../../store';
import Bridge from '../bridge';
import Recorder from '../recorder';
import './index.less';
import { MIDSCENE_MODEL_API_KEY } from '@midscene/shared/env';
import { safeOverrideAIConfig } from '@midscene/visualizer';
import {
  ChromeExtensionProxyPage,
  ChromeExtensionProxyPageAgent,
} from '@midscene/web/chrome-extension';
// remember to destroy the agent when the tab is destroyed: agent.page.destroy()
const extensionAgentForTab = (
  forceSameTabNavigation = true,
  agentOptions: CommonAgentOptions = {},
) => {
  const page = new ChromeExtensionProxyPage(forceSameTabNavigation);
  return new ChromeExtensionProxyPageAgent(page, agentOptions);
};

const STORAGE_KEY = 'midscene-popup-mode';
const AGENT_OPTIONS_STORAGE_KEY = 'midscene-extension-agent-options';
const EXTENSION_PRIMARY_COLORS = {
  dark: '#2D5290',
  light: '#2B83FF',
} as const;

type ExtensionThemeMode = keyof typeof EXTENSION_PRIMARY_COLORS;

function getPreferredThemeMode(): ExtensionThemeMode {
  if (typeof window.matchMedia !== 'function') {
    return 'light';
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

async function runChromeConnectivityTest(config: Record<string, string>) {
  const modelConfigManager = new ModelConfigManager(config as TModelConfig);
  return runConnectivityTest({
    defaultModelConfig: modelConfigManager.getModelConfig('default'),
    insightModelConfig: modelConfigManager.getModelConfig('insight'),
    planningModelConfig: modelConfigManager.getModelConfig('planning'),
  });
}

function normalizeAgentOptions(value: unknown): CommonAgentOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const source = value as Record<string, unknown>;
  const options: CommonAgentOptions = {};
  if (
    typeof source.replanningCycleLimit === 'number' &&
    Number.isInteger(source.replanningCycleLimit) &&
    source.replanningCycleLimit >= 0
  ) {
    options.replanningCycleLimit = source.replanningCycleLimit;
  }
  if (
    typeof source.waitAfterAction === 'number' &&
    Number.isFinite(source.waitAfterAction) &&
    source.waitAfterAction >= 0
  ) {
    options.waitAfterAction = source.waitAfterAction;
  }
  if (
    typeof source.screenshotShrinkFactor === 'number' &&
    Number.isFinite(source.screenshotShrinkFactor) &&
    source.screenshotShrinkFactor >= 1
  ) {
    options.screenshotShrinkFactor = source.screenshotShrinkFactor;
  }
  return options;
}

function loadAgentOptions(): CommonAgentOptions {
  try {
    return normalizeAgentOptions(
      JSON.parse(localStorage.getItem(AGENT_OPTIONS_STORAGE_KEY) || '{}'),
    );
  } catch {
    return {};
  }
}

export function PlaygroundPopup() {
  const setPopupTab = useEnvConfig((state) => state.setPopupTab);
  const [playgroundSDK, setPlaygroundSDK] = useState<PlaygroundSDK | null>(
    null,
  );
  const [agentOptions, setAgentOptions] =
    useState<CommonAgentOptions>(loadAgentOptions);
  const [themeMode, setThemeMode] = useState<ExtensionThemeMode>(
    getPreferredThemeMode,
  );
  const [currentMode, setCurrentMode] = useState<
    'playground' | 'bridge' | 'recorder'
  >(() => {
    const savedMode = localStorage.getItem(STORAGE_KEY);
    return (savedMode as 'playground' | 'bridge' | 'recorder') || 'playground';
  });

  const [isCairnModalOpen, setIsCairnModalOpen] = useState(false);
  const cairnAccount = useCairnStore((state) => state.account);
  const cairnToken = useCairnStore((state) => state.token);
  const cairnTargetId = useCairnStore((state) => state.targetId);
  const cairnTargets = useCairnStore((state) => state.targets);

  const cairnBinding = useCairnStore((state) => state.binding);
  const currentTarget = cairnTargets.find((t) => t.id === cairnTargetId);

  // 初始化识途平台 Store
  useEffect(() => {
    void useCairnStore.getState().initialize();
  }, []);

  // The extension has no user-selectable theme yet, so follow the system
  // preference for both Ant Design portals and shared visualizer styles.
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') {
      document.documentElement.dataset.theme = 'light';
      return;
    }

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const syncTheme = () => {
      const nextThemeMode = mediaQuery.matches ? 'dark' : 'light';
      document.documentElement.dataset.theme = nextThemeMode;
      setThemeMode(nextThemeMode);
    };

    syncTheme();
    mediaQuery.addEventListener('change', syncTheme);
    return () => mediaQuery.removeEventListener('change', syncTheme);
  }, []);

  const antdThemeConfig = useMemo(() => {
    const baseTheme = globalThemeConfig();
    return {
      ...baseTheme,
      algorithm:
        themeMode === 'dark' ? theme.darkAlgorithm : theme.defaultAlgorithm,
      token: {
        ...baseTheme.token,
        colorPrimary: EXTENSION_PRIMARY_COLORS[themeMode],
      },
    };
  }, [themeMode]);

  const config = useEnvConfig((state) => state.config);

  const getAgent = useCallback(
    (forceSameTabNavigation?: boolean) =>
      extensionAgentForTab(forceSameTabNavigation, agentOptions),
    [agentOptions],
  );

  const handleAgentOptionsSave = useCallback((options: CommonAgentOptions) => {
    localStorage.setItem(AGENT_OPTIONS_STORAGE_KEY, JSON.stringify(options));
    setAgentOptions(options);
  }, []);

  // Sync popupTab with saved mode on mount
  useEffect(() => {
    setPopupTab(currentMode);
  }, []);

  // Override AI configuration
  useEffect(() => {
    console.log('Chrome Extension - Overriding AI config:', config);
    console.log('MIDSCENE_MODEL_API_KEY exists:', !!MIDSCENE_MODEL_API_KEY);

    if (config && Object.keys(config).length >= 1) {
      safeOverrideAIConfig(config);
    }
  }, [config]);

  const menuItems = [
    {
      key: 'playground',
      icon: <SendOutlined />,
      label: 'Playground',
      onClick: () => {
        setCurrentMode('playground');
        setPopupTab('playground');
        localStorage.setItem(STORAGE_KEY, 'playground');
      },
    },
    {
      key: 'recorder',
      label: 'Recorder (Preview)',
      icon: <VideoCameraOutlined />,
      onClick: () => {
        setCurrentMode('recorder');
        setPopupTab('recorder');
        localStorage.setItem(STORAGE_KEY, 'recorder');
      },
    },
    {
      key: 'bridge',
      icon: <ApiOutlined />,
      label: 'Bridge Mode',
      onClick: () => {
        setCurrentMode('bridge');
        setPopupTab('bridge');
        localStorage.setItem(STORAGE_KEY, 'bridge');
      },
    },
    {
      type: 'divider' as const,
    },
    {
      key: 'cairn-platform',
      icon: <CloudUploadOutlined style={{ color: cairnToken ? '#52c41a' : undefined }} />,
      label: cairnAccount ? `识途平台 (${cairnAccount.displayName || cairnAccount.email})` : '连接识途平台...',
      onClick: () => {
        setIsCairnModalOpen(true);
      },
    },
  ];

  const renderContent = () => {
    if (currentMode === 'bridge') {
      return (
        <div className="popup-content bridge-mode">
          <div className="bridge-container">
            <Bridge />
          </div>
        </div>
      );
    }
    if (currentMode === 'recorder') {
      return (
        <div className="popup-content recorder-mode">
          <Recorder />
        </div>
      );
    }

    // Check if configuration is ready
    const configReady = config && Object.keys(config).length >= 1;
    console.log('Playground mode - config:', {
      config,
      configReady,
    });

    return (
      <div className="popup-content">
        {/* Playground Component */}
        <div className="playground-component">
          <BrowserExtensionPlayground
            agentOptions={agentOptions}
            getAgent={getAgent}
            onAgentOptionsSave={handleAgentOptionsSave}
            showContextPreview={false}
            onPlaygroundSDKChange={setPlaygroundSDK}
            onVerify={runChromeConnectivityTest}
          />
        </div>
      </div>
    );
  };

  return (
    <ConfigProvider theme={antdThemeConfig}>
      <AntdApp component={false}>
        <div className="popup-wrapper">
          {/* top navigation bar */}
          <div className="popup-nav">
            <div className="nav-left" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Dropdown
                menu={{ items: menuItems }}
                trigger={['click']}
                placement="bottomLeft"
                overlayClassName="mode-selector-dropdown"
              >
                <MenuOutlined className="nav-icon menu-trigger" />
              </Dropdown>
              <Segmented
                size="small"
                value={currentMode}
                onChange={(val) => {
                  const mode = val as 'playground' | 'recorder' | 'bridge';
                  setCurrentMode(mode);
                  setPopupTab(mode);
                  localStorage.setItem(STORAGE_KEY, mode);
                }}
                options={[
                  { label: 'Playground', value: 'playground', icon: <SendOutlined /> },
                  { label: '录制器', value: 'recorder', icon: <VideoCameraOutlined /> },
                ]}
                style={{ fontSize: 11 }}
              />
            </div>
            <div className="nav-right" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <NavActions
                showTooltipWhenEmpty={false}
                showModelName={false}
                playgroundSDK={playgroundSDK}
                onVerify={runChromeConnectivityTest}
                agentOptions={agentOptions}
                configModalClassName="chrome-extension-model-env-config-modal"
                configModalWidth={360}
                envTextareaAutoSize={false}
                envTextareaMinRows={4}
                onAgentOptionsSave={handleAgentOptionsSave}
              />
            </div>
          </div>

          {/* 常驻识途平台协同横幅 (Cairn Status Bar) */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '5px 12px',
              backgroundColor: cairnToken ? '#f6f8fb' : '#fffbe6',
              borderBottom: cairnToken ? '1px solid #eaedf1' : '1px solid #ffe58f',
              fontSize: 12,
              lineHeight: '1.4',
            }}
          >
            {cairnToken && cairnAccount ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
                <Badge status="success" />
                <span style={{ color: '#666', flexShrink: 0 }}>识途:</span>
                <span
                  style={{
                    fontWeight: 600,
                    color: '#1f2329',
                    maxWidth: 70,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={cairnAccount.displayName || cairnAccount.email}
                >
                  {cairnAccount.displayName || cairnAccount.email}
                </span>
                <span style={{ color: '#d9d9d9' }}>|</span>
                <span style={{ color: '#666', flexShrink: 0 }}>目标:</span>
                <Tag
                  color={currentTarget ? 'blue' : 'default'}
                  style={{
                    cursor: 'pointer',
                    margin: 0,
                    maxWidth: 100,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontSize: 11,
                    lineHeight: '18px',
                    height: 20,
                  }}
                  onClick={() => setIsCairnModalOpen(true)}
                  title={currentTarget ? currentTarget.name : '点击选择目标系统'}
                >
                  {currentTarget ? currentTarget.name : '未选Target'}
                </Tag>
                {cairnBinding && (
                  <Tag color="orange" style={{ margin: 0, fontSize: 10, lineHeight: '18px', height: 20 }}>
                    协同中
                  </Tag>
                )}
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
                <Badge status="warning" />
                <span
                  style={{
                    color: '#d48806',
                    fontSize: 11,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  识途未连接 · 登录后打通目标系统与草稿
                </span>
              </div>
            )}

            <Button
              size="small"
              type={cairnToken ? 'link' : 'primary'}
              onClick={() => setIsCairnModalOpen(true)}
              style={{
                fontSize: 11,
                height: 22,
                padding: cairnToken ? '0 4px' : '0 8px',
                backgroundColor: cairnToken ? undefined : '#2B83FF',
                flexShrink: 0,
                marginLeft: 4,
              }}
            >
              {cairnToken ? '设置' : '登录识途'}
            </Button>
          </div>

          {/* main content area */}
          {renderContent()}

          {/* Cairn platform connect modal */}
          <CairnConnectModal
            open={isCairnModalOpen}
            onClose={() => setIsCairnModalOpen(false)}
          />
        </div>
      </AntdApp>
    </ConfigProvider>
  );
}
