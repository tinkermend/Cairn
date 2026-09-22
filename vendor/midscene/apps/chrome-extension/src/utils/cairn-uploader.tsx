import React from 'react';
import { Input, Modal, message } from 'antd';
import { CloudUploadOutlined, LinkOutlined } from '@ant-design/icons';
import type { ChromeRecordedEvent } from '@midscene/recorder-ui';
import { useCairnStore } from '../store';
import { uploadCairnRecording, getCairnStudioUrl } from './cairn';

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
  if (!store.token || !store.account) {
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
  const targetName = currentTarget ? currentTarget.name : store.targetId;
  const activeBinding = store.binding;
  let draftNameInput = sessionName || `Midscene录制-${new Date().toLocaleTimeString()}`;

  Modal.confirm({
    title: '上传录制草稿至识途平台',
    icon: <CloudUploadOutlined style={{ color: '#2B83FF' }} />,
    content: (
      <div style={{ marginTop: 12 }}>
        {activeBinding && (
          <div
            style={{
              padding: '6px 10px',
              backgroundColor: '#e6f7ff',
              border: '1px solid #91d5ff',
              borderRadius: 6,
              marginBottom: 12,
              fontSize: 12,
              color: '#0050b3',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <LinkOutlined />
            <span>检测到来自控制台场景协同录制，上传后将自动关联该场景！</span>
          </div>
        )}
        <div style={{ marginBottom: 10 }}>
          <span style={{ fontSize: 12, color: '#666' }}>目标系统：</span>
          <strong style={{ fontSize: 13, color: '#1677ff' }}>{targetName}</strong>
        </div>
        <div style={{ marginBottom: 10 }}>
          <span style={{ fontSize: 12, color: '#666' }}>包含操作：</span>
          <span>共 <strong>{events.length}</strong> 步（已自动脱敏敏感输入并剔除 Base64 截图）</span>
        </div>
        <div>
          <span style={{ fontSize: 12, color: '#666' }}>草稿名称：</span>
          <Input
            defaultValue={draftNameInput}
            onChange={(e) => {
              draftNameInput = e.target.value;
            }}
            placeholder="请输入录制草稿名称"
            style={{ marginTop: 4 }}
          />
        </div>
      </div>
    ),
    okText: '确认上传',
    cancelText: '取消',
    onOk: async () => {
      const hideLoading = message.loading('正在上传录制草稿至识途平台...', 0);
      try {
        const res = await uploadCairnRecording(store.apiOrigin, store.token!, {
          events,
          targetId: store.targetId!,
          bindingId: activeBinding?.id,
          name: draftNameInput,
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
        message.error(err?.message || '上传录制草稿失败');
      }
    },
  });
}
