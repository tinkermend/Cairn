import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common'
import {
  authoringObservationSubmitSchema,
  type AuthoringObservationSubmit,
} from '@cairn/shared'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import { RequirePermissions } from '../rbac/require-permission.decorator'
import { AuthoringService } from './authoring.service'

@Controller('authoring')
export class AuthoringController {
  constructor(private readonly authoring: AuthoringService) {}

  @Post('observations')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('workflow:write', 'target:read')
  submit(@Body(new ZodValidationPipe(authoringObservationSubmitSchema)) body: AuthoringObservationSubmit) {
    return this.authoring.normalizeObservation(body)
  }
}
