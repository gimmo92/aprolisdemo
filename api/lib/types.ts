export type IndexedPart = {
  code: string
  description: string
  originalDescription: string
  quantity: number
  item: string
  page: number
  category: string
  assemblyCode?: string
  assemblyTitle?: string
  sourceType: 'mechanical' | 'electrical'
  searchText: string
}

export type IndexedCatalog = {
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
  parts: IndexedPart[]
}

export type CatalogIndex = {
  version: number
  catalogs: IndexedCatalog[]
}

export type PublicCatalog = Omit<IndexedCatalog, 'parts'> & {
  partCount: number
}

export type ChatHistoryItem = {
  role: 'user' | 'assistant'
  content: string
}
