/** Calendar months from a timestamp (ms), clamped to the end of shorter months (Jan 31 + 1 month = Feb 28/29). */
export function addMonths(from: number, months: number): number {
  const d = new Date(from)
  const day = d.getUTCDate()
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() + months)
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
  d.setUTCDate(Math.min(day, last))
  return d.getTime()
}

/** Months of paid time left from `now`, rounded up (a 3-month gift still reads 3 a moment later); 0 once it has passed. */
export function monthsLeft(paidThrough: number, now = Date.now()): number {
  if (paidThrough <= now) return 0
  let n = 1
  while (addMonths(now, n) < paidThrough) n++
  return n
}

/** What accounts that existed before pre-paid time was introduced were given. */
export const GRANDFATHERED_MONTHS = 999
/** The most one invite or gift can grant. */
export const MAX_GIFT_MONTHS = 999
