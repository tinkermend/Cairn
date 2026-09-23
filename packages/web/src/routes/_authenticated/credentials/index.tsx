import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/_authenticated/credentials/')({
  beforeLoad: () => {
    throw redirect({ to: '/targets', replace: true })
  },
  component: () => null,
})
