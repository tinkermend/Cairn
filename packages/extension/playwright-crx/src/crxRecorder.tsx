/**
 * Copyright (c) Rui Figueira.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as React from 'react';
import type { ElementInfo, Mode, Source } from '@recorder/recorderTypes';
import { CairnPanel } from './cairn';

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[识途录制器渲染错误]', error, errorInfo);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 20, fontFamily: 'sans-serif', color: '#18253d', background: '#f2f5f9', minHeight: '100vh', boxSizing: 'border-box' }}>
          <h2 style={{ fontSize: 16, color: '#f04452', margin: '0 0 8px 0', fontWeight: 600 }}>录制器遇到问题</h2>
          <p style={{ fontSize: 13, color: '#607087', margin: '0 0 16px 0', wordBreak: 'break-word', lineHeight: 1.5 }}>
            {this.state.error.message || '发生未知错误'}
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              padding: '6px 14px',
              background: '#245ce5',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            重新加载
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export const CrxRecorder: React.FC = () => {
  const [sources, setSources] = React.useState<Source[]>([]);
  const [mode, setMode] = React.useState<Mode>('none');
  const [picked, setPicked] = React.useState<ElementInfo | null>(null);

  React.useEffect(() => {
    const port = chrome.runtime.connect({ name: 'recorder' });
    const onMessage = (msg: any) => {
      if (!('type' in msg) || msg.type !== 'recorder')
        return;

      switch (msg.method) {
        case 'setMode': setMode(msg.mode); break;
        case 'setSources': setSources(msg.sources); break;
        case 'resetCallLogs': break;
        case 'updateCallLogs': break;
        case 'setPaused': break;
        case 'setRunningFile': break;
        case 'elementPicked':
          setPicked(msg.elementInfo);
          window.playwrightElementPicked?.(msg.elementInfo, msg.userGesture);
          break;
      }
    };
    port.onMessage.addListener(onMessage);

    window.dispatch = async (data: any) => {
      port.postMessage({ type: 'recorderEvent', ...data });
    };
    window.playwrightElementPicked = (elementInfo: ElementInfo) => {
      setPicked(elementInfo);
    };
    window.playwrightSetRunningFile = () => {};

    return () => {
      port.disconnect();
    };
  }, []);

  return (
    <ErrorBoundary>
      <CairnPanel sources={sources} mode={mode} picked={picked} />
    </ErrorBoundary>
  );
};
