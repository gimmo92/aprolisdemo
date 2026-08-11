export type Hotspot = {
  item: string
  x: number
  y: number
  synthetic?: boolean
}

function normalizeItem(value: string) {
  return value.trim().toUpperCase()
}

export function fallbackHotspots(items: string[]): Hotspot[] {
  const unique = [...new Set(items.map(normalizeItem).filter(Boolean))]
  const columns = unique.length > 8 ? 2 : 1
  const rows = Math.max(1, Math.ceil(unique.length / columns))
  return unique.map((item, index) => {
    const column = index % columns
    const row = Math.floor(index / columns)
    return {
      item,
      x: 0.08 + column * 0.12,
      y: 0.12 + ((row + 0.5) * 0.76) / rows,
      synthetic: true,
    }
  })
}
