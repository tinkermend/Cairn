import React from 'react';
import { Input, Modal, message } from 'antd';
import { CloudUploadOutlined, LinkOutlined } from '@ant-design/icons';
import type { ChromeRecordedEvent } from '@midscene/recorder-ui';
import { useCairnStore } from '../store';
import { uploadCairnRecording, getCairnStudioUrl, midsceneUploadEvents } from './cairn';
import { generateCairnDraftName } from './cairn-draft-name';
import './cairn-uploader.less';

export interface PromptUploadOptions {
  events: ChromeRecordedEvent[];
  sessionName?: string;
  onOpenConnectModal: () => void;
  onSuccess?: (draftId: string) => void;
}

/**
 * 弹出识途平台录制草稿上传确认弹窗，并执行整批上传与控制台闭环
 */
export function promptUploadToCairn(options: PromptUploadOptions): void {
  const { events, sessionName, onOpenConnectModal, onSuccess } = options;
  const store = useCairnStore.getState();

  // 1. 校验是否已登录
  if (store.authStatus !== 'authenticated' || !store.token || !store.account) {
    message.info('请先连接并登录识途平台');
    onOpenConnectModal();
    return;
  }

  // 2. 校验是否指定了 Target
  if (!store.targetId) {
    message.warning('请先指定此录制所属的目标系统 (Target)');
    onOpenConnectModal();
    return;
  }

  // 3. 校验是否有录制事件
  if (!events || events.length === 0) {
    message.warning('当前会话没有录制事件，无法上传');
    return;
  }

  const currentTarget = store.targets.find((t) => t.id === store.targetId);
  const targetName = currentTarget?.name || '目标系统';
  const activeBinding = store.binding;
  const suggestedName = generateCairnDraftName({ targetName, sessionName, events });
  let draftNameInput = suggestedName;
  const uploadCount = midsceneUploadEvents(events).length;

  Modal.confirm({
    title: '上传录制草稿',
    icon: <CloudUploadOutlined style={{ color: '#245ce5' }} />,
    content: (
      <div className="cairn-upload-confirm">
        {activeBinding && (
          <div className="cairn-upload-binding">
            <LinkOutlined />
            <span>上传后将自动关联当前场景</span>
          </div>
        )}
        <dl className="cairn-upload-summary">
          <div>
            <dt>目标系统</dt>
            <dd>{targetName}</dd>
          </div>
          <div>
            <dt>录制操作</dt>
            <dd>
              {uploadCount} 项
              {events.length !== uploadCount && <span>（原始记录 {events.length} 条）</span>}
            </dd>
          </div>
        </dl>
        <div className="cairn-upload-name-field">
          <label htmlFor="cairn-draft-name">草稿名称</label>
          <Input
            id="cairn-draft-name"
            defaultValue={draftNameInput}
            maxLength={64}
            onChange={(e) => {
              draftNameInput = e.target.value;
            }}
            placeholder="请输入录制草稿名称"
          />
          <p>已按目标系统、录制页面和时间生成，可直接修改。已识别的敏感输入会脱敏，上传后可在编排台检查步骤。</p>
        </div>
      </div>
    ),
    okText: '确认上传',
    cancelText: '取消',
    onOk: async () => {
      const hideLoading = message.loading('正在上传录制草稿至识途平台...', 0);
      try {
        const currentAuth = useCairnStore.getState();
        if (currentAuth.authStatus !== 'authenticated' || currentAuth.token !== store.token) {
          throw new Error('登录状态已改变，请重新登录后上传');
        }
        const res = await uploadCairnRecording(store.apiOrigin, store.token!, {
          events,
          targetId: store.targetId!,
          bindingId: activeBinding?.id,
          name: draftNameInput.trim() || suggestedName,
        });

        hideLoading();

        // 刷新协同绑定，清除已被消费的 binding
        void store.refreshBinding();

        const studioUrl = getCairnStudioUrl(
          store.apiOrigin,
          res.recordingDraftId,
          activeBinding?.scenarioId,
        );

        if (onSuccess) {
          onSuccess(res.recordingDraftId);
        }

        Modal.success({
          title: '录制草稿已成功保存到识途平台！',
          content: (
            <div style={{ marginTop: 8 }}>
              <p>
                草稿 <strong>{res.name}</strong> 已成功同步，在控制台中标记为 <strong>AI 录制来源</strong>。
              </p>
              <p style={{ fontSize: 12, color: '#888' }}>
                草稿 ID: <code>{res.recordingDraftId}</code>
              </p>
            </div>
          ),
          okText: '在控制台打开草稿',
          cancelText: '完成',
          okCancel: true,
          onOk: () => {
            window.open(studioUrl, '_blank');
          },
        });
      } catch (err: any) {
        hideLoading();
        if (err?.status === 401) useCairnStore.getState().logout();
        message.error(err?.message || '上传录制草稿失败');
      }
    },
  });
}
