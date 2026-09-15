import {
  INestApplication,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common'
import { APP_FILTER, APP_GUARD, Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { SYSTEM_ROLE_DEFINITIONS } from '@cairn/shared'
import { AllExceptionsFilter } from '../common/all-exceptions.filter'
import type { RequestAccount } from '../common/request-account'
import { PermissionsGuard } from '../rbac/permissions.guard'
import { listenForSupertest } from '../__tests__/http-app'
import { AssistantController } from './assistant.controller'
import { AssistantService } from './assistant.service'

function principal(
  key: 'author' | 'operator' | 'viewer' | 'custom',
  extra: Partial<RequestAccount> = {},
): RequestAccount {
  if (key === 'custom') {
    return {
      id: 'acc-custom',
      displayName: '自定义',
      email: 'custom@example.com',
      status: 'active',
      roles: [{ id: 'custom', key: 'custom', name: '自定义', kind: 'custom' }],
      permissions: ['run:read'],
      ...extra,
    }
  }
  return {
    id: `acc-${key}`,
    displayName: SYSTEM_ROLE_DEFINITIONS[key].name,
    email: `${key}@example.com`,
    status: 'active',
    roles: [{ id: key, key, name: SYSTEM_ROLE_DEFINITIONS[key].name, kind: 'system' }],
    permissions: [...SYSTEM_ROLE_DEFINITIONS[key].permissions],
    ...extra,
  }
}

class StaticAuthGuard implements CanActivate {
  constructor(private readonly account: RequestAccount) {}
  canActivate(context: ExecutionContext): boolean {
    if (!this.account) throw new UnauthorizedException('未认证')
    context.switchToHttp().getRequest().account = this.account
    return true
  }
}

const conversation = {
  id: '11111111-1111-4111-8111-111111111111',
  title: '新对话',
  createdAt: '2026-09-14T00:00:00.000Z',
  updatedAt: '2026-09-14T00:00:00.000Z',
}

async function buildApp(account: RequestAccount) {
  const assistant = {
    capabilities: vi.fn(async (actor: RequestAccount) => ({
      items: [
        {
          id: 'run.diagnose',
          label: '运行诊断',
          available: actor.permissions.includes('target:read'),
          missingPermissions: actor.permissions.includes('target:read') ? [] : ['target:read'],
          requiredContext: ['runId'],
        },
      ],
      modelEnabled: false,
    })),
    createConversation: vi.fn(async () => conversation),
    listConversations: vi.fn(async () => ({ items: [conversation] })),
    listTurns: vi.fn(async () => ({ items: [] })),
    getTurn: vi.fn(async () => ({
      id: '22222222-2222-4222-8222-222222222222',
      conversationId: conversation.id,
      clientTurnId: 'client-turn-1',
      parentTurnId: null,
      question: '这次为什么失败',
      capabilityId: 'run.diagnose',
      status: 'COMPLETED',
      deadlineAt: '2026-09-14T00:01:00.000Z',
      result: { kind: 'unsupported', reasonCode: 'TASK_UNSUPPORTED', message: '演示' },
      createdAt: '2026-09-14T00:00:00.000Z',
      updatedAt: '2026-09-14T00:00:00.000Z',
    })),
    createTurn: vi.fn(async () => ({
      id: '22222222-2222-4222-8222-222222222222',
      conversationId: conversation.id,
      clientTurnId: 'client-turn-1',
      parentTurnId: null,
      question: '这次为什么失败',
      capabilityId: 'run.diagnose',
      status: 'CLARIFY',
      deadlineAt: '2026-09-14T00:01:00.000Z',
      result: {
        kind: 'clarify',
        question: '本次要做运行诊断，还是查找功能入口？请选一项后继续。',
        missingFields: ['capabilityId'],
      },
      createdAt: '2026-09-14T00:00:00.000Z',
      updatedAt: '2026-09-14T00:00:00.000Z',
    })),
  }
  const moduleRef = await Test.createTestingModule({
    controllers: [AssistantController],
    providers: [
      Reflector,
      { provide: AssistantService, useValue: assistant },
      { provide: APP_GUARD, useValue: new StaticAuthGuard(account) },
      { provide: APP_GUARD, useClass: PermissionsGuard },
      { provide: APP_FILTER, useClass: AllExceptionsFilter },
    ],
  }).compile()
  const app = moduleRef.createNestApplication({ logger: false })
  await app.init()
  await listenForSupertest(app)
  return { app, assistant }
}

describe('助手 HTTP 权限', () => {
  const apps: INestApplication[] = []
  afterAll(async () => {
    for (const app of apps) await app.close()
  })

  it('只读角色可以使用助手入口', async () => {
    const { app } = await buildApp(principal('viewer'))
    apps.push(app)
    const res = await request(app.getHttpServer()).get('/assistant/capabilities').expect(200)
    expect(res.body.items[0].id).toBe('run.diagnose')
  })

  it('没有 ai:assist 的自定义角色不能进入助手', async () => {
    const { app, assistant } = await buildApp(principal('custom'))
    apps.push(app)
    await request(app.getHttpServer()).get('/assistant/capabilities').expect(403)
    expect(assistant.capabilities).not.toHaveBeenCalled()
  })

  it('编写者可以提交一轮任务', async () => {
    const { app } = await buildApp(principal('author'))
    apps.push(app)
    const created = await request(app.getHttpServer()).post('/assistant/conversations').send({}).expect(201)
    expect(created.body.id).toBe(conversation.id)
    await request(app.getHttpServer())
      .post(`/assistant/conversations/${conversation.id}/turns`)
      .send({
        clientTurnId: 'client-turn-1',
        question: '目标账号在哪里配置？',
        capabilityHint: 'run.diagnose',
        pageContext: { page: 'run', runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      })
      .expect(200)
  })
})
