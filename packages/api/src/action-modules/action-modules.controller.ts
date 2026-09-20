import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Res } from '@nestjs/common'
import type { Response } from 'express'
import {
  createModuleBodySchema,
  disableAffectedScenariosBodySchema,
  moduleBatchUpgradeBodySchema,
  moduleListQuerySchema,
  modulePublicationBodySchema,
  moduleReferenceListQuerySchema,
  publishModuleBodySchema,
  saveModuleDraftBodySchema,
  updateModuleMetaBodySchema,
  moduleTrialRunBodySchema,
  moduleResolveRequestSchema,
  moduleResolveCloseBodySchema,
  moduleQualityQuerySchema,
  moduleInvocationListQuerySchema,
  type CreateModuleBody,
  type DisableAffectedScenariosBody,
  type ModuleBatchUpgradeBody,
  type ModuleListQuery,
  type ModulePublicationBody,
  type ModuleReferenceListQuery,
  type PublishModuleBody,
  type SaveModuleDraftBody,
  type UpdateModuleMetaBody,
  type ModuleTrialRunBody,
  type ModuleResolveRequest,
  type ModuleResolveCloseBody,
  type ModuleQualityQuery,
  type ModuleInvocationListQuery,
} from '@cairn/shared'
import { ZodValidationPipe } from '../common/zod-validation.pipe.js'
import type { RequestAccount } from '../common/request-account.js'
import { CurrentAccount } from '../rbac/current-account.decorator.js'
import { RequirePermissions } from '../rbac/require-permission.decorator.js'
import { ActionModulesService } from './action-modules.service.js'

@Controller('action-modules')
export class ActionModulesController {
  constructor(private readonly actionModules: ActionModulesService) {}

  @Get()
  @RequirePermissions('module:read', 'target:read')
  list(
    @Query(new ZodValidationPipe(moduleListQuerySchema)) query: ModuleListQuery,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.actionModules.list(query, actor)
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('module:write', 'target:read')
  create(
    @Body(new ZodValidationPipe(createModuleBodySchema)) body: CreateModuleBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.actionModules.create(body, actor)
  }

  @Get('capabilities')
  @RequirePermissions('module:read', 'target:read')
  capabilities() {
    return this.actionModules.capabilities()
  }

  @Post('resolve')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('module:read', 'target:read')
  resolve(
    @Body(new ZodValidationPipe(moduleResolveRequestSchema)) body: ModuleResolveRequest,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.actionModules.resolve(body, actor)
  }

  @Get('resolutions/:requestId')
  @RequirePermissions('module:read', 'target:read')
  getResolution(@Param('requestId') requestId: string, @CurrentAccount() actor: RequestAccount) {
    return this.actionModules.getResolution(requestId, actor)
  }

  @Post('resolutions/:requestId/close')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('module:read', 'target:read')
  closeResolution(
    @Param('requestId') requestId: string,
    @Body(new ZodValidationPipe(moduleResolveCloseBodySchema)) body: ModuleResolveCloseBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.actionModules.closeResolution(requestId, body, actor)
  }

  @Get(':moduleId/quality')
  @RequirePermissions('module:read', 'target:read')
  quality(
    @Param('moduleId') id: string,
    @Query(new ZodValidationPipe(moduleQualityQuerySchema)) query: ModuleQualityQuery,
  ) {
    return this.actionModules.quality(id, query)
  }

  @Get(':moduleId/invocations')
  @RequirePermissions('module:read', 'target:read', 'run:read')
  invocations(
    @Param('moduleId') id: string,
    @Query(new ZodValidationPipe(moduleInvocationListQuerySchema)) query: ModuleInvocationListQuery,
  ) {
    return this.actionModules.invocations(id, query)
  }

  @Get(':moduleId')
  @RequirePermissions('module:read', 'target:read')
  get(@Param('moduleId') id: string, @CurrentAccount() actor: RequestAccount) {
    return this.actionModules.get(id, actor)
  }

  @Post(':moduleId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('module:write', 'target:read')
  updateMeta(
    @Param('moduleId') id: string,
    @Body(new ZodValidationPipe(updateModuleMetaBodySchema)) body: UpdateModuleMetaBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.actionModules.updateMeta(id, body, actor)
  }

  @Post(':moduleId/draft')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('module:write', 'target:read')
  saveDraft(
    @Param('moduleId') id: string,
    @Body(new ZodValidationPipe(saveModuleDraftBodySchema)) body: SaveModuleDraftBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.actionModules.saveDraft(id, body, actor)
  }

  @Post(':moduleId/publish')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('module:publish', 'target:read')
  publish(
    @Param('moduleId') id: string,
    @Body(new ZodValidationPipe(publishModuleBodySchema)) body: PublishModuleBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.actionModules.publish(id, body, actor)
  }

  @Get(':moduleId/references')
  @RequirePermissions('module:read', 'target:read')
  listReferences(
    @Param('moduleId') id: string,
    @Query(new ZodValidationPipe(moduleReferenceListQuerySchema)) query: ModuleReferenceListQuery,
  ) {
    return this.actionModules.listReferences(id, query)
  }

  @Get(':moduleId/delete-preview')
  @RequirePermissions('module:read', 'target:read')
  previewDelete(@Param('moduleId') id: string) {
    return this.actionModules.previewDelete(id)
  }

  @Post(':moduleId/batch-upgrade-drafts')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('workflow:write', 'module:read', 'target:read')
  batchUpgrade(
    @Param('moduleId') id: string,
    @Body(new ZodValidationPipe(moduleBatchUpgradeBodySchema)) body: ModuleBatchUpgradeBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.actionModules.batchUpgrade(id, body, actor)
  }

  @Post(':moduleId/disable-affected-scenarios')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('workflow:write', 'module:publish', 'target:read')
  disableAffected(
    @Param('moduleId') id: string,
    @Body(new ZodValidationPipe(disableAffectedScenariosBodySchema)) body: DisableAffectedScenariosBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.actionModules.disableAffected(id, body, actor)
  }

  @Get(':moduleId/versions')
  @RequirePermissions('module:read', 'target:read')
  listVersions(@Param('moduleId') id: string) {
    return this.actionModules.listVersions(id)
  }

  @Get(':moduleId/versions/:versionId')
  @RequirePermissions('module:read', 'target:read')
  getVersion(@Param('moduleId') id: string, @Param('versionId') versionId: string) {
    return this.actionModules.getVersion(id, versionId)
  }

  @Post(':moduleId/versions/:versionId/publication')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('module:publish', 'target:read')
  updatePublication(
    @Param('moduleId') id: string,
    @Param('versionId') versionId: string,
    @Body(new ZodValidationPipe(modulePublicationBodySchema)) body: ModulePublicationBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.actionModules.updatePublication(id, versionId, body, actor)
  }

  @Post(':moduleId/delete')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('module:write', 'target:read')
  delete(@Param('moduleId') id: string, @CurrentAccount() actor: RequestAccount) {
    return this.actionModules.delete(id, actor)
  }

  @Post(':moduleId/trial')
  @RequirePermissions('module:write', 'run:execute', 'target:read')
  async trial(
    @Param('moduleId') id: string,
    @Body(new ZodValidationPipe(moduleTrialRunBodySchema.optional())) body: ModuleTrialRunBody | undefined,
    @CurrentAccount() actor: RequestAccount,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { detail, created } = await this.actionModules.trial(id, body, actor)
    res.status(created ? HttpStatus.CREATED : HttpStatus.OK)
    return detail
  }
}
