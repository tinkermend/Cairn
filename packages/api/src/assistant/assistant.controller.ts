import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req } from '@nestjs/common'
import type { Request } from 'express'
import {
  assistantCapabilitiesResponseSchema,
  assistantConversationListQuerySchema,
  assistantConversationListSchema,
  assistantConversationSchema,
  assistantTurnListQuerySchema,
  assistantTurnListSchema,
  assistantTurnSchema,
  createAssistantConversationBodySchema,
  createAssistantTurnBodySchema,
  type CreateAssistantConversationBody,
  type CreateAssistantTurnBody,
} from '@cairn/shared'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import { CurrentAccount } from '../rbac/current-account.decorator'
import { RequirePermissions } from '../rbac/require-permission.decorator'
import type { RequestAccount } from '../common/request-account'
import { AssistantService } from './assistant.service'

@Controller('assistant')
export class AssistantController {
  constructor(private readonly assistant: AssistantService) {}

  @Get('capabilities')
  @RequirePermissions('ai:assist')
  async capabilities(@CurrentAccount() actor: RequestAccount) {
    return assistantCapabilitiesResponseSchema.parse(await this.assistant.capabilities(actor))
  }

  @Post('conversations')
  @RequirePermissions('ai:assist')
  async createConversation(
    @Body(new ZodValidationPipe(createAssistantConversationBodySchema)) body: CreateAssistantConversationBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return assistantConversationSchema.parse(await this.assistant.createConversation(actor, body))
  }

  @Get('conversations')
  @RequirePermissions('ai:assist')
  async listConversations(
    @Query(new ZodValidationPipe(assistantConversationListQuerySchema)) query: { cursor?: string; limit?: number },
    @CurrentAccount() actor: RequestAccount,
  ) {
    return assistantConversationListSchema.parse(await this.assistant.listConversations(actor, query))
  }

  @Get('conversations/:id/turns')
  @RequirePermissions('ai:assist')
  async listTurns(
    @Param('id') id: string,
    @Query(new ZodValidationPipe(assistantTurnListQuerySchema)) query: { cursor?: string; limit?: number },
    @CurrentAccount() actor: RequestAccount,
  ) {
    return assistantTurnListSchema.parse(await this.assistant.listTurns(actor, id, query))
  }

  @Get('conversations/:id/turns/:turnId')
  @RequirePermissions('ai:assist')
  async getTurn(
    @Param('id') id: string,
    @Param('turnId') turnId: string,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return assistantTurnSchema.parse(await this.assistant.getTurn(actor, id, turnId))
  }

  @Post('conversations/:id/turns')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('ai:assist')
  async createTurn(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(createAssistantTurnBodySchema)) body: CreateAssistantTurnBody,
    @CurrentAccount() actor: RequestAccount,
    @Req() req: Request,
  ) {
    return assistantTurnSchema.parse(await this.assistant.createTurn(actor, id, body, abortFrom(req)))
  }
}

function abortFrom(req: Request): AbortSignal {
  const controller = new AbortController()
  req.on('close', () => {
    if (!req.complete) controller.abort()
  })
  return controller.signal
}
