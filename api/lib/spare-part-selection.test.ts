import { describe, expect, it } from 'vitest'
import { selectSpareParts } from './spare-part-selection.js'
import type { IndexedPart } from './types.js'

function part(code: string, description: string, item = '1'): IndexedPart {
  return {
    code,
    description,
    originalDescription: description,
    quantity: 1,
    item,
    page: 10,
    category: 'Meccanica',
    sourceType: 'mechanical',
    searchText: `${code} ${description}`.toLowerCase(),
  }
}

const catalog = [
  part('EHAXX100010', 'Avvisatore acustico', 'HA1'),
  part('RRBXP000002', 'Sensore livello liquido freni', 'SL1'),
  part('ESPXX100001', 'Pressostato circuito', 'P1'),
]

describe('selectSpareParts', () => {
  it('keeps only catalog codes at confidence 50 or above, highest first', () => {
    const selected = selectSpareParts('sensore freno', catalog, [
      { code: 'RRBXP000002', confidence: 82 },
      { code: 'ESPXX100001', confidence: 49 },
      { code: 'INESISTENTE', confidence: 99 },
      { code: 'EHAXX100010', confidence: 91 },
    ])

    expect(selected.map((entry) => [entry.part.code, entry.confidence])).toEqual([
      ['EHAXX100010', 91],
      ['RRBXP000002', 82],
    ])
    expect(selected[0]?.part.description).toBe('Avvisatore acustico')
  })

  it('forces confidence 100 when the user typed the exact catalog code', () => {
    const selected = selectSpareParts('mi serve RRBXP000002', catalog, [
      { code: 'RRBXP000002', confidence: 60 },
    ])

    expect(selected).toEqual([
      { part: catalog[1], confidence: 100 },
    ])
  })

  it('returns no parts when nothing is credible', () => {
    expect(selectSpareParts('foto sfocata', catalog, null)).toEqual([])
    expect(
      selectSpareParts('foto sfocata', catalog, [{ code: 'EHAXX100010', confidence: 40 }]),
    ).toEqual([])
  })
})
