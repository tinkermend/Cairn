import { badRequest, conflict, notFound } from '../runs/errors.js'

export function knowledgeNotFound(message = '知识对象不存在'): never {
  throw notFound('KNOWLEDGE_NOT_FOUND', message)
}

export function knowledgeRevisionConflict(message = '术语或建议修订已变更'): never {
  throw conflict('KNOWLEDGE_REVISION_CONFLICT', message)
}

export function knowledgeIdempotencyConflict(message = '相同幂等键对应不同的知识请求'): never {
  throw conflict('KNOWLEDGE_IDEMPOTENCY_CONFLICT', message)
}

export function authoringProposalStale(message = '草稿已变化，请基于当前草稿重新生成'): never {
  throw conflict('AUTHORING_PROPOSAL_STALE', message)
}

export function authoringSchemaUnsupported(message = '本轮不接受编写文档 V2'): never {
  throw badRequest('AUTHORING_SCHEMA_UNSUPPORTED', message)
}
