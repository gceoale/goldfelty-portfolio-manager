import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reportDue, REPORT_EVERY_MS, PARTIAL_AFTER_MS } from '../src/main/sharing.ts'

const now = 10 * PARTIAL_AFTER_MS

test('a complete total goes out every six hours', () => {
  assert.equal(reportDue({ now, lastReportAt: 0, lastWasPartial: false, degraded: false }), true)
  assert.equal(reportDue({ now, lastReportAt: now - REPORT_EVERY_MS + 1, lastWasPartial: false, degraded: false }), false)
  assert.equal(reportDue({ now, lastReportAt: now - REPORT_EVERY_MS, lastWasPartial: false, degraded: false }), true)
})

test('an incomplete refresh still shares when nothing has gone out yet', () => {
  // One failing chain or stale price used to keep a new sharer out for good.
  assert.equal(reportDue({ now, lastReportAt: 0, lastWasPartial: false, degraded: true }), true)
  assert.equal(reportDue({ now, lastReportAt: now - REPORT_EVERY_MS, lastWasPartial: false, degraded: true }), false)
  assert.equal(reportDue({ now, lastReportAt: now - PARTIAL_AFTER_MS, lastWasPartial: true, degraded: true }), true)
})

test('a complete total replaces an incomplete one straight away', () => {
  assert.equal(reportDue({ now, lastReportAt: now - 1000, lastWasPartial: true, degraded: false }), true)
})
