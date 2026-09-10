import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common'
import { DomainError, mapPgRestriction } from '@cairn/db'

export function rethrowDomain(error: unknown): never {
  const domain = error instanceof DomainError ? error : mapPgRestriction(error)
  if (domain) {
    if (domain.kind === 'not_found') {
      throw new NotFoundException({ code: domain.code, message: domain.message })
    }
    if (domain.kind === 'conflict') {
      throw new ConflictException({ code: domain.code, message: domain.message })
    }
    throw new BadRequestException({ code: domain.code, message: domain.message })
  }
  throw error
}
