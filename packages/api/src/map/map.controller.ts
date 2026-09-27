import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common'
import {
  mapBindingRemoveBodySchema,
  mapGovernanceCommandBodySchema,
  mapGovernancePreviewBodySchema,
  mapImpactQuerySchema,
  mapListQuerySchema,
  mapAtlasPagesQuerySchema,
  mapMatchQuerySchema,
  mapPublicationBodySchema,
  mapScenarioBindingBodySchema,
  mapSealPublishBodySchema,
  mapConsumptionEligibilityGrantBodySchema,
  mapConsumptionPolicyUpdateBodySchema,
  mapJobPolicyUpdateBodySchema,
  targetStateRuleQueryParamsUpdateBodySchema,
  mapMenuEntryCreateBodySchema,
  mapMenuEntryUpdateBodySchema,
  mapMenuEntryArchiveBodySchema,
  mapMenuEntryReorderBodySchema,
  mapIngestCreateBodySchema,
  mapIngestJobListQuerySchema,
  mapIngestSurfaceQuerySchema,
  targetKnowledgeContextQuerySchema,
  type MapConsumptionEligibilityGrantBody,
  type MapConsumptionPolicyUpdateBody,
  type MapJobPolicyUpdateBody,
  type TargetStateRuleQueryParamsUpdateBody,
  type MapMenuEntryCreateBody,
  type MapMenuEntryUpdateBody,
  type MapMenuEntryArchiveBody,
  type MapMenuEntryReorderBody,
  type MapIngestCreateBody,
  type MapIngestJobListQuery,
  type MapIngestSurfaceQuery,
  type TargetKnowledgeContextQuery,
  createTerminologyBodySchema,
  retireTerminologyBodySchema,
  terminologyListQuerySchema,
  terminologyMatchQuerySchema,
  updateTerminologyBodySchema,
  type MapBindingRemoveBody,
  type MapGovernanceCommandBody,
  type MapGovernancePreviewBody,
  type MapImpactQuery,
  type MapListQuery,
  type MapAtlasPagesQuery,
  type MapMatchQuery,
  type MapPublicationBody,
  type MapScenarioBindingBody,
  type MapSealPublishBody,
  type CreateTerminologyBody,
  type RetireTerminologyBody,
  type TerminologyListQuery,
  type TerminologyMatchQuery,
  type UpdateTerminologyBody,
} from '@cairn/shared'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import type { RequestAccount } from '../common/request-account'
import { CurrentAccount } from '../rbac/current-account.decorator'
import { RequirePermissions } from '../rbac/require-permission.decorator'
import { MapService } from './map.service'

@Controller('targets/:targetId/map')
export class MapController {
  constructor(private readonly maps: MapService) {}

  @Get('summary')
  @RequirePermissions('target:read', 'map:read')
  summary(
    @Param('targetId') targetId: string,
    @Query(new ZodValidationPipe(mapListQuerySchema)) query: MapListQuery,
  ) {
    return this.maps.summary(targetId, query)
  }

  @Get('atlas/pages')
  @RequirePermissions('target:read', 'map:read')
  atlasPages(
    @Param('targetId') targetId: string,
    @Query(new ZodValidationPipe(mapAtlasPagesQuerySchema)) query: MapAtlasPagesQuery,
  ) {
    return this.maps.listAtlasPages(targetId, query)
  }

  @Get('pages')
  @RequirePermissions('target:read', 'map:read')
  pages(
    @Param('targetId') targetId: string,
    @Query(new ZodValidationPipe(mapListQuerySchema)) query: MapListQuery,
  ) {
    return this.maps.listPages(targetId, query)
  }

  @Get('objects')
  @RequirePermissions('target:read', 'map:read')
  objects(
    @Param('targetId') targetId: string,
    @Query(new ZodValidationPipe(mapListQuerySchema)) query: MapListQuery,
  ) {
    return this.maps.listObjects(targetId, query)
  }

  @Get('objects/:objectId')
  @RequirePermissions('target:read', 'map:read')
  objectDetail(
    @Param('targetId') targetId: string,
    @Param('objectId') objectId: string,
    @Query(new ZodValidationPipe(mapListQuerySchema)) query: MapListQuery,
  ) {
    return this.maps.getObject(targetId, objectId, query)
  }

