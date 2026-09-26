/// <reference types="chrome" />
import { App as AntdApp, Button, Checkbox, ConfigProvider, theme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { workerMessageTypes } from '../../utils/workerMessageTypes';
import './index.less';

const CONFIRM_TIMEOUT = 30000; // 30 seconds

function ConfirmDialog() {
  const [rememberChoice, setRememberChoice] = useState(false);
  const [countdown, setCountdown] = useState(
    Math.floor(CONFIRM_TIMEOUT / 1000),
  );
  const [serverUrl, setServerUrl] = useState<string>('');

  useEffect(() => {
    // Get server URL from URL params
    const params = new URLSearchParams(window.location.search);
    const url = params.get('serverUrl') || 'ws://127.0.0.1:3766';
    setServerUrl(url);

    // Start countdown timer
    const timer = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          // Auto-deny on timeout
          handleDeny();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, []);

  const handleAllow = () => {
    chrome.runtime.sendMessage(
      {
        type: workerMessageTypes.BRIDGE_CONFIRM_RESPONSE,
        payload: {
          allowed: true,
          alwaysAllow: rememberChoice,
        },
      },
      () => {
        window.close();
      },
    );
  };

  const handleDeny = () => {
    chrome.runtime.sendMessage(
      {
        type: workerMessageTypes.BRIDGE_CONFIRM_RESPONSE,
        payload: {
          allowed: false,
          alwaysDecline: rememberChoice,
        },
      },
      () => {
        window.close();
      },
    );
  };

  return (
    <ConfigProvider locale={zhCN} theme={{ algorithm: theme.defaultAlgorithm, token: { colorPrimary: '#245ce5' } }}>
      <AntdApp component={false}>
        <div className="confirm-dialog">
          <div className="confirm-header">
            <img src="/logo-cairn.svg" alt="识途" className="confirm-logo" />
            <h2 className="confirm-title">识途浏览器协作授权</h2>
          </div>

          <div className="confirm-content">
            <p className="confirm-message">
              识途本地协作服务请求控制此浏览器。
            </p>
            <div className="server-info">
              <span className="server-label">服务地址：</span>
              <span className="server-url">{serverUrl}</span>
            </div>
          </div>

          <div className="confirm-options">
            <Checkbox
              checked={rememberChoice}
              onChange={(e) => setRememberChoice(e.target.checked)}
            >
              记住此选择
            </Checkbox>
          </div>

          <div className="confirm-footer">
            <div className="confirm-buttons">
              <Button onClick={handleDeny}>拒绝（{countdown} 秒）</Button>
              <Button type="primary" onClick={handleAllow}>
                允许
              </Button>
            </div>
          </div>
        </div>
      </AntdApp>
    </ConfigProvider>
  );
}

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(<ConfirmDialog />);
}
