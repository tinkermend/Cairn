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
import {
  CAIRN_ENVIRONMENTS,
  type CairnEnvironment,
} from '../utils/cairn-environments';

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
    environment,
    apiOrigin,
    authStatus,
    error: authError,
    token,
    account,
    targetId,
    targets,
    binding,
    isLoading,
    setEnvironment,
    initialize,
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
      if (token) {
        void refreshTargets();
        void refreshBinding();
      }
    }
  }, [open, token]);

  const handleLogin = async (values: { email: string; password: string }) => {
    setSubmitting(true);
    setLoginError(null);
    try {
      const res = await loginToCairn(apiOrigin, values.email.trim(), values.password);
      setAuth(res.accessToken, res.account);
      form.resetFields(['password']);
      message.success(`登录成功，欢迎 ${res.account.displayName}`);
    } catch (err: any) {
      setLoginError(err.message || '登录失败，请检查账号密码或服务连接');
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
          <span>{token ? '识途平台连接设置' : '登录识途'}</span>
        </div>
      }
      open={open}
      onCancel={onClose}
      closable={!!token}
      maskClosable={!!token}
      keyboard={!!token}
      footer={null}
      destroyOnClose={false}
      width={460}
    >
      <div style={{ padding: '12px 0' }}>
        {/* 平台环境配置 */}
        <div style={{ marginBottom: 16 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            平台环境
          </Text>
          <Select<CairnEnvironment>
            aria-label="平台环境"
            value={environment}
            onChange={setEnvironment}
            disabled={!!token || submitting}
            style={{ width: '100%', marginTop: 4 }}
            options={Object.entries(CAIRN_ENVIRONMENTS).map(([value, config]) => ({
              value: value as CairnEnvironment,
              label: config.origin ? config.label : `${config.label}（未配置）`,
              disabled: !config.origin,
            }))}
          />
          <Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 4 }}>
            {apiOrigin}
          </Text>
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
                  <Tag color="blue">{account.roles?.map((role) => role.name).join('、') || '未分配角色'}</Tag>
                </div>
              }
              description={account.email ? <div style={{ fontSize: 12, marginTop: 4 }}>{account.email}</div> : undefined}
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
                    {binding.targetId && <div>已自动关联对应目标系统</div>}
                  </div>
                }
                style={{ marginBottom: 16 }}
              />
            )}

            {/* 目标系统选择 */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <Text strong style={{ fontSize: 13 }}>
                  当前录制的目标系统
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
            {authStatus === 'error' && authError && (
              <Alert
                type="warning"
                showIcon
                message={authError}
                action={<Button size="small" onClick={() => void initialize()}>重试验证</Button>}
                style={{ marginBottom: 16 }}
              />
            )}
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
                label="账号"
                rules={[
                  { required: true, whitespace: true, message: '请输入账号' },
                  { max: 64, message: '账号不能超过 64 个字符' },
                ]}
              >
                <Input prefix={<UserOutlined />} placeholder="请输入账号" autoComplete="username" autoFocus />
              </Form.Item>

              <Form.Item
                name="password"
                label="密码"
                rules={[{ required: true, message: '请输入密码' }]}
              >
                <Input.Password placeholder="请输入密码" autoComplete="current-password" />
              </Form.Item>

              <Form.Item style={{ marginBottom: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
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