  @Get('match')
  @RequirePermissions('target:read', 'map:read')
  match(
    @Param('targetId') targetId: string,
    @Query(new ZodValidationPipe(mapMatchQuerySchema)) query: MapMatchQuery,
  ) {
    return this.maps.match(targetId, query)
  }

  @Get('observations/:id')
  @RequirePermissions('target:read', 'map:read')
  observation(
    @Param('targetId') targetId: string,
    @Param('id') id: string,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.maps.getFact(targetId, 'observation', id, account)
  }

  @Get('verifications/:id')
  @RequirePermissions('target:read', 'map:read')
  verification(
    @Param('targetId') targetId: string,
    @Param('id') id: string,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.maps.getFact(targetId, 'verification', id, account)
  }

  @Get('changes')
  @RequirePermissions('target:read', 'map:read')
  changes(
    @Param('targetId') targetId: string,
    @Query(new ZodValidationPipe(mapListQuerySchema)) query: MapListQuery,
  ) {
    return this.maps.listChanges(targetId, query)
  }

  @Get('commands/:commandId')
  @RequirePermissions('target:read', 'map:read')
  command(
    @Param('targetId') targetId: string,
    @Param('commandId') commandId: string,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.maps.getCommand(targetId, commandId, account)
  }

  @Post('governance/preview')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('target:read', 'map:read', 'map:review')
  preview(
    @Param('targetId') targetId: string,
    @Body(new ZodValidationPipe(mapGovernancePreviewBodySchema)) body: MapGovernancePreviewBody,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.maps.preview(targetId, body, account)
  }

  @Post('governance/commands')
  @RequirePermissions('target:read', 'map:read', 'map:review')
  submitCommand(
    @Param('targetId') targetId: string,
    @Body(new ZodValidationPipe(mapGovernanceCommandBodySchema)) body: MapGovernanceCommandBody,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.maps.command(targetId, body, account)
  }

  @Post('projections/rebuild')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('target:read', 'map:read', 'map:review')
  rebuild(@Param('targetId') targetId: string, @CurrentAccount() account: RequestAccount) {
    return this.maps.rebuild(targetId, account)
  }

  @Get('releases')
  @RequirePermissions('target:read', 'map:read')
  releases(
    @Param('targetId') targetId: string,
    @Query(new ZodValidationPipe(mapListQuerySchema)) query: MapListQuery,
  ) {
    return this.maps.listReleases(targetId, query)
  }

  @Get('releases/:releaseId')
  @RequirePermissions('target:read', 'map:read')
  release(@Param('targetId') targetId: string, @Param('releaseId') releaseId: string) {
    return this.maps.getRelease(targetId, releaseId)
  }

  @Post('releases')
  @RequirePermissions('target:read', 'map:read', 'map:publish')
  seal(
    @Param('targetId') targetId: string,
    @Body(new ZodValidationPipe(mapSealPublishBodySchema)) body: MapSealPublishBody,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.maps.sealAndPublish(targetId, body, account)
  }

  @Post('releases/:releaseId/publish')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('target:read', 'map:read', 'map:publish')
  publish(
    @Param('targetId') targetId: string,
    @Param('releaseId') releaseId: string,
    @Body(new ZodValidationPipe(mapPublicationBodySchema)) body: MapPublicationBody,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.maps.publish(targetId, releaseId, body, account)
  }

  @Post('releases/:releaseId/withdraw')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('target:read', 'map:read', 'map:publish')
  withdraw(
    @Param('targetId') targetId: string,
    @Param('releaseId') releaseId: string,
    @Body(new ZodValidationPipe(mapPublicationBodySchema)) body: MapPublicationBody,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.maps.withdraw(targetId, releaseId, body, account)
  }

  @Get('references')
  @RequirePermissions('target:read', 'map:read')
  references(
    @Param('targetId') targetId: string,
    @Query(new ZodValidationPipe(mapListQuerySchema)) query: MapListQuery,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.maps.listReferences(targetId, query, account)
  }

  @Get('impacts')
  @RequirePermissions('target:read', 'map:read')
  impacts(
    @Param('targetId') targetId: string,
    @Query(new ZodValidationPipe(mapImpactQuerySchema)) query: MapImpactQuery,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.maps.listImpacts(targetId, query, account)
  }

