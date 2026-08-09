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
  sourceType: 'mechanical' | 'electrical'
  assemblyCode?: string
  assemblyTitle?: string
}

export type PartsIndexResponse = {
  catalog: CatalogInfo
  parts: CatalogPart[]
  filters: {
    categories: string[]
    sourceTypes: Array<'mechanical' | 'electrical'>
    pageMin: number
    pageMax: number
  }
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

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 30_000)

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

export async function identifyCatalog(serial: string) {
  const response = await apiFetch<{ catalog: CatalogInfo }>(
    `/api/catalog?serial=${encodeURIComponent(serial)}`,
  )
  return response.catalog
}

export function getIndexedParts(serial = '13510073') {
  return apiFetch<PartsIndexResponse>(
    `/api/parts?serial=${encodeURIComponent(serial)}`,
  )
}

export function askPartsAssistant(
  serial: string,
  query: string,
  history: ChatHistoryItem[],
) {
  return apiFetch<ChatResponse>('/api/chat', {
    method: 'POST',
    body: JSON.stringify({ serial, query, history }),
  })
}
