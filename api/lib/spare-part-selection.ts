import type { IndexedPart } from './types.js'

export const MAX_SPARE_PARTS = 6

export type SparePartPick = {
  code: string
  confidence: number
}

export type SelectedSparePart = {
  part: IndexedPart
  confidence: number
}

function normalizeCode(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

function partKey(part: IndexedPart) {
  return `${part.code}|${part.item}|${part.page}`
}

function exactCodesInQuery(query: string, parts: IndexedPart[]) {
  const tokens = new Set(
    (query.toUpperCase().match(/[A-Z0-9][A-Z0-9._/-]{4,}/g) ?? []).map(normalizeCode),
  )
  if (!tokens.size) return []
  return parts.filter((part) => tokens.has(normalizeCode(part.code)))
}

export function selectSpareParts(
  query: string,
  retrieved: IndexedPart[],
  picks: SparePartPick[] | null | undefined,
) {
  const byCode = new Map<string, IndexedPart[]>()
  for (const part of retrieved) {
    const key = normalizeCode(part.code)
    const list = byCode.get(key) ?? []
    list.push(part)
    byCode.set(key, list)
  }

  const chosen = new Map<string, SelectedSparePart>()
  for (const part of exactCodesInQuery(query, retrieved)) {
    chosen.set(partKey(part), { part, confidence: 100 })
  }

  for (const pick of picks ?? []) {
    const confidence = Math.round(pick.confidence)
    if (!Number.isFinite(confidence) || confidence < 50 || confidence > 100) continue
    const matches = byCode.get(normalizeCode(pick.code)) ?? []
    for (const part of matches) {
      const key = partKey(part)
      const current = chosen.get(key)
      if (!current || confidence > current.confidence) {
        chosen.set(key, { part, confidence })
      }
    }
  }

  return [...chosen.values()]
    .sort(
      (left, right) =>
        right.confidence - left.confidence ||
        left.part.page - right.part.page ||
        left.part.item.localeCompare(right.part.item, 'it', { numeric: true }),
    )
    .slice(0, MAX_SPARE_PARTS)
}
