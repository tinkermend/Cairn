import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Res } from '@nestjs/common'
import type { Response } from 'express'
import {
  applyRecordingImportBodySchema,
  createRecordingBindingBodySchema,
  createScenarioBodySchema,
  previewRecordingImportBodySchema,
  publishScenarioBodySchema,
  saveScenarioDraftBodySchema,
  scenarioListQuerySchema,
  acceptKnowledgeProposalBodySchema,
  createKnowledgeProposalBodySchema,
  rejectKnowledgeProposalBodySchema,
  trialRunBodySchema,
  updateScenarioBodySchema,
  deleteResourceBodySchema,
  previewScenarioExpansionBodySchema,
  inlineScenarioModuleInvocationBodySchema,
  moduleUpgradePreviewBodySchema,
  moduleUpgradeBodySchema,
  moduleExtractPreviewBodySchema,
  moduleExtractBodySchema,
  moduleReplacePreviewBodySchema,
  moduleReplaceBodySchema,
  moduleResolveAcceptBodySchema,
  type AcceptKnowledgeProposalBody,
  type ApplyRecordingImportBody,
  type CreateKnowledgeProposalBody,
  type RejectKnowledgeProposalBody,
  type DeleteResourceBody,
  type CreateRecordingBindingBody,
  type CreateScenarioBody,
  type PreviewRecordingImportBody,
  type PublishScenarioBody,
  type SaveScenarioDraftBody,
  type ScenarioListQuery,
  type TrialRunBody,
  type UpdateScenarioBody,
  type PreviewScenarioExpansionBody,
  type InlineScenarioModuleInvocationBody,
  type ModuleUpgradePreviewBody,
  type ModuleUpgradeBody,
  type ModuleExtractPreviewBody,
  type ModuleExtractBody,
  type ModuleReplacePreviewBody,
  type ModuleReplaceBody,
  type ModuleResolveAcceptBody,
} from '@cairn/shared'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import type { RequestAccount } from '../common/request-account'
import { CurrentAccount } from '../rbac/current-account.decorator'
import { RequirePermissions } from '../rbac/require-permission.decorator'
import { ScenariosService } from './scenarios.service'

@Controller('scenarios')
export class ScenariosController {
  constructor(private readonly scenarios: ScenariosService) {}

  @Get()
  @RequirePermissions('workflow:read')
  list(@Query(new ZodValidationPipe(scenarioListQuerySchema)) query: ScenarioListQuery) {
    return this.scenarios.list(query)
  }

  @Get('capabilities')
  @RequirePermissions('workflow:read')
  capabilities() {
    return this.scenarios.capabilities()
  }

  @Post()
  @RequirePermissions('workflow:write')
  create(
    @Body(new ZodValidationPipe(createScenarioBodySchema)) body: CreateScenarioBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.scenarios.create(body, actor)
  }

  @Get(':scenarioId')
  @RequirePermissions('workflow:read')
  get(@Param('scenarioId') scenarioId: string) {
    return this.scenarios.get(scenarioId)
  }

