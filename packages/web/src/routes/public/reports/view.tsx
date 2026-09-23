import { z } from 'zod'
import { createFileRoute } from '@tanstack/react-router'
import { PublicReportViewPage } from '@/features/reports/public-view'

const searchSchema = z.object({
  token: z.string().default(''),
})

export const Route = createFileRoute('/public/reports/view')({
  component: PublicReportViewPage,
  validateSearch: searchSchema,
})