  @Get('consumption-policy')
  @RequirePermissions('target:read', 'map:read')
  consumptionPolicy(@Param('targetId') targetId: string) {
    return this.maps.consumptionPolicy(targetId)
  }

  @Post('consumption-eligibility')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('target:read', 'map:read', 'map:publish')
  grantConsumptionEligibility(
    @Param('targetId') targetId: string,
    @Body(new ZodValidationPipe(mapConsumptionEligibilityGrantBodySchema)) body: MapConsumptionEligibilityGrantBody,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.maps.grantConsumptionEligibility(targetId, body, account)
  }

  @Post('consumption-policy')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('target:read', 'map:read', 'map:publish')
  updateConsumptionPolicy(
    @Param('targetId') targetId: string,
    @Body(new ZodValidationPipe(mapConsumptionPolicyUpdateBodySchema)) body: MapConsumptionPolicyUpdateBody,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.maps.updateConsumptionPolicy(targetId, body, account)
  }

  @Get('job-policy')
  @RequirePermissions('target:read', 'map:read')
  jobPolicy(@Param('targetId') targetId: string) {
    return this.maps.jobPolicy(targetId)
  }

  @Post('job-policy')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('map:maintain')
  updateJobPolicy(
    @Param('targetId') targetId: string,
    @Body(new ZodValidationPipe(mapJobPolicyUpdateBodySchema)) body: MapJobPolicyUpdateBody,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.maps.updateJobPolicy(targetId, body, account)
  }

  @Get('state-rule')
  @RequirePermissions('target:read', 'map:read')
  stateRule(@Param('targetId') targetId: string) {
    return this.maps.stateRule(targetId)
  }

  @Post('state-rule/query-params')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('map:maintain')
  updateStateRuleQueryParams(
    @Param('targetId') targetId: string,
    @Body(new ZodValidationPipe(targetStateRuleQueryParamsUpdateBodySchema)) body: TargetStateRuleQueryParamsUpdateBody,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.maps.updateStateRuleQueryParams(targetId, body, account)
  }

  @Get('entries')
  @RequirePermissions('target:read', 'map:read')
  menuEntries(@Param('targetId') targetId: string) {
    return this.maps.menuEntries(targetId)
  }

  @Post('entries')
  @RequirePermissions('map:maintain')
  createMenuEntry(
    @Param('targetId') targetId: string,
    @Body(new ZodValidationPipe(mapMenuEntryCreateBodySchema)) body: MapMenuEntryCreateBody,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.maps.createMenuEntry(targetId, body, account)
  }

  @Post('entries/reorder')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('map:maintain')
  reorderMenuEntries(
    @Param('targetId') targetId: string,
    @Body(new ZodValidationPipe(mapMenuEntryReorderBodySchema)) body: MapMenuEntryReorderBody,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.maps.reorderMenuEntries(targetId, body, account)
  }

  @Post('entries/:entryId/update')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('map:maintain')
  updateMenuEntry(
    @Param('targetId') targetId: string,
    @Param('entryId') entryId: string,
    @Body(new ZodValidationPipe(mapMenuEntryUpdateBodySchema)) body: MapMenuEntryUpdateBody,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.maps.updateMenuEntry(targetId, entryId, body, account)
  }

  @Post('entries/:entryId/archive')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('map:maintain')
  archiveMenuEntry(
    @Param('targetId') targetId: string,
    @Param('entryId') entryId: string,
    @Body(new ZodValidationPipe(mapMenuEntryArchiveBodySchema)) body: MapMenuEntryArchiveBody,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.maps.archiveMenuEntry(targetId, entryId, body, account)
  }

  @Get('ingestions')
  @RequirePermissions('target:read', 'map:read')
  ingestions(
    @Param('targetId') targetId: string,
    @Query(new ZodValidationPipe(mapIngestJobListQuerySchema)) query: MapIngestJobListQuery,
  ) {
    return this.maps.ingestions(targetId, query)
  }

  @Get('ingest-surface')
  @RequirePermissions('target:read', 'map:read')
  ingestSurface(
    @Param('targetId') targetId: string,
    @Query(new ZodValidationPipe(mapIngestSurfaceQuerySchema)) query: MapIngestSurfaceQuery,
  ) {
    return this.maps.ingestSurface(targetId, query)
  }

