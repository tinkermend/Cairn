import {
  ArrowLeftOutlined,
  ClearOutlined,
  CloseOutlined,
  CloudUploadOutlined,
  PlayCircleOutlined,
} from '@ant-design/icons';
import { RecordTimeline } from '@midscene/recorder-ui';
import { Alert, Button, Empty, Popconfirm, Tag, Tooltip } from 'antd';
import type React from 'react';
import { useState } from 'react';
import { CairnConnectModal } from '../../../components/CairnConnectModal';
import { useCairnStore, useRecordStore, useRecordingSessionStore } from '../../../store';
import { promptUploadToCairn } from '../../../utils/cairn-uploader';

interface RecordDetailProps {
  sessionId: string;
  isRecording: boolean;
  isStarting: boolean;
  currentTab: chrome.tabs.Tab | null;
  onBack: () => void;
  onStartRecording: (id: string) => void;
  onStopRecording: () => void | Promise<void>;
  onClearEvents: () => void;
  isExtensionMode: boolean;
  onClose: () => void;
}

export const RecordDetail: React.FC<RecordDetailProps> = ({
  sessionId,
  isRecording,
  isStarting,
  onBack,
  onStartRecording,
  onStopRecording,
  onClearEvents,
  onClose,
}) => {
  const [isCairnModalOpen, setIsCairnModalOpen] = useState(false);
  const events = useRecordStore((state) => state.events);
  const targetId = useCairnStore((state) => state.targetId);
  const targets = useCairnStore((state) => state.targets);
  const currentTarget = targets.find((target) => target.id === targetId);
  const sessions = useRecordingSessionStore((state) => state.sessions);
  const session = sessions.find((item) => item.id === sessionId);

  if (!session) {
    return (
      <div className="record-detail-view">
        <Alert
          message="录制记录不存在"
          description="这条录制记录已被删除或暂时无法读取。"
          type="error"
          showIcon
        />
        <Button type="text" icon={<ArrowLeftOutlined />} onClick={onBack}>
          返回录制列表
        </Button>
      </div>
    );
  }

  return (
    <div className="record-detail-view">
      <div className="record-detail-header">
        <div className="record-detail-heading">
          <span className={`record-detail-status${isRecording ? ' is-recording' : ''}`}>
            <span className="record-detail-status-dot" />
            {isRecording ? '录制中' : events.length > 0 ? '已暂停' : '待录制'}
          </span>
          <strong title={session.name}>{session.name}</strong>
        </div>
        <div className="record-detail-header-actions">
          <Button
            type="text"
            icon={<CloseOutlined />}
            onClick={onClose}
            aria-label="返回录制列表"
            title="返回录制列表"
          />
        </div>
      </div>

      <div className="record-detail-context">
        <span>目标系统</span>
        <Tooltip title="点击更换录制的目标系统">
          <Tag
            className="record-detail-target"
            onClick={() => setIsCairnModalOpen(true)}
          >
            {currentTarget ? currentTarget.name : '请选择目标系统'}
          </Tag>
        </Tooltip>
      </div>

      <div className="record-detail-section-heading">
        <div>
          <h2>操作记录</h2>
          <span>{events.length} 个操作</span>
        </div>
        <div className="record-detail-tools">
          {events.length > 0 && !isRecording && (
            <Button
              type="primary"
              size="small"
              icon={<CloudUploadOutlined />}
              onClick={() => {
                promptUploadToCairn({
                  events,
                  sessionName: session.name,
                  onOpenConnectModal: () => setIsCairnModalOpen(true),
                });
              }}
            >
              上传草稿
            </Button>
          )}
          <Popconfirm
            title="清空操作记录"
            description="确定清空这条录制中的全部操作吗？"
            okText="清空"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={onClearEvents}
            disabled={events.length === 0 || isRecording}
          >
            <Button
              type="text"
              size="small"
              icon={<ClearOutlined />}
              disabled={events.length === 0 || isRecording}
              aria-label="清空操作记录"
              title="清空操作记录"
            />
          </Popconfirm>
        </div>
      </div>

      <div className="record-detail-timeline">
        {events.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="还没有记录到操作"
          />
        ) : (
          <RecordTimeline events={events} variant="chrome-extension" />
        )}
      </div>

      <div className="record-detail-footer">
        {isRecording ? (
          <div className="record-detail-recording-bar">
            <span className="record-detail-recording-indicator">
              <span className="record-detail-status-dot" />
              正在记录浏览器操作
            </span>
            <Button
              danger
              onClick={() => void onStopRecording()}
            >
              停止录制
            </Button>
          </div>
        ) : (
          <Button
            type="primary"
            icon={<PlayCircleOutlined />}
            onClick={() => onStartRecording(sessionId)}
            disabled={isStarting}
            loading={isStarting}
          >
            {events.length > 0 ? '继续录制' : '开始录制'}
          </Button>
        )}
      </div>

      <CairnConnectModal
        open={isCairnModalOpen}
        onClose={() => setIsCairnModalOpen(false)}
      />
    </div>
  );
};
