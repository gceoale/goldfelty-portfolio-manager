/** How often a shared total is sent to goldfelty.com. */
export const REPORT_EVERY_MS = 6 * 3600_000

/**
 * A total with a failed chain or a stale price is still sent when nothing has
 * gone out for this long (or ever), so one flaky network can't keep a user
 * who turned sharing on out of the totals for good.
 */
export const PARTIAL_AFTER_MS = 24 * 3600_000

export interface ReportState {
  now: number
  lastReportAt: number
  /** The last total sent was from an incomplete refresh. */
  lastWasPartial: boolean
  /** This refresh is incomplete. */
  degraded: boolean
}

export function reportDue({ now, lastReportAt, lastWasPartial, degraded }: ReportState): boolean {
  const since = now - lastReportAt
  if (degraded) return since >= PARTIAL_AFTER_MS
  // A complete total replaces an incomplete one straight away.
  return lastWasPartial || since >= REPORT_EVERY_MS
}
