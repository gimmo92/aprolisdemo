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

export function getPublicCatalog(serial: string): PublicCatalog | undefined {
  const catalog = findCatalog(serial)
  if (!catalog) return undefined
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

export function getAllParts(serial: string) {
  const catalog = findCatalog(serial)
  if (!catalog) return undefined
  return {
    catalog: getPublicCatalog(serial)!,
    parts: [...catalog.parts].sort(
      (left, right) =>
        left.page - right.page ||
        left.item.localeCompare(right.item, 'it', { numeric: true }) ||
        left.code.localeCompare(right.code),
    ),
  }
}

export function getIndexStats() {
  return {
    catalogs: catalogs.length,
    parts: catalogs.reduce((total, catalog) => total + catalog.partCount, 0),
    serialNumbers: catalogs.flatMap((catalog) => catalog.serialNumbers),
  }
}
