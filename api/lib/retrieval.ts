import rawIndex from '../../data/catalog-index.json' with { type: 'json' }
import { catalog as curatedCatalog } from '../../src/data/catalog.js'
import type {
  CatalogIndex,
  IndexedCatalog,
  IndexedPart,
  PublicCatalog,
} from './types.js'

const index = rawIndex as CatalogIndex

const synonymGroups = [
  ['freno', 'freni', 'brake', 'frein', 'freinage'],
  ['sterzo', 'direzione', 'steering', 'direction'],
  ['ruota', 'ruote', 'wheel', 'roue'],
  ['cuscinetto', 'bearing', 'roulement'],
  ['guarnizione', 'tenuta', 'seal', 'joint'],
  ['motore', 'motor', 'moteur'],
  ['sospensione', 'suspension', 'ammortizzatore', 'shock', 'absorber'],
  ['assale', 'axle', 'essieu'],
  ['vite', 'screw', 'vis'],
  ['rondella', 'washer', 'rondelle'],
  ['dado', 'nut', 'ecrou'],
  ['tubo', 'hose', 'pipe', 'flexible', 'tuyau'],
  ['connettore', 'connector', 'connecteur', 'presa', 'spina'],
  ['contatto', 'contact', 'pin', 'terminale'],
  ['fusibile', 'fuse'],
  ['faro', 'lampada', 'luce', 'light', 'bulb'],
  ['sensore', 'sensor', 'transmitter', 'capteur'],
  ['pedale', 'pedal', 'pedale'],
  ['centralina', 'controller', 'inverter'],
  ['cilindro', 'martinetto', 'cylinder', 'verin'],
  ['batteria', 'battery', 'batterie'],
] as const

