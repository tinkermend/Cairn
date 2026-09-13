import { ForbiddenException, ServiceUnavailableException, BadRequestException, ConflictException, NotFoundException } from '@nestjs/common'
import { DomainError } from '@cairn/db'

function domainBody(domain: DomainError) {
  return {
    code: domain.code,
    message: domain.message,
    ...(domain.details !== undefined ? { details: domain.details } : {}),
  }
}

export function rethrowDomain(error: unknown): never {
  const domain = error instanceof DomainError ? error : undefined
  if (domain) {
    if (domain.kind === 'forbidden') throw new ForbiddenException(domainBody(domain))
    if (domain.kind === 'unavailable') throw new ServiceUnavailableException()
    if (domain.kind === 'not_found') {
      throw new NotFoundException(domainBody(domain))
    }
    if (domain.kind === 'conflict') {
      throw new ConflictException(domainBody(domain))
    }
    throw new BadRequestException(domainBody(domain))
  }
  throw error
}
