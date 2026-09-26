import { LOCATOR_ROUTE_LABELS, LOCATOR_SKIP_LABELS, type LocatorRoute, type LocatorSkip } from '@cairn/shared'

export function locatorRouteListLabel(routes: readonly LocatorRoute[]): string {
  return routes.map((route) => LOCATOR_ROUTE_LABELS[route]).join(' → ')
}

export function locatorSkippedLabel(skipped: readonly LocatorSkip[]): string {
  return skipped.map(({ route, reason }) => `${LOCATOR_ROUTE_LABELS[route]}（${LOCATOR_SKIP_LABELS[reason]}）`).join('、')
}
