import type {
  MapContentAvailability,
  MapObservation,
  MapProjectionPlan,
  MapQueryRequest,
  MapQueryResult,
  MapQueryView,
  MapVerification,
} from '@cairn/shared'

export type MapFactPageItem =
  | {
      type: 'observation'
      ingestSeq: number
      observation: MapObservation
      contentAvailability: MapContentAvailability
    }
  | {
      type: 'verification'
      ingestSeq: number
      verification: MapVerification
      contentAvailability: MapContentAvailability
    }

export type FactReader = {
  readFacts(input: {
    targetId: string
    afterSeq?: number
    throughSeq?: number
    limit?: number
  }): Promise<{
    facts: MapFactPageItem[]
    committedSeq: number
    throughSeq: number
  }>
}

export type ProjectionWriter = {
  commit(input: {
    projectionId: string
    expectedCursor: number
    expectedRevision: number
    plan: MapProjectionPlan
  }): Promise<{ cursor: number; revision: number }>
}

export type MapQueryPort = {
  loadView(request: MapQueryRequest): Promise<MapQueryView>
  query(request: MapQueryRequest): Promise<MapQueryResult>
}
