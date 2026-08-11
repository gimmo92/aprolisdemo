import { describe, expect, it } from 'vitest'
import {
  findCatalog,
  getAllBundledParts,
  getAllParts,
  getIndexStats,
  getPublicCatalog,
  listBundledCatalogs,
  searchParts,
} from './retrieval.js'

describe('catalog retrieval', () => {
  it('maps both supported serial numbers to the same catalog', () => {
    expect(findCatalog('13510073')?.id).toBe('charlatte-t135-ar197350')
    expect(findCatalog('13510074')?.id).toBe('charlatte-t135-ar197350')
    expect(findCatalog('99999999')).toBeUndefined()
  })

  it('resolves catalogs by machine or catalog name', async () => {
    const { findLocalCatalogByLookup } = await import('./retrieval.js')
    expect(findLocalCatalogByLookup('T135')?.catalog.model).toBe('T135')
    expect(
      findLocalCatalogByLookup('dammi tutti i sensori della macchina t135')
        ?.resolvedBy,
    ).toBe('model')
    expect(findLocalCatalogByLookup('charlatte')?.catalog.brand).toMatch(/Charlatte/i)
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

  it('exposes the bundled AR197350 parts for 13510073', () => {
    const result = getAllParts('13510073')
    expect(result?.parts.length).toBeGreaterThanOrEqual(585)
    expect(result?.parts[0]).toMatchObject({
      catalogId: 'charlatte-t135-ar197350',
      catalogName: 'Charlatte Manutention · T135',
      documentName: 't135_movincar_avio_global_services_ar197350_REV00.pdf',
    })
  })

  it('keeps bundled catalogs when they are not already in Supabase', () => {
    const all = getAllBundledParts()
    expect(all?.parts.length).toBeGreaterThanOrEqual(585)
    const excluded = getAllBundledParts([
      't135_movincar_avio_global_services_ar197350_REV00.pdf',
    ])
    expect(excluded).toBeUndefined()
  })

  it('lists the default bundled catalog for the admin UI', () => {
    const listed = listBundledCatalogs()
    expect(listed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'bundled:charlatte-t135-ar197350',
          brand: 'Charlatte Manutention',
          model: 'T135',
          status: 'ready',
          source: 'bundled',
          original_filename:
            't135_movincar_avio_global_services_ar197350_REV00.pdf',
        }),
      ]),
    )
    expect(listed[0]?.part_count).toBeGreaterThanOrEqual(585)
    expect(
      listBundledCatalogs([
        't135_movincar_avio_global_services_ar197350_REV00.pdf',
      ]),
    ).toEqual([])
  })
})
