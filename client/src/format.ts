export function bytes(n: number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (n >= 1024 && i < units.length - 1) (n /= 1024), i++
  return `${i === 0 ? n : n.toFixed(n >= 100 ? 0 : 1)} ${units[i]}`
}

export const dateOf = (t: number) => new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
export const daysLeft = (t: number) => Math.max(0, Math.ceil((t - Date.now()) / 86_400_000))
