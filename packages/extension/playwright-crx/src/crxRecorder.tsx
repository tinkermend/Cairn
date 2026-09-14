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

  return <CairnPanel sources={sources} mode={mode} picked={picked} />;
};
