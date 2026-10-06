import { catalog, type Part } from '../data/catalog'

export type CommercialKind = 'offerta' | 'ordine'

export type CommercialDocumentData = {
  id: string
  kind: CommercialKind
  number: string
  issuedAt: string
  validUntil: string
  customer: string
  brand: string
  model: string
  version: string
  orderReference: string
  serial?: string
  code: string
  description: string
  originalDescription: string
  item: string
  page: number
  category: string
  quantity: number
  unitPrice: number
  inStock: boolean
  stockQty: number
  vatRate: number
}

const STORAGE_KEY = 'aftercore-commercial-docs'

function hashCode(value: string) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export function demoAvailability(code: string) {
  const hash = hashCode(code || 'RICAMBIO')
  const inStock = hash % 10 < 7
  const stockQty = inStock ? (hash % 8) + 1 : 0
  const unitPrice = Math.round((28 + (hash % 740)) * 2) / 2
  return { inStock, stockQty, unitPrice }
}

function pad(value: number) {
  return String(value).padStart(2, '0')
}

function addDays(date: Date, days: number) {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next.toISOString()
}

function readAll(): Record<string, CommercialDocumentData> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, CommercialDocumentData>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function loadCommercialDocument(id: string) {
  return readAll()[id]
}

export function buildCommercialDocument(
  kind: CommercialKind,
  part: Part,
  serial?: string,
): CommercialDocumentData {
  const availability = demoAvailability(part.code)
  const issued = new Date()
  const prefix = kind === 'offerta' ? 'OFF' : 'ORD'
  const number = `${prefix}-${issued.getFullYear()}${pad(issued.getMonth() + 1)}${pad(issued.getDate())}-${String(issued.getTime()).slice(-4)}`
  return {
    id: crypto.randomUUID(),
    kind,
    number,
    issuedAt: issued.toISOString(),
    validUntil: addDays(issued, kind === 'offerta' ? 30 : availability.inStock ? 2 : 12),
    customer: catalog.customer,
    brand: catalog.brand,
    model: catalog.model,
    version: catalog.version,
    orderReference: catalog.orderReference,
    serial,
    code: part.code,
    description: part.description,
    originalDescription: part.originalDescription,
    item: part.item,
    page: part.page,
    category: part.category,
    quantity: 1,
    unitPrice: availability.unitPrice,
    inStock: availability.inStock,
    stockQty: availability.stockQty,
    vatRate: 0.22,
  }
}

export function openCommercialDocument(kind: CommercialKind, part: Part, serial?: string) {
  const document = buildCommercialDocument(kind, part, serial)
  const stored = readAll()
  stored[document.id] = document
  const recent = Object.values(stored)
    .sort((left, right) => right.issuedAt.localeCompare(left.issuedAt))
    .slice(0, 20)
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify(Object.fromEntries(recent.map((item) => [item.id, item]))),
  )
  const url = new URL(window.location.href)
  url.search = ''
  url.hash = ''
  url.searchParams.set('doc', document.id)
  window.open(url.toString(), '_blank', 'noopener,noreferrer')
}

export function formatEuro(value: number) {
  return new Intl.NumberFormat('it-IT', {
    style: 'currency',
    currency: 'EUR',
  }).format(value)
}

export function formatDocumentDate(value: string) {
  return new Intl.DateTimeFormat('it-IT', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  }).format(new Date(value))
}
