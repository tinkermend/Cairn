import { Button, Form, Input, Modal, Space } from 'antd';
import type React from 'react';
import type { RecordingSession } from '../../../store';

interface SessionModalsProps {
  // Create modal
  // isCreateModalVisible: boolean;
  // setIsCreateModalVisible: (visible: boolean) => void;
  // onCreateSession: (values: { name: string; description?: string }) => void;
  // createForm: any;

  // Edit modal
  isEditModalVisible: boolean;
  setIsEditModalVisible: (visible: boolean) => void;
  onUpdateSession: (values: { name: string; description?: string }) => void;
  editForm: any;
  // editingSession: RecordingSession | null;
  setEditingSession: (session: RecordingSession | null) => void;
}

export const SessionModals: React.FC<SessionModalsProps> = ({
  isEditModalVisible,
  setIsEditModalVisible,
  onUpdateSession,
  editForm,
  setEditingSession,
}) => {
  return (
    <>
      {/* Edit Session Modal */}
      <Modal
        title="编辑录制记录"
        open={isEditModalVisible}
        onCancel={() => {
          setIsEditModalVisible(false);
          setEditingSession(null);
          editForm.resetFields();
        }}
        footer={null}
        className="session-modal"
      >
        <Form form={editForm} layout="vertical" onFinish={onUpdateSession}>
          <Form.Item
            name="name"
            label="录制名称"
            rules={[{ required: true, message: '请输入录制名称' }]}
          >
            <Input placeholder="请输入录制名称" />
          </Form.Item>
          <Form.Item name="description" label="描述（可选）">
            <Input.TextArea placeholder="请输入录制描述" rows={3} />
          </Form.Item>
          <Form.Item style={{ marginBottom: 0, textAlign: 'right' }}>
            <Space>
              <Button
                onClick={() => {
                  setIsEditModalVisible(false);
                  setEditingSession(null);
                  editForm.resetFields();
                }}
              >
                取消
              </Button>
              <Button type="primary" htmlType="submit">
                保存
              </Button>
            </Space>
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
};
