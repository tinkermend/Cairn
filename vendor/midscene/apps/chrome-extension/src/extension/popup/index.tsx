/// <reference types="chrome" />
import { CheckCircleFilled, CloudUploadOutlined, SettingOutlined } from '@ant-design/icons';
import { App as AntdApp, Button, ConfigProvider, theme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { useEffect, useState } from 'react';
import { CairnConnectModal } from '../../components/CairnConnectModal';
import { useCairnStore } from '../../store';
import Recorder from '../recorder';
import './index.less';

const cairnTheme = {
  algorithm: theme.defaultAlgorithm,
  token: {
    colorPrimary: '#245ce5',
    colorText: '#18253d',
    colorTextSecondary: '#40516d',
    colorBorder: '#dfe6f0',
    borderRadius: 9,
    fontFamily:
      'Inter, -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
  },
};

export function CairnRecorderPopup() {
  const [isCairnModalOpen, setIsCairnModalOpen] = useState(false);
  const account = useCairnStore((state) => state.account);
  const token = useCairnStore((state) => state.token);
  const authStatus = useCairnStore((state) => state.authStatus);
  const authError = useCairnStore((state) => state.error);
  const targetId = useCairnStore((state) => state.targetId);
  const targets = useCairnStore((state) => state.targets);
  const binding = useCairnStore((state) => state.binding);
  const authenticated = authStatus === 'authenticated' && !!token && !!account;
  const currentTarget = targets.find((target) => target.id === targetId);

  useEffect(() => {
    document.documentElement.dataset.theme = 'light';
    document.documentElement.lang = 'zh-CN';
    void useCairnStore.getState().initialize();
  }, []);

  return (
    <ConfigProvider locale={zhCN} theme={cairnTheme}>
      <AntdApp component={false}>
        <div className="popup-wrapper">
          <header className="cairn-recorder-header">
            <div className="cairn-recorder-brand">
              <img src="/logo-cairn.svg" alt="识途" className="cairn-recorder-logo" />
              <span>识途协同录制</span>
            </div>
            {authenticated && (
              <Button
                type="text"
                icon={<SettingOutlined />}
                aria-label="平台连接设置"
                title="平台连接设置"
                onClick={() => setIsCairnModalOpen(true)}
              />
            )}
          </header>

          {authenticated ? (
            <>
              <div className="cairn-recorder-context">
                <div className="cairn-recorder-account" title={account.displayName || account.email || undefined}>
                  <CheckCircleFilled aria-hidden="true" />
                  <span>{account.displayName || account.email}</span>
                </div>
                <span className="cairn-recorder-context-divider" aria-hidden="true" />
                <button
                  type="button"
                  className="cairn-recorder-target"
                  onClick={() => setIsCairnModalOpen(true)}
                  title="选择录制的目标系统"
                >
                  {currentTarget ? currentTarget.name : '选择目标系统'}
                </button>
                {binding && <span className="cairn-recorder-binding">协同中</span>}
              </div>
              <main className="popup-content recorder-mode">
                <Recorder />
              </main>
            </>
          ) : (
            <main className="cairn-login-gate" aria-live="polite">
              <div className="cairn-login-gate-card">
                <img src="/logo-cairn.svg" alt="" className="cairn-login-gate-logo" />
                <h1>登录识途后开始录制</h1>
                <p>连接平台账号，选择目标系统，即可录制并上传场景草稿。</p>
                {authStatus === 'checking' ? (
                  <span className="cairn-login-gate-note">正在验证登录状态…</span>
                ) : (
                  <>
                    {authStatus === 'error' && (
                      <p role="alert" className="cairn-login-gate-error">
                        {authError || '无法验证登录状态，请重试'}
                      </p>
                    )}
                    <Button
                      type="primary"
                      icon={<CloudUploadOutlined />}
                      onClick={() => setIsCairnModalOpen(true)}
                    >
                      登录识途
                    </Button>
                  </>
                )}
              </div>
            </main>
          )}

          <CairnConnectModal
            open={authStatus !== 'checking' && (!authenticated || isCairnModalOpen)}
            onClose={() => setIsCairnModalOpen(false)}
          />
        </div>
      </AntdApp>
    </ConfigProvider>
  );
}
