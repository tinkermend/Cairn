import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common'
import type { Request, Response } from 'express'
import {
  assistantCapabilitiesResponseSchema,
  assistantConversationListQuerySchema,
  assistantConversationListSchema,
  assistantConversationSchema,
  assistantTurnListQuerySchema,
  assistantTurnListSchema,
  assistantTurnSchema,
  cancelResultSchema,
  createAssistantConversationBodySchema,
  createAssistantTurnBodySchema,
  submitAcceptedSchema,
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
    return assistantConversationSchema.parse(
      await this.assistant.createConversation(actor, body, body.question ?? body.title),
    )
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
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermissions('ai:assist')
  async createTurn(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(createAssistantTurnBodySchema)) body: CreateAssistantTurnBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return submitAcceptedSchema.parse(await this.assistant.createTurn(actor, id, body))
  }

  @Get('conversations/:id/turns/:turnId/observe')
  @RequirePermissions('ai:assist')
  async observeTurn(
    @Param('id') id: string,
    @Param('turnId') turnId: string,
    @CurrentAccount() actor: RequestAccount,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    await this.assistant.observeTurn(actor, id, turnId, req, res)
  }

  @Post('conversations/:id/turns/:turnId/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('ai:assist')
  async cancelTurn(
    @Param('id') id: string,
    @Param('turnId') turnId: string,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return cancelResultSchema.parse(await this.assistant.cancelTurn(actor, id, turnId))
  }

  @Get('model-invocations')
  @RequirePermissions('ai:assist')
  async listModelInvocations(
    @Query('turnId') turnId: string | undefined,
    @Query('limit') limit: string | undefined,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return await this.assistant.listModelInvocations(actor, {
      turnId,
      limit: limit ? Number(limit) : undefined,
    })
  }
}
