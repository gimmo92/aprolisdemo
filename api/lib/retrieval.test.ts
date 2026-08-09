import { describe, expect, it } from 'vitest'
import {
  findCatalog,
  getIndexStats,
  getPublicCatalog,
  searchParts,
} from './retrieval.js'

describe('catalog retrieval', () => {
  it('maps both supported serial numbers to the same catalog', () => {
    expect(findCatalog('13510073')?.id).toBe('charlatte-t135-ar197350')
    expect(findCatalog('13510074')?.id).toBe('charlatte-t135-ar197350')
    expect(findCatalog('99999999')).toBeUndefined()
  })

  it('exposes metadata without the full parts array', () => {
    const catalog = getPublicCatalog('13510073')
    expect(catalog?.partCount).toBeGreaterThan(550)
    expect(catalog).not.toHaveProperty('parts')
  })

  it('prioritizes an exact part code', () => {
    const results = searchParts('13510073', 'LROEX100008')
    expect(results[0]?.code).toBe('LROEX100008')
  })

  it('expands an Italian brake query across bilingual descriptions', () => {
    const results = searchParts('13510073', 'tubo freno')
    expect(results.some((part) => part.code === 'RFLXX100013')).toBe(true)
  })

  it('includes the curated electrical bill of materials', () => {
    const results = searchParts('13510074', 'fusibile 500A')
    expect(results[0]?.code).toBe('EFUXX100026')
  })

  it('never searches outside a verified serial number', () => {
    expect(searchParts('not-a-serial', 'brake')).toEqual([])
  })

  it('reports the generated and curated index size', () => {
    const stats = getIndexStats()
    expect(stats.catalogs).toBe(1)
    expect(stats.parts).toBeGreaterThanOrEqual(585)
  })
})