  @Post(':scenarioId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('workflow:write')
  update(
    @Param('scenarioId') scenarioId: string,
    @Body(new ZodValidationPipe(updateScenarioBodySchema)) body: UpdateScenarioBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.scenarios.update(scenarioId, body, actor)
  }

  @Post(':scenarioId/draft')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('workflow:write')
  saveDraft(
    @Param('scenarioId') scenarioId: string,
    @Body(new ZodValidationPipe(saveScenarioDraftBodySchema)) body: SaveScenarioDraftBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.scenarios.saveDraft(scenarioId, body, actor)
  }

  @Post(':scenarioId/publish')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('workflow:write')
  publish(
    @Param('scenarioId') scenarioId: string,
    @Body(new ZodValidationPipe(publishScenarioBodySchema)) body: PublishScenarioBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.scenarios.publish(scenarioId, body, actor)
  }

  @Post(':scenarioId/knowledge-proposals')
  @RequirePermissions('workflow:write', 'map:read', 'target:read', 'ai:assist')
  createKnowledgeProposal(
    @Param('scenarioId') scenarioId: string,
    @Body(new ZodValidationPipe(createKnowledgeProposalBodySchema)) body: CreateKnowledgeProposalBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.scenarios.createKnowledgeProposal(scenarioId, body, actor)
  }

  @Get(':scenarioId/knowledge-proposals/:proposalId')
  @RequirePermissions('workflow:read', 'map:read', 'target:read')
  getKnowledgeProposal(
    @Param('scenarioId') scenarioId: string,
    @Param('proposalId') proposalId: string,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.scenarios.getKnowledgeProposal(scenarioId, proposalId, actor)
  }

  @Post(':scenarioId/knowledge-proposals/:proposalId/accept')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('workflow:write', 'map:read', 'target:read')
  acceptKnowledgeProposal(
    @Param('scenarioId') scenarioId: string,
    @Param('proposalId') proposalId: string,
    @Body(new ZodValidationPipe(acceptKnowledgeProposalBodySchema)) body: AcceptKnowledgeProposalBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.scenarios.acceptKnowledgeProposal(scenarioId, proposalId, body, actor)
  }

  @Post(':scenarioId/knowledge-proposals/:proposalId/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('workflow:write', 'map:read', 'target:read')
  rejectKnowledgeProposal(
    @Param('scenarioId') scenarioId: string,
    @Param('proposalId') proposalId: string,
    @Body(new ZodValidationPipe(rejectKnowledgeProposalBodySchema)) _body: RejectKnowledgeProposalBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.scenarios.rejectKnowledgeProposal(scenarioId, proposalId, actor)
  }

  @Post(':scenarioId/trial')
  @RequirePermissions('workflow:write', 'run:execute', 'target:read')
  async trial(
    @Param('scenarioId') scenarioId: string,
    @Body(new ZodValidationPipe(trialRunBodySchema)) body: TrialRunBody,
    @CurrentAccount() actor: RequestAccount,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { detail, created } = await this.scenarios.trial(scenarioId, body, actor)
    res.status(created ? HttpStatus.CREATED : HttpStatus.OK)
    return detail
  }

  @Get(':scenarioId/delete-preview')
  @RequirePermissions('workflow:delete')
  previewDelete(@Param('scenarioId') scenarioId: string) {
    return this.scenarios.previewDelete(scenarioId)
  }

  @Post(':scenarioId/delete')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('workflow:delete')
  remove(
    @Param('scenarioId') scenarioId: string,
    @CurrentAccount() actor: RequestAccount,
    @Body(new ZodValidationPipe(deleteResourceBodySchema.optional())) body?: DeleteResourceBody,
  ) {
    return this.scenarios.remove(scenarioId, actor, body)
  }

  @Get(':scenarioId/versions')
  @RequirePermissions('workflow:read')
  versions(@Param('scenarioId') scenarioId: string) {
    return this.scenarios.versions(scenarioId)
  }

  @Post(':scenarioId/recording-bindings')
  @RequirePermissions('workflow:write', 'target:read')
  createRecordingBinding(
    @Param('scenarioId') scenarioId: string,
    @Body(new ZodValidationPipe(createRecordingBindingBodySchema)) body: CreateRecordingBindingBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.scenarios.createRecordingBinding(scenarioId, body, actor)
  }

  @Get(':scenarioId/recording-imports')
  @RequirePermissions('workflow:read', 'target:read')
  listRecordingImports(
    @Param('scenarioId') scenarioId: string,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.scenarios.listRecordingImports(scenarioId, actor)
  }

  @Post(':scenarioId/recording-imports/preview')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('workflow:read', 'target:read')
  previewRecordingImport(
    @Param('scenarioId') scenarioId: string,
    @Body(new ZodValidationPipe(previewRecordingImportBodySchema)) body: PreviewRecordingImportBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.scenarios.previewRecordingImport(scenarioId, body, actor)
  }

  @Post(':scenarioId/recording-imports/apply')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('workflow:write', 'target:read')
  applyRecordingImport(
    @Param('scenarioId') scenarioId: string,
    @Body(new ZodValidationPipe(applyRecordingImportBodySchema)) body: ApplyRecordingImportBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.scenarios.applyRecordingImport(scenarioId, body, actor)
  }

  @Post(':scenarioId/module-expansion-preview')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('workflow:read', 'module:read')
  previewModuleExpansion(
    @Param('scenarioId') scenarioId: string,
    @Body(new ZodValidationPipe(previewScenarioExpansionBodySchema.optional())) body?: PreviewScenarioExpansionBody,
  ) {
    return this.scenarios.previewModuleExpansion(scenarioId, body)
  }

  @Post(':scenarioId/nodes/:invocationId/inline')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('workflow:write')
  inlineModuleInvocation(
    @Param('scenarioId') scenarioId: string,
    @Param('invocationId') invocationId: string,
    @Body(new ZodValidationPipe(inlineScenarioModuleInvocationBodySchema)) body: InlineScenarioModuleInvocationBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.scenarios.inlineModuleInvocation(scenarioId, invocationId, body, actor)
  }

  @Post(':scenarioId/module-upgrade-preview')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('workflow:read', 'module:read')
  previewModuleUpgrade(
    @Param('scenarioId') scenarioId: string,
    @Body(new ZodValidationPipe(moduleUpgradePreviewBodySchema)) body: ModuleUpgradePreviewBody,
  ) {
    return this.scenarios.previewModuleUpgrade(scenarioId, body)
  }

  @Post(':scenarioId/module-upgrade')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('workflow:write', 'module:read')
  upgradeModule(
    @Param('scenarioId') scenarioId: string,
    @Body(new ZodValidationPipe(moduleUpgradeBodySchema)) body: ModuleUpgradeBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.scenarios.upgradeModule(scenarioId, body, actor)
  }

  @Post(':scenarioId/module-extract-preview')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('workflow:read', 'module:read')
  previewModuleExtract(
    @Param('scenarioId') scenarioId: string,
    @Body(new ZodValidationPipe(moduleExtractPreviewBodySchema)) body: ModuleExtractPreviewBody,
  ) {
    return this.scenarios.previewModuleExtract(scenarioId, body)
  }

  @Post(':scenarioId/module-extract')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('workflow:write', 'module:write')
  extractModule(
    @Param('scenarioId') scenarioId: string,
    @Body(new ZodValidationPipe(moduleExtractBodySchema)) body: ModuleExtractBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.scenarios.extractModule(scenarioId, body, actor)
  }

  @Post(':scenarioId/module-replace-preview')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('workflow:read', 'module:read')
  previewModuleReplace(
    @Param('scenarioId') scenarioId: string,
    @Body(new ZodValidationPipe(moduleReplacePreviewBodySchema)) body: ModuleReplacePreviewBody,
  ) {
    return this.scenarios.previewModuleReplace(scenarioId, body)
  }

  @Post(':scenarioId/module-replace')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('workflow:write', 'module:read')
  replaceModule(
    @Param('scenarioId') scenarioId: string,
    @Body(new ZodValidationPipe(moduleReplaceBodySchema)) body: ModuleReplaceBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.scenarios.replaceModule(scenarioId, body, actor)
  }

  @Post(':scenarioId/module-resolutions/:requestId/accept')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('workflow:write', 'module:read', 'target:read')
  acceptModuleResolution(
    @Param('scenarioId') scenarioId: string,
    @Param('requestId') requestId: string,
    @Body(new ZodValidationPipe(moduleResolveAcceptBodySchema)) body: ModuleResolveAcceptBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.scenarios.acceptModuleResolution(scenarioId, requestId, body, actor)
  }
}
