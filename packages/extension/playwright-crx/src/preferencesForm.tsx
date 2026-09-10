/**
 * Copyright (c) Rui Figueira.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import React from 'react';
import type { CrxSettings } from './settings';
import { defaultSettings, loadSettings, storeSettings } from './settings';

export const PreferencesForm: React.FC = ({}) => {
  const [initialSettings, setInitialSettings] = React.useState<CrxSettings>(defaultSettings);
  const [settings, setSettings] = React.useState<CrxSettings>(defaultSettings);
  const [isAllowedIncognitoAccess, setIsAllowedIncognitoAccess] = React.useState<boolean>(false);

  React.useEffect(() => {
    loadSettings()
        .then(settings => {
          setInitialSettings(settings);
          setSettings(settings);
        });
    chrome.extension.isAllowedIncognitoAccess().then(setIsAllowedIncognitoAccess);
  }, []);

  const canSave = React.useMemo(() => {
    return initialSettings.sidepanel !== settings.sidepanel ||
      initialSettings.targetLanguage !== settings.targetLanguage ||
      initialSettings.testIdAttributeName !== settings.testIdAttributeName ||
      initialSettings.playInIncognito !== settings.playInIncognito ||
      initialSettings.experimental !== settings.experimental;
  }, [settings, initialSettings]);

  const saveSettings = React.useCallback((e: React.FormEvent<HTMLFormElement>) => {
    if (!e.currentTarget.reportValidity())
      return;

    e.preventDefault();
    storeSettings(settings)
        .then(() => setInitialSettings(settings))
        .catch(() => {});
  }, [settings]);

  return <form id='preferences-form' onSubmit={saveSettings}>
    <label htmlFor='target-language'>默认代码语言：</label>
    <select id='target-language' name='target-language' value={settings.targetLanguage} onChange={e => setSettings({ ...settings, targetLanguage: e.target.selectedOptions[0].value })}>
      <optgroup label='Node.js'>
        <option value='javascript'>程序库</option>
        <option value='playwright-test'>测试运行器</option>
      </optgroup>
      <optgroup label='Java'>
        <option value='java-junit'>JUnit</option>
        <option value='java'>程序库</option>
      </optgroup>
      <optgroup label='Python'>
        <option value='python-pytest'>Pytest</option>
        <option value='python'>程序库</option>
        <option value='python-async'>异步程序库</option>
      </optgroup>
      <optgroup label='.NET C#'>
        <option value='csharp-mstest'>MSTest</option>
        <option value='csharp-nunit'>NUnit</option>
        <option value='csharp'>程序库</option>
      </optgroup>
    </select>
    <label htmlFor='test-id'>testid 属性名：</label>
    <input
      type='text'
      id='test-id'
      name='test-id'
      placeholder='输入属性名'
      pattern='[a-zA-Z][\w\-]*'
      title='必须是合法的属性名'
      value={settings.testIdAttributeName}
      onChange={e => setSettings({ ...settings, testIdAttributeName: e.target.value })}
    />
    <div>
      <label htmlFor='sidepanel' className='row'>在侧边栏打开：</label>
      <input
        type='checkbox'
        id='sidepanel'
        name='sidepanel'
        checked={settings.sidepanel}
        onChange={e => setSettings({ ...settings, sidepanel: e.target.checked })}
      />
    </div>
    <div>
      <label htmlFor='playInIncognito' className='row'>在无痕窗口回放：</label>
      <input
        disabled={!isAllowedIncognitoAccess}
        type='checkbox'
        id='playInIncognito'
        name='playInIncognito'
        checked={settings.playInIncognito}
        onChange={e => setSettings({ ...settings, playInIncognito: e.target.checked })}
      />
      {!isAllowedIncognitoAccess && <div className='note error'>需要先允许此扩展在无痕模式下运行。</div>}
    </div>
    <div>
      <label htmlFor='experimental' className='row'>启用实验功能：</label>
      <input
        type='checkbox'
        id='experimental'
        name='experimental'
        checked={settings.experimental}
        onChange={e => setSettings({ ...settings, experimental: e.target.checked })}
      />
    </div>
    <button id='submit' type='submit' disabled={!canSave}>{canSave ? '保存' : '已保存'}</button>
  </form>;
};