  @Post('ingestions')
  @RequirePermissions('map:maintain')
  createIngestion(
    @Param('targetId') targetId: string,
    @Body(new ZodValidationPipe(mapIngestCreateBodySchema)) body: MapIngestCreateBody,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.maps.createIngestion(targetId, body, account)
  }

  @Get('ingestions/:jobId')
  @RequirePermissions('target:read', 'map:read')
  ingestion(@Param('targetId') targetId: string, @Param('jobId') jobId: string) {
    return this.maps.ingestion(targetId, jobId)
  }

  @Post('ingestions/:jobId/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('map:maintain', 'map:read')
  cancelIngestion(
    @Param('targetId') targetId: string,
    @Param('jobId') jobId: string,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.maps.cancelIngestion(targetId, jobId, account)
  }

  @Get('knowledge-context')
  @RequirePermissions('target:read', 'map:read')
  knowledgeContext(
    @Param('targetId') targetId: string,
    @Query(new ZodValidationPipe(targetKnowledgeContextQuerySchema)) query: TargetKnowledgeContextQuery,
  ) {
    return this.maps.knowledgeContext(targetId, query)
  }

  @Get('runs/:runId/clues')
  @RequirePermissions('target:read', 'map:read', 'run:read')
  clues(@Param('targetId') targetId: string, @Param('runId') runId: string) {
    return this.maps.runClues(targetId, runId)
  }

  @Post('scenario-bindings')
  @RequirePermissions('target:read', 'map:read', 'workflow:write')
  bind(
    @Param('targetId') targetId: string,
    @Body(new ZodValidationPipe(mapScenarioBindingBodySchema)) body: MapScenarioBindingBody,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.maps.bind(targetId, body, account)
  }

  @Post('scenario-bindings/:bindingId/remove')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('target:read', 'map:read', 'workflow:write')
  unbind(
    @Param('targetId') targetId: string,
    @Param('bindingId') bindingId: string,
    @Body(new ZodValidationPipe(mapBindingRemoveBodySchema)) body: MapBindingRemoveBody,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.maps.unbind(targetId, bindingId, body, account)
  }

  @Post('reference-scans')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('target:read', 'map:read', 'map:review')
  scan(@Param('targetId') targetId: string, @CurrentAccount() account: RequestAccount) {
    return this.maps.startScan(targetId, account)
  }

  @Get('terms')
  @RequirePermissions('target:read', 'map:read')
  listTerms(
    @Param('targetId') targetId: string,
    @Query(new ZodValidationPipe(terminologyListQuerySchema)) query: TerminologyListQuery,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.maps.listTerms(targetId, query, account)
  }

  @Get('terms/match')
  @RequirePermissions('target:read', 'map:read')
  matchTerms(
    @Param('targetId') targetId: string,
    @Query(new ZodValidationPipe(terminologyMatchQuerySchema)) query: TerminologyMatchQuery,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.maps.matchTerms(targetId, query.alias, account)
  }

  @Get('terms/:termId')
  @RequirePermissions('target:read', 'map:read')
  getTerm(@Param('targetId') targetId: string, @Param('termId') termId: string, @CurrentAccount() account: RequestAccount) {
    return this.maps.getTerm(targetId, termId, account)
  }

  @Post('terms')
  @RequirePermissions('target:read', 'map:review')
  createTerm(
    @Param('targetId') targetId: string,
    @Body(new ZodValidationPipe(createTerminologyBodySchema)) body: CreateTerminologyBody,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.maps.createTerm(targetId, body, account)
  }

  @Post('terms/:termId/update')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('target:read', 'map:review')
  updateTerm(
    @Param('targetId') targetId: string,
    @Param('termId') termId: string,
    @Body(new ZodValidationPipe(updateTerminologyBodySchema)) body: UpdateTerminologyBody,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.maps.updateTerm(targetId, termId, body, account)
  }

  @Post('terms/:termId/retire')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('target:read', 'map:review')
  retireTerm(
    @Param('targetId') targetId: string,
    @Param('termId') termId: string,
    @Body(new ZodValidationPipe(retireTerminologyBodySchema)) body: RetireTerminologyBody,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.maps.retireTerm(targetId, termId, body, account)
  }
}
