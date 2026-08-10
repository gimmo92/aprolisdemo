import { describe, expect, it } from 'vitest'
import { fallbackHotspots } from './pdfHotspots'

describe('fallbackHotspots', () => {
  it('places unique item markers in normalized coordinates', () => {
    const hotspots = fallbackHotspots(['1', '2', '2', ' 3 '])
    expect(hotspots).toHaveLength(3)
    expect(hotspots.every((spot) => spot.synthetic)).toBe(true)
    expect(hotspots[0]).toMatchObject({ item: '1', x: 0.08 })
    expect(hotspots.every((spot) => spot.x >= 0 && spot.x <= 1)).toBe(true)
    expect(hotspots.every((spot) => spot.y >= 0 && spot.y <= 1)).toBe(true)
  })
})
