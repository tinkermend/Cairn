import {
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import { Alert, Button, Empty, List, Popconfirm } from 'antd';
import type React from 'react';
import type { RecordingSession } from '../../../store';
import './RecordList.less';

interface RecordListProps {
  sessions: RecordingSession[];
  currentSessionId: string | null;
  onEditSession: (session: RecordingSession) => void;
  onDeleteSession: (sessionId: string) => void;
  onExportSession: (session: RecordingSession) => void;
  onExportAllEvents: () => void;
  onViewDetail: (session: RecordingSession) => void;
  isExtensionMode: boolean;
  isRecordingStoreReady: boolean;
  handleCreateNewSession: () => void;
}

export const RecordList: React.FC<RecordListProps> = ({
  sessions,
  currentSessionId,
  onEditSession,
  onDeleteSession,
  onExportSession,
  onExportAllEvents,
  onViewDetail,
  isExtensionMode,
  isRecordingStoreReady,
  handleCreateNewSession,
}) => {
  const hasEventsToExport = sessions.some(
    (session) => (session.eventCount ?? session.events.length) > 0,
  );

  return (
    <div className="record-list-view">
      <div className="record-list-heading">
        <div>
          <h1>录制记录</h1>
          <p>选择记录查看操作并上传场景草稿</p>
        </div>
        {hasEventsToExport && (
          <Button
            type="text"
            icon={<DownloadOutlined />}
            onClick={onExportAllEvents}
            aria-label="导出全部录制"
            title="导出全部录制"
          />
        )}
      </div>

      {!isExtensionMode && (
        <Alert
          message="当前环境无法录制"
          description="请在 Chrome 扩展侧栏中打开录制器。"
          type="info"
          showIcon
          className="record-list-alert"
        />
      )}

      {sessions.length === 0 ? (
        <div className="record-list-empty">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={<span className="record-list-empty-description">还没有录制记录</span>}
          />
          <p>打开目标系统，点击下方按钮开始首次录制。</p>
        </div>
      ) : (
        <List
          className="session-list"
          dataSource={[...sessions].sort((a, b) => b.updatedAt - a.updatedAt)}
          renderItem={(session) => {
            const eventCount = session.eventCount ?? session.events.length;
            return (
              <List.Item className="session-item">
                <article className={`session-card${session.id === currentSessionId ? ' is-current' : ''}`}>
                  <button
                    type="button"
                    className="session-card-main"
                    onClick={() => onViewDetail(session)}
                  >
                    <span className="session-card-name">{session.name}</span>
                    {session.description && (
                      <span className="session-card-description">{session.description}</span>
                    )}
                    <span className="session-card-url" title={session.url || undefined}>
                      {session.url || '未记录页面地址'}
                    </span>
                    <span className="session-card-meta">
                      <span>{new Date(session.createdAt).toLocaleString('zh-CN')}</span>
                      <span>{eventCount} 个操作</span>
                    </span>
                  </button>
                  <div className="session-card-actions">
                    <Button
                      type="text"
                      icon={<EditOutlined />}
                      aria-label={`编辑录制：${session.name}`}
                      title="编辑录制"
                      onClick={() => onEditSession(session)}
                    />
                    <Button
                      type="text"
                      icon={<DownloadOutlined />}
                      aria-label={`导出录制：${session.name}`}
                      title="导出录制"
                      disabled={eventCount === 0}
                      onClick={() => onExportSession(session)}
                    />
                    <Popconfirm
                      title="删除录制"
                      description="确定删除这条录制记录吗？"
                      okText="删除"
                      cancelText="取消"
                      okButtonProps={{ danger: true }}
                      onConfirm={() => onDeleteSession(session.id)}
                    >
                      <Button
                        type="text"
                        danger
                        icon={<DeleteOutlined />}
                        aria-label={`删除录制：${session.name}`}
                        title="删除录制"
                      />
                    </Popconfirm>
                  </div>
                </article>
              </List.Item>
            );
          }}
        />
      )}

      <div className="record-list-footer">
        <Button
          type="primary"
          icon={<PlusOutlined />}
          disabled={!isExtensionMode || !isRecordingStoreReady}
          onClick={handleCreateNewSession}
        >
          新建录制
        </Button>
      </div>
    </div>
  );
};
