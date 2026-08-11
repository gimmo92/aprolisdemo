import { describe, expect, it } from 'vitest'
import { fallbackHotspots, scoreHotspotCandidate } from './hotspotLayout'

describe('fallbackHotspots', () => {
  it('places unique item markers in normalized coordinates', () => {
    const hotspots = fallbackHotspots(['1', '2', '2', ' 3 '])
    expect(hotspots).toHaveLength(3)
    expect(hotspots.every((spot) => spot.synthetic)).toBe(true)
    expect(hotspots[0]).toMatchObject({ item: '1', x: 0.08 })
    expect(hotspots.every((spot) => spot.x >= 0 && spot.x <= 1)).toBe(true)
    expect(hotspots.every((spot) => spot.y >= 0 && spot.y <= 1)).toBe(true)
  })

  it('prefers dispersed drawing labels over repeated table columns', () => {
    const drawing = Array.from({ length: 20 }, (_, index) => ({
      item: String(index + 1),
      x: 0.08 + (index % 10) * 0.085,
    }))
    const table = drawing.flatMap((match) => [
      { ...match, x: 0.15 },
      { item: '1', x: 0.75 },
    ])

    expect(scoreHotspotCandidate(drawing)).toBeGreaterThan(
      scoreHotspotCandidate(table),
    )
  })
})
