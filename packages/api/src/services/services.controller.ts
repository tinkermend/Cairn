import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  SetMetadata,
} from '@nestjs/common'
import type { Request, Response } from 'express'
import {
  evidenceReleaseBodySchema,
  externalRunBodySchema,
  issueServiceCredentialSchema,
  serviceCallerBodySchema,
  serviceCredentialPolicySchema,
  servicePageQuerySchema,
  type ExternalRunBody,
  type IssueServiceCredential,
  type ServiceCallerBody,
  type ServiceCredentialPolicy,
  type ServicePageQuery,
  type ServicePrincipal,
  type ServiceScope,
} from '@cairn/shared'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import { CurrentAccount } from '../rbac/current-account.decorator'
import { RequirePermissions } from '../rbac/require-permission.decorator'
import type { RequestAccount } from '../common/request-account'
import { ServicesService } from './services.service'

export const IS_SERVICE_API = 'cairn:service-api'
export const SERVICE_REQUIRED_SCOPES = 'cairn:service-scopes'
const Scope = (...scopes: ServiceScope[]) => SetMetadata(SERVICE_REQUIRED_SCOPES, scopes)
declare module 'express' {
  interface Request {
    servicePrincipal?: ServicePrincipal
  }
}
const uuid = new ParseUUIDPipe()
const page = new ZodValidationPipe(servicePageQuerySchema)

@Controller('services')
export class ServicesController {
  constructor(private readonly services: ServicesService) {}
  @Get()
  @RequirePermissions('service:read')
  list(@Query(page) q: ServicePageQuery) {
    return this.services.list(q)
  }
  @Post()
  @RequirePermissions('service:write')
  create(
    @Body(new ZodValidationPipe(serviceCallerBodySchema)) body: ServiceCallerBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.services.save(null, body, actor)
  }
  @Get(':id')
  @RequirePermissions('service:read')
  get(@Param('id', uuid) id: string) {
    return this.services.get(id)
  }
  @Post(':id/update')
  @HttpCode(200)
  @RequirePermissions('service:write')
  update(
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(serviceCallerBodySchema)) body: ServiceCallerBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.services.save(id, body, actor)
  }
  @Post(':id/credentials')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions('service:write')
  issue(
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(issueServiceCredentialSchema)) body: IssueServiceCredential,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.services.issue(id, body, actor)
  }
  @Post(':id/credentials/:keyId/update')
  @HttpCode(200)
  @RequirePermissions('service:write')
  policy(
    @Param('id', uuid) id: string,
    @Param('keyId', uuid) keyId: string,
    @Body(new ZodValidationPipe(serviceCredentialPolicySchema)) body: ServiceCredentialPolicy,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.services.update(id, keyId, body, actor)
  }
  @Post(':id/credentials/:keyId/revoke')
  @HttpCode(200)
  @RequirePermissions('service:write')
  revoke(
    @Param('id', uuid) id: string,
    @Param('keyId', uuid) keyId: string,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.services.update(id, keyId, null, actor)
  }
  @Post('evidence/:runId/:evidenceId/release')
  @HttpCode(200)
  @RequirePermissions('service:write', 'run:read')
  release(
    @Param('runId', uuid) runId: string,
    @Param('evidenceId', uuid) evidenceId: string,
    @Body(new ZodValidationPipe(evidenceReleaseBodySchema)) body: { allowed: boolean },
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.services.release(runId, evidenceId, body.allowed, actor)
  }
}
@Controller('open/v1')
@SetMetadata(IS_SERVICE_API, true)
export class OpenExecutionController {
  constructor(private readonly services: ServicesService) {}
  @Get('targets')
  @Scope('run:execute')
  targets(@Req() req: Request, @Query(page) q: ServicePageQuery) {
    return this.services.catalog(req.servicePrincipal!, q)
  }
  @Get('targets/:id/scenarios')
  @Scope('run:execute')
  scenarios(@Req() req: Request, @Param('id', uuid) id: string, @Query(page) q: ServicePageQuery) {
    return this.services.catalog(req.servicePrincipal!, q, id)
  }
  @Post('runs')
  @Scope('run:execute')
  async create(
    @Req() req: Request,
    @Body(new ZodValidationPipe(externalRunBodySchema)) body: ExternalRunBody,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.services.create(req.servicePrincipal!, body, req.requestId!)
    res.status(result.created ? 201 : 200)
    return result.detail
  }
  @Get('runs')
  @Scope('run:read')
  list(@Req() req: Request, @Query(page) q: ServicePageQuery) {
    return this.services.runs(req.servicePrincipal!, q)
  }
  @Get('runs/:id')
  @Scope('run:read')
  get(@Req() req: Request, @Param('id', uuid) id: string) {
    return this.services.run(req.servicePrincipal!, id)
  }
  @Post('runs/:id/cancel')
  @HttpCode(200)
  @Scope('run:cancel')
  cancel(@Req() req: Request, @Param('id', uuid) id: string) {
    return this.services.run(req.servicePrincipal!, id, true)
  }
  @Get('runs/:id/evidence')
  @Scope('run:read', 'evidence:read')
  evidence(@Req() req: Request, @Param('id', uuid) id: string, @Query(page) q: ServicePageQuery) {
    return this.services.evidence(req.servicePrincipal!, id, q)
  }
  @Get('runs/:id/evidence/:evidenceId/content')
  @Scope('run:read', 'evidence:read')
  async content(
    @Req() req: Request,
    @Param('id', uuid) id: string,
    @Param('evidenceId', uuid) evidenceId: string,
    @Res() res: Response,
  ) {
    const file = await this.services.content(req.servicePrincipal!, id, evidenceId)
    res
      .set({
        'Content-Type': file.contentType,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': 'attachment; filename="screenshot"',
      })
      .status(200)
      .send(Buffer.from(file.body))
  }
}
