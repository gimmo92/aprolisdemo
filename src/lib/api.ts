import type { Part } from '../data/catalog'

export type CatalogInfo = {
  id: string
  brand: string
  model: string
  version: string
  customer: string
  orderReference: string
  serialNumbers: string[]
  documentName: string
  documentPages: number
  partCount: number
  pdfAvailable?: boolean
}

export type ChatHistoryItem = {
  role: 'user' | 'assistant'
  content: string
}

export type CatalogPart = {
  code: string
  description: string
  originalDescription: string
  quantity: number
  item: string
  page: number
  category: string
  sourceType: 'mechanical' | 'electrical' | 'generic'
  assemblyCode?: string
  assemblyTitle?: string
  catalogId?: string
  catalogName?: string
  documentName?: string
  documentPages?: number
  pdfAvailable?: boolean
}

export type PartsIndexResponse = {
  catalog: CatalogInfo
  parts: CatalogPart[]
  filters: {
    categories: string[]
    sourceTypes: Array<'mechanical' | 'electrical' | 'generic'>
    pageMin: number
    pageMax: number
  }
}

export type ExplodedCallout = {
  id: string
  label: string
  items: string[]
  x: number
  y: number
  tipX: number
  tipY: number
  traced: boolean
}

export type ExplodedViewSummary = {
  id: string
  catalogId: string
  machine: string
  figureCode: string
  title: string
  pageIndex: number
  partsPages: number[]
  assetType: 'svg' | 'png'
  viewW: number
  viewH: number
  traceRate: number
}

export type ExplodedViewResponse = {
  view: ExplodedViewSummary
  svg?: string
  imageUrl?: string
  callouts: ExplodedCallout[]
  parts: CatalogPart[]
}

type ChatResponse = {
  answer: string
  parts: Part[]
  catalog: {
    id: string
    model: string
    version: string
    serial: string
    documentName: string
    documentPages: number
    partCount: number
  }
  model: string
}

export class ApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function apiFetch<T>(
  path: string,
  init?: RequestInit,
  options?: { timeoutMs?: number },
): Promise<T> {
  const controller = new AbortController()
  const timeoutMs = options?.timeoutMs ?? 30_000
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(path, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...init?.headers,
      },
      signal: controller.signal,
    })
    const body = (await response.json()) as T & { error?: string }
    if (!response.ok) {
      throw new ApiError(body.error || 'Errore durante la richiesta.', response.status)
    }
    return body
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ApiError('La ricerca sta impiegando troppo tempo. Riprova.', 408)
    }
    throw new ApiError('Impossibile contattare il servizio ricambi.', 0)
  } finally {
    window.clearTimeout(timeout)
  }
}

export type CatalogLookupResponse = {
  catalog: CatalogInfo
  serial: string
  resolvedBy: 'serial' | 'model' | 'name'
  matchedLabel: string
}

export async function identifyCatalog(query: string) {
  return apiFetch<CatalogLookupResponse>(
    `/api/catalog?q=${encodeURIComponent(query)}`,
  )
}

export function getIndexedParts(serial?: string) {
  return apiFetch<PartsIndexResponse>(
    serial
      ? `/api/parts?serial=${encodeURIComponent(serial)}`
      : '/api/parts?scope=all',
  )
}

export function getExplodedViews() {
  return apiFetch<{ views: ExplodedViewSummary[] }>('/api/exploded')
}

export function getExplodedView(viewId: string) {
  return apiFetch<ExplodedViewResponse>(
    `/api/exploded?viewId=${encodeURIComponent(viewId)}`,
  )
}

export function getCatalogStats() {
  return apiFetch<{ stats: { catalogs: number; parts: number } }>('/api/catalog')
}

export function askPartsAssistant(
  serial: string,
  query: string,
  history: ChatHistoryItem[],
  image?: { base64: string; mediaType: 'image/jpeg' | 'image/png' | 'image/webp' },
) {
  return apiFetch<ChatResponse>(
    '/api/chat',
    {
      method: 'POST',
      body: JSON.stringify({
        serial,
        query,
        history,
        ...(image
          ? { imageBase64: image.base64, mediaType: image.mediaType }
          : {}),
      }),
    },
    { timeoutMs: image ? 55_000 : 30_000 },
  )
}
