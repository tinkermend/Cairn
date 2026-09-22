import { z } from 'zod'
import { entityIdSchema, jsonValueSchema, utcInstantSchema } from './wire.js'
import { dataGeneratorSpecSchema } from './data-generator.js'
import { scenarioInputDeclSchema, scenarioInputTypeSchema } from './step.js'

export const DATASET_STATUSES = ['active', 'archived'] as const
export type DatasetStatus = (typeof DATASET_STATUSES)[number]
export const datasetStatusSchema = z.enum(DATASET_STATUSES)

export const DATASET_SOURCE_TYPES = ['excel', 'csv', 'table'] as const
export type DatasetSourceType = (typeof DATASET_SOURCE_TYPES)[number]
export const datasetSourceTypeSchema = z.enum(DATASET_SOURCE_TYPES)

export const DATASET_ROW_VALID_STATUSES = ['valid', 'warning', 'error'] as const
export type DatasetRowValidStatus = (typeof DATASET_ROW_VALID_STATUSES)[number]
export const datasetRowValidStatusSchema = z.enum(DATASET_ROW_VALID_STATUSES)

export const datasetColumnSchema = z.strictObject({
  name: z.string().min(1).max(128),
  key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
  type: scenarioInputTypeSchema,
  sampleValues: z.array(z.string()).max(5).default([]),
})
export type DatasetColumn = z.infer<typeof datasetColumnSchema>

export const dataBindingRuleSchema = z.discriminatedUnion('source', [
  z.strictObject({
    source: z.literal('column'),
    columnName: z.string().min(1),
  }),
  z.strictObject({
    source: z.literal('generator'),
    spec: dataGeneratorSpecSchema,
  }),
  z.strictObject({
    source: z.literal('fixed'),
    value: jsonValueSchema,
  }),
])
export type DataBindingRule = z.infer<typeof dataBindingRuleSchema>

export const dataBindingSchema = z.record(z.string(), dataBindingRuleSchema)
export type DataBinding = z.infer<typeof dataBindingSchema>

export const createDatasetBodySchema = z.strictObject({
  name: z.string().trim().min(1).max(128),
  targetId: entityIdSchema,
  sourceType: datasetSourceTypeSchema,
  sourceFilename: z.string().max(255),
  selectedSheet: z.string().max(128).optional(),
  columns: z.array(datasetColumnSchema),
  rows: z.array(z.record(z.string(), jsonValueSchema)).min(1).max(10000),
})
export type CreateDatasetBody = z.infer<typeof createDatasetBodySchema>

export const datasetDetailSchema = z.strictObject({
  id: entityIdSchema,
  name: z.string(),
  targetId: entityIdSchema,
  sourceType: datasetSourceTypeSchema,
  sourceFilename: z.string(),
  selectedSheet: z.string().nullable().optional(),
  rowCount: z.number().int().nonnegative(),
  columns: z.array(datasetColumnSchema),
  createdByAccountId: entityIdSchema,
  createdAt: utcInstantSchema,
  updatedAt: utcInstantSchema,
})
export type DatasetDetail = z.infer<typeof datasetDetailSchema>

export const datasetListQuerySchema = z.strictObject({
  targetId: entityIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
  search: z.string().optional(),
})
export type DatasetListQuery = z.infer<typeof datasetListQuerySchema>

export const datasetListResponseSchema = z.strictObject({
  items: z.array(datasetDetailSchema),
  nextCursor: z.string().optional(),
})
export type DatasetListResponse = z.infer<typeof datasetListResponseSchema>

export const datasetRowDtoSchema = z.strictObject({
  id: entityIdSchema,
  datasetId: entityIdSchema,
  rowIndex: z.number().int().nonnegative(),
  rowData: z.record(z.string(), jsonValueSchema),
  validStatus: datasetRowValidStatusSchema,
})
export type DatasetRowDto = z.infer<typeof datasetRowDtoSchema>

export const datasetRowsQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
})
export type DatasetRowsQuery = z.infer<typeof datasetRowsQuerySchema>

export const datasetRowsResponseSchema = z.strictObject({
  items: z.array(datasetRowDtoSchema),
  total: z.number().int().nonnegative(),
  nextCursor: z.string().optional(),
})
export type DatasetRowsResponse = z.infer<typeof datasetRowsResponseSchema>

export const preflightIssueSchema = z.strictObject({
  rowIndex: z.number().int().nonnegative(),
  fieldKey: z.string(),
  severity: z.enum(['warning', 'error']),
  message: z.string(),
})
export type PreflightIssue = z.infer<typeof preflightIssueSchema>

export const preflightDatasetBodySchema = z.strictObject({
  scenarioInputs: z.array(scenarioInputDeclSchema),
  binding: dataBindingSchema,
  selectedRowIndices: z.array(z.number().int().nonnegative()).optional(),
})
export type PreflightDatasetBody = z.infer<typeof preflightDatasetBodySchema>

export const preflightResultSchema = z.strictObject({
  totalRows: z.number().int().nonnegative(),
  validCount: z.number().int().nonnegative(),
  warningCount: z.number().int().nonnegative(),
  errorCount: z.number().int().nonnegative(),
  issues: z.array(preflightIssueSchema),
})
export type PreflightResult = z.infer<typeof preflightResultSchema>

export const autoMapBodySchema = z.strictObject({
  scenarioInputs: z.array(scenarioInputDeclSchema),
})
export type AutoMapBody = z.infer<typeof autoMapBodySchema>

export const autoMapResultSchema = z.strictObject({
  binding: dataBindingSchema,
})
export type AutoMapResult = z.infer<typeof autoMapResultSchema>
