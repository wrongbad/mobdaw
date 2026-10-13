/** "Edited 3 minutes ago", "edited yesterday", "edited 12 oct 2026". */
export function edited(t: number, now = Date.now()) {
  const s = Math.max(0, (now - t) / 1000)
  if (s < 60) return 'edited just now'
  if (s < 3600) return `edited ${Math.floor(s / 60)} min ago`
  const d = new Date(t), today = new Date(now)
  const days = Math.round((new Date(today.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000)
  if (days === 0) return `edited today, ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
  if (days === 1) return 'edited yesterday'
  if (days < 7) return `edited ${days} days ago`
  return `edited ${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' }).toLowerCase()}`
}
