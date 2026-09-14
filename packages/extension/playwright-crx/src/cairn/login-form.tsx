import * as React from 'react'
import {
  CAIRN_API_ENVIRONMENTS,
  resolveApiEnvironment,
  type ApiEnvironment,
} from './config'

type Props = {
  environments?: readonly ApiEnvironment[]
  environmentId: string
  onEnvironmentId: (id: string) => void
  email: string
  password: string
  onEmail: (value: string) => void
  onPassword: (value: string) => void
  busy: boolean
  error: string | null
  onSubmit: (event: React.FormEvent) => void
}

export const LoginForm: React.FC<Props> = ({
  environments = CAIRN_API_ENVIRONMENTS,
  environmentId,
  onEnvironmentId,
  email,
  password,
  onEmail,
  onPassword,
  busy,
  error,
  onSubmit,
}) => {
  const current = resolveApiEnvironment(environmentId, environments)

  return (
    <div className='cairn-login'>
      <div className='cairn-brand'>
        <img src='logo-observe.svg' alt='' width={40} height={40} />
        <div>
          识途
          <small>可观测场景执行平台</small>
        </div>
      </div>
      <form className='cairn-card' onSubmit={onSubmit}>
        <h1>登录识途</h1>
        <p className='cairn-lead'>用控制台账号进入。没有登录不能录制。</p>
        <div className='cairn-field'>
          <select
            id='cairn-env'
            aria-label='环境'
            value={current.id}
            onChange={(event) => onEnvironmentId(event.target.value)}
          >
            {environments.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </div>
        <div className='cairn-field'>
          <label htmlFor='cairn-email'>账号</label>
          <input
            id='cairn-email'
            name='email'
            autoComplete='username'
            placeholder='请输入账号'
            value={email}
            onChange={(event) => onEmail(event.target.value)}
          />
        </div>
        <div className='cairn-field'>
          <label htmlFor='cairn-password'>密码</label>
          <input
            id='cairn-password'
            name='password'
            type='password'
            autoComplete='current-password'
            placeholder='请输入密码'
            value={password}
            onChange={(event) => onPassword(event.target.value)}
          />
        </div>
        {error ? <p className='cairn-error'>{error}</p> : null}
        <button className='cairn-btn cairn-btn-primary cairn-btn-block' type='submit' disabled={busy}>
          {busy ? '登录中…' : '登录'}
        </button>
      </form>
    </div>
  )
}