export function normalize(value: string) {
  return value
    .toLocaleLowerCase('it')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function expandTerms(query: string) {
  const baseTerms = normalize(query).split(' ').filter((term) => term.length > 1)
  const expanded = new Set(baseTerms)

  for (const term of baseTerms) {
    for (const group of synonymGroups) {
      if (group.some((candidate) => normalize(candidate) === term)) {
        group.forEach((candidate) => expanded.add(normalize(candidate)))
      }
    }
  }

  return [...expanded]
}

function curatedParts(): IndexedPart[] {
  return curatedCatalog.parts.map((part) => ({
    ...part,
    assemblyCode: 'T0135M02750-02',
    assemblyTitle: 'Electrical parts list',
    sourceType: 'electrical' as const,
    searchText: normalize(
      [
        part.code,
        part.item,
        part.description,
        part.originalDescription,
        part.category,
        ...part.keywords,
      ].join(' '),
    ),
  }))
}

function withCuratedParts(catalog: IndexedCatalog): IndexedCatalog {
  const seen = new Set(
    catalog.parts.map((part) => `${part.code}|${part.item}|${part.page}`),
  )
  const additions = curatedParts().filter(
    (part) => !seen.has(`${part.code}|${part.item}|${part.page}`),
  )

  return {
    ...catalog,
    partCount: catalog.parts.length + additions.length,
    parts: [...catalog.parts, ...additions],
  }
}

const catalogs = index.catalogs.map(withCuratedParts)

export function findCatalog(serial: string) {
  const normalizedSerial = serial.replace(/\D/g, '')
  return catalogs.find((catalog) => catalog.serialNumbers.includes(normalizedSerial))
}

function toPublicCatalog(catalog: IndexedCatalog): PublicCatalog {
  return {
    id: catalog.id,
    brand: catalog.brand,
    model: catalog.model,
    version: catalog.version,
    customer: catalog.customer,
    orderReference: catalog.orderReference,
    serialNumbers: catalog.serialNumbers,
    documentName: catalog.documentName,
    documentPages: catalog.documentPages,
    partCount: catalog.partCount,
  }
}

export function getPublicCatalog(serial: string): PublicCatalog | undefined {
  const catalog = findCatalog(serial)
  if (!catalog) return undefined
  return toPublicCatalog(catalog)
}

export type CatalogLookupResult = {
  catalog: PublicCatalog
  serial: string
  resolvedBy: 'serial' | 'model' | 'name'
  matchedLabel: string
}

function catalogMatchScore(
  query: string,
  fields: {
    brand?: string
    model?: string
    version?: string
    documentName?: string
    orderReference?: string
    customer?: string
  },
) {
  const tokens = normalize(query)
    .split(' ')
    .filter((token) => token.length >= 2)
  if (!tokens.length) return 0

  const model = normalize(fields.model || '')
  const brand = normalize(fields.brand || '')
  const version = normalize(fields.version || '')
  const documentName = normalize(fields.documentName || '')
  const orderReference = normalize(fields.orderReference || '')
  const customer = normalize(fields.customer || '')
  const haystack = [brand, model, version, documentName, orderReference, customer]
    .filter(Boolean)
    .join(' ')

  let score = 0
  for (const token of tokens) {
    if (model && (model === token || model.includes(token) || token.includes(model))) {
      score += model === token ? 120 : 70
    }
    if (brand && (brand === token || brand.includes(token))) score += 35
    if (version && version.includes(token)) score += 25
    if (documentName && documentName.includes(token)) score += 30
    if (orderReference && orderReference.includes(token)) score += 20
    if (customer && customer.includes(token)) score += 10
    if (haystack.includes(token)) score += 5
  }
  return score
}

export function findLocalCatalogByLookup(
  query: string,
): CatalogLookupResult | undefined {
  const digits = query.replace(/\D/g, '')
  if (digits.length >= 4) {
    const bySerial = findCatalog(digits)
    if (bySerial) {
      return {
        catalog: toPublicCatalog(bySerial),
        serial: digits,
        resolvedBy: 'serial',
        matchedLabel: `${bySerial.brand} ${bySerial.model}`,
      }
    }
  }

  const ranked = catalogs
    .map((catalog) => {
      const score = catalogMatchScore(query, catalog)
      const resolvedBy: 'model' | 'name' = normalize(query)
        .split(' ')
        .some((token) => {
          const model = normalize(catalog.model)
          return (
            model &&
            (model === token || token.includes(model) || model.includes(token))
          )
        })
        ? 'model'
        : 'name'
      return { catalog, score, resolvedBy }
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)

  const best = ranked[0]
  const uniqueTop =
    best &&
    (best.score >= 60 ||
      (best.score >= 30 &&
        ranked.filter((entry) => entry.score === best.score).length === 1))
  if (!uniqueTop || !best?.catalog.serialNumbers[0]) return undefined
  return {
    catalog: toPublicCatalog(best.catalog),
    serial: best.catalog.serialNumbers[0],
    resolvedBy: best.resolvedBy,
    matchedLabel: `${best.catalog.brand} ${best.catalog.model}`,
  }
}

function scorePart(part: IndexedPart, query: string, terms: string[]) {
  const normalizedQuery = normalize(query)
  const code = normalize(part.code)
  const item = normalize(part.item)
  const description = normalize(part.description)
  const originalDescription = normalize(part.originalDescription)
  const category = normalize(part.category)
  let score = 0

  if (code === normalizedQuery) score += 200
  else if (code.includes(normalizedQuery)) score += 80
  if (description.includes(normalizedQuery)) score += 45
  if (originalDescription.includes(normalizedQuery)) score += 35

  for (const term of terms) {
    if (code === term) score += 60
    else if (code.includes(term)) score += 24
    if (item === term) score += 10
    if (description.includes(term)) score += 12
    if (originalDescription.includes(term)) score += 10
    if (category.includes(term)) score += 5
    if (part.searchText.includes(term)) score += 3
  }

  const originalTerms = normalize(query).split(' ').filter((term) => term.length > 1)
  const matchedOriginalTerms = originalTerms.filter((term) =>
    part.searchText.includes(term),
  ).length
  if (originalTerms.length && matchedOriginalTerms === originalTerms.length) {
    score += 30
  }

  return score
}

export function searchParts(serial: string, query: string, limit = 8) {
  const catalog = findCatalog(serial)
  if (!catalog) return []

  const terms = expandTerms(query)
  if (!terms.length) return []

  return catalog.parts
    .map((part) => ({ part, score: scorePart(part, query, terms) }))
    .filter(({ score }) => score >= 10)
    .sort((left, right) => right.score - left.score || left.part.page - right.part.page)
    .slice(0, Math.min(Math.max(limit, 1), 12))
    .map(({ part }) => part)
}

export type BundledPart = IndexedPart & {
  catalogId: string
  catalogName: string
  documentName: string
  documentPages: number
  pdfAvailable: boolean
}

function annotateCatalogParts(catalog: IndexedCatalog): BundledPart[] {
  return catalog.parts.map((part) => ({
    ...part,
    catalogId: catalog.id,
    catalogName: `${catalog.brand} · ${catalog.model}`,
    documentName: catalog.documentName,
    documentPages: catalog.documentPages,
    pdfAvailable: false,
  }))
}

export function getAllParts(serial: string) {
  const catalog = findCatalog(serial)
  if (!catalog) return undefined
  return {
    catalog: getPublicCatalog(serial)!,
    parts: annotateCatalogParts(catalog).sort(
      (left, right) =>
        left.page - right.page ||
        left.item.localeCompare(right.item, 'it', { numeric: true }) ||
        left.code.localeCompare(right.code),
    ),
  }
}

/** Bundled catalogs shaped for the admin catalog list. */
export function listBundledCatalogs(excludeDocumentNames: Iterable<string> = []) {
  const excluded = new Set(
    [...excludeDocumentNames].map((name) => name.trim().toLocaleLowerCase('it')),
  )
  return catalogs
    .filter(
      (catalog) =>
        !excluded.has(catalog.documentName.trim().toLocaleLowerCase('it')),
    )
    .map((catalog) => ({
      id: `bundled:${catalog.id}`,
      brand: catalog.brand,
      model: catalog.model,
      version: catalog.version,
      original_filename: catalog.documentName,
      storage_path: '',
      status: 'ready',
      page_count: catalog.documentPages,
      part_count: catalog.partCount,
      revision: catalog.orderReference || null,
      created_at: '',
      updated_at: '',
      source: 'bundled' as const,
      serial_numbers: catalog.serialNumbers,
      ingestion_jobs: [
        {
          id: `bundled-job:${catalog.id}`,
          status: 'completed',
          progress: 100,
          error_message: undefined,
          report: {
            deterministicParts: catalog.partCount,
            aiParts: 0,
            unresolvedPages: [],
            remainingAiPages: [],
            detectedMetadata: {
              missing: [],
            },
          },
          created_at: '',
          updated_at: '',
        },
      ],
    }))
}

/** All bundled demo catalogs (used when merging with Supabase-ready indexes). */
export function getAllBundledParts(excludeDocumentNames: Iterable<string> = []) {
  const excluded = new Set(
    [...excludeDocumentNames].map((name) => name.trim().toLocaleLowerCase('it')),
  )
  const selected = catalogs.filter(
    (catalog) => !excluded.has(catalog.documentName.trim().toLocaleLowerCase('it')),
  )
  if (!selected.length) return undefined

  const parts = selected.flatMap(annotateCatalogParts).sort(
    (left, right) =>
      left.catalogName.localeCompare(right.catalogName, 'it') ||
      left.page - right.page ||
      left.item.localeCompare(right.item, 'it', { numeric: true }) ||
      left.code.localeCompare(right.code),
  )

  return {
    catalog: {
      id: 'bundled-local',
      brand: 'Cataloghi locali',
      model: `${selected.length} cataloghi`,
      version: 'Indice demo incluso nel deploy',
      customer: '',
      orderReference: '',
      serialNumbers: selected.flatMap((catalog) => catalog.serialNumbers),
      documentName: `${selected.length} PDF`,
      documentPages: selected.reduce(
        (total, catalog) => total + catalog.documentPages,
        0,
      ),
      partCount: parts.length,
    } satisfies PublicCatalog,
    parts,
    catalogs: selected.map((catalog) => ({
      id: catalog.id,
      documentName: catalog.documentName,
      partCount: catalog.partCount,
    })),
  }
}

export function getIndexStats() {
  return {
    catalogs: catalogs.length,
    parts: catalogs.reduce((total, catalog) => total + catalog.partCount, 0),
    serialNumbers: catalogs.flatMap((catalog) => catalog.serialNumbers),
  }
}
