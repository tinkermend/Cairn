import {
  CheckCircleOutlined,
  CloudUploadOutlined,
  DisconnectOutlined,
  LinkOutlined,
  LoadingOutlined,
  ReloadOutlined,
  UserOutlined,
} from '@ant-design/icons';
import {
  Alert,
  Button,
  Divider,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Tag,
  Typography,
  message,
} from 'antd';
import React, { useEffect, useState } from 'react';
import { useCairnStore } from '../store';
import { loginToCairn } from '../utils/cairn';

const { Text } = Typography;

interface CairnConnectModalProps {
  open: boolean;
  onClose: () => void;
}

export const CairnConnectModal: React.FC<CairnConnectModalProps> = ({
  open,
  onClose,
}) => {
  const {
    apiOrigin,
    token,
    account,
    targetId,
    targets,
    binding,
    isLoading,
    setApiOrigin,
    setAuth,
    setTargetId,
    refreshTargets,
    refreshBinding,
    logout,
  } = useCairnStore();

  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      form.setFieldsValue({
        apiOrigin,
      });
      if (token) {
        void refreshTargets();
        void refreshBinding();
      }
    }
  }, [open, apiOrigin, token]);

  const handleLogin = async (values: any) => {
    setSubmitting(true);
    setLoginError(null);
    try {
      const origin = values.apiOrigin?.trim() || apiOrigin;
      setApiOrigin(origin);

      const res = await loginToCairn(origin, values.email, values.password);
      setAuth(res.accessToken, res.account);
      message.success(`登录成功，欢迎 ${res.account.displayName || res.account.email}`);
    } catch (err: any) {
      setLoginError(err.message || '登录失败，请检查账号密码及 API 地址');
    } finally {
      setSubmitting(false);
    }
  };

  const handleLogout = () => {
    logout();
    message.info('已退出识途平台登录');
  };

  return (
    <Modal
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <CloudUploadOutlined style={{ color: '#2B83FF', fontSize: 18 }} />
          <span>识途平台连接设置</span>
        </div>
      }
      open={open}
      onCancel={onClose}
      footer={null}
      destroyOnClose={false}
      width={460}
    >
      <div style={{ padding: '12px 0' }}>
        {/* 平台环境配置 */}
        <div style={{ marginBottom: 16 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            API 服务地址 (Origin)
          </Text>
          <Input
            value={apiOrigin}
            onChange={(e) => setApiOrigin(e.target.value)}
            placeholder="http://localhost:3030"
            disabled={!!token || submitting}
            style={{ marginTop: 4 }}
          />
        </div>

        {/* 状态展示 */}
        {token && account ? (
          <div>
            <Alert
              type="success"
              showIcon
              icon={<CheckCircleOutlined />}
              message={
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>
                    已连接：<strong>{account.displayName || account.email}</strong>
                  </span>
                  <Tag color="blue">{account.role || '编写者'}</Tag>
                </div>
              }
              description={<div style={{ fontSize: 12, marginTop: 4 }}>{account.email}</div>}
              style={{ marginBottom: 16 }}
            />

            {/* 协同录制绑定感知 */}
            {binding && (
              <Alert
                type="info"
                showIcon
                icon={<LinkOutlined />}
                message="检测到控制台正在等待录制"
                description={
                  <div style={{ fontSize: 12 }}>
                    场景 ID: {binding.scenarioId}
                    {binding.targetId && <div>已自动为您关联对应 Target</div>}
                  </div>
                }
                style={{ marginBottom: 16 }}
              />
            )}

            {/* Target 目标系统选择 */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <Text strong style={{ fontSize: 13 }}>
                  当前录制的目标系统 (Target)
                </Text>
                <Button
                  type="link"
                  size="small"
                  icon={<ReloadOutlined spin={isLoading} />}
                  onClick={() => refreshTargets()}
                >
                  刷新目标
                </Button>
              </div>

              <Select
                value={targetId || undefined}
                onChange={(val) => setTargetId(val)}
                placeholder="请选择录制归属的目标系统"
                style={{ width: '100%' }}
                showSearch
                optionFilterProp="label"
                options={targets.map((t) => ({
                  value: t.id,
                  label: `${t.name} (${t.baseUrl || '无默认地址'})`,
                }))}
              />
              <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>
                录制完成上传时，事件将归入此目标系统对应的场景草稿中。
              </div>
            </div>

            <Divider style={{ margin: '16px 0' }} />

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <Button danger icon={<DisconnectOutlined />} onClick={handleLogout}>
                退出登录
              </Button>
              <Button type="primary" onClick={onClose}>
                完成
              </Button>
            </div>
          </div>
        ) : (
          <div>
            {loginError && (
              <Alert
                type="error"
                showIcon
                message={loginError}
                style={{ marginBottom: 16 }}
                closable
                onClose={() => setLoginError(null)}
              />
            )}

            <Form form={form} layout="vertical" onFinish={handleLogin}>
              <Form.Item
                name="email"
                label="控制台账号 (Email)"
                rules={[
                  { required: true, message: '请输入识途账号邮箱' },
                  { type: 'email', message: '请输入有效的邮箱地址' },
                ]}
              >
                <Input prefix={<UserOutlined />} placeholder="author@cairn.local" />
              </Form.Item>

              <Form.Item
                name="password"
                label="账号密码"
                rules={[{ required: true, message: '请输入密码' }]}
              >
                <Input.Password placeholder="请输入密码" />
              </Form.Item>

              <Form.Item style={{ marginBottom: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                  <Button onClick={onClose}>取消</Button>
                  <Button type="primary" htmlType="submit" loading={submitting}>
                    登录识途
                  </Button>
                </div>
              </Form.Item>
            </Form>
          </div>
        )}
      </div>
    </Modal>
  );
};
