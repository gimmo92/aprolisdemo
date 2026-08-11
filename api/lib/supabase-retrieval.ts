import { getSupabaseAdmin, isSupabaseConfigured } from './supabase.js'
import type { IndexedPart, PublicCatalog } from './types.js'

type CatalogRow = {
  id: string
  brand: string
  model: string
  version: string | null
  customer: string | null
  order_reference: string | null
  storage_path: string
  original_filename: string
  page_count: number | null
  part_count: number | null
}

type PartRow = {
  code: string
  description: string
  original_description: string | null
  quantity: number | null
  item: string | null
  page_number: number
  category: string | null
  assembly_code: string | null
  assembly_title: string | null
  source_type: 'mechanical' | 'electrical' | 'generic'
}

type AllPartRow = PartRow & { catalog_id: string }

function mapPart(row: PartRow): IndexedPart {
  const description = row.description || row.original_description || 'Ricambio'
  return {
    code: row.code,
    description,
    originalDescription: row.original_description || description,
    quantity: row.quantity ?? 0,
    item: row.item || '',
    page: row.page_number,
    category: row.category || 'Ricambi',
    assemblyCode: row.assembly_code || undefined,
    assemblyTitle: row.assembly_title || undefined,
    sourceType: ['mechanical', 'electrical'].includes(row.source_type)
      ? row.source_type
      : 'generic',
    searchText: [
      row.code,
      description,
      row.original_description,
      row.item,
      row.category,
      row.assembly_code,
      row.assembly_title,
    ]
      .filter(Boolean)
      .join(' ')
      .toLocaleLowerCase('it'),
  }
}

function mapCatalog(row: CatalogRow, serials: string[]): PublicCatalog {
  return {
    id: row.id,
    brand: row.brand,
    model: row.model,
    version: row.version || row.model,
    customer: row.customer || '',
    orderReference: row.order_reference || '',
    serialNumbers: serials,
    documentName: row.original_filename,
    documentPages: row.page_count || 0,
    partCount: row.part_count || 0,
  }
}

export async function findSupabaseCatalog(serial: string) {
  if (!isSupabaseConfigured()) return undefined
  const normalized = serial.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
  const supabase = getSupabaseAdmin()
  const { data: serialRow, error } = await supabase
    .from('catalog_serials')
    .select('catalog_id, catalogs!inner(*)')
    .eq('normalized_serial', normalized)
    .eq('catalogs.status', 'ready')
    .limit(1)
    .maybeSingle()

  if (error || !serialRow?.catalogs) return undefined
  const catalog = serialRow.catalogs as unknown as CatalogRow
  const { data: serials } = await supabase
    .from('catalog_serials')
    .select('serial_number')
    .eq('catalog_id', catalog.id)

  return {
    catalog: mapCatalog(
      catalog,
      (serials || []).map((row) => row.serial_number),
    ),
    storagePath: catalog.storage_path,
  }
}

function normalizeLookup(value: string) {
  return value
    .toLocaleLowerCase('it')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function scoreSupabaseCatalog(query: string, catalog: CatalogRow) {
  const tokens = normalizeLookup(query)
    .split(' ')
    .filter((token) => token.length >= 2)
  if (!tokens.length) return 0
  const model = normalizeLookup(catalog.model || '')
  const brand = normalizeLookup(catalog.brand || '')
  const version = normalizeLookup(catalog.version || '')
  const documentName = normalizeLookup(catalog.original_filename || '')
  const orderReference = normalizeLookup(catalog.order_reference || '')
  const customer = normalizeLookup(catalog.customer || '')
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
  }
  return score
}

export type SupabaseCatalogLookup = {
  catalog: PublicCatalog
  serial: string
  resolvedBy: 'serial' | 'model' | 'name'
  matchedLabel: string
  storagePath: string
}

export async function findSupabaseCatalogByLookup(
  query: string,
): Promise<SupabaseCatalogLookup | undefined> {
  if (!isSupabaseConfigured()) return undefined

  const digits = query.replace(/\D/g, '')
  if (digits.length >= 4) {
    const bySerial = await findSupabaseCatalog(digits)
    if (bySerial) {
      return {
        catalog: bySerial.catalog,
        serial: digits,
        resolvedBy: 'serial',
        matchedLabel: `${bySerial.catalog.brand} ${bySerial.catalog.model}`,
        storagePath: bySerial.storagePath,
      }
    }
  }

  const alphanumeric = query.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
  if (alphanumeric.length >= 4 && alphanumeric !== digits) {
    const bySerial = await findSupabaseCatalog(alphanumeric)
    if (bySerial) {
      return {
        catalog: bySerial.catalog,
        serial: alphanumeric,
        resolvedBy: 'serial',
        matchedLabel: `${bySerial.catalog.brand} ${bySerial.catalog.model}`,
        storagePath: bySerial.storagePath,
      }
    }
  }

  const supabase = getSupabaseAdmin()
  const { data: catalogs, error } = await supabase
    .from('catalogs')
    .select(
      'id, brand, model, version, customer, order_reference, storage_path, original_filename, page_count, part_count',
    )
    .eq('status', 'ready')
  if (error) throw error
  if (!catalogs?.length) return undefined

  const ranked = (catalogs as CatalogRow[])
    .map((catalog) => {
      const score = scoreSupabaseCatalog(query, catalog)
      const model = normalizeLookup(catalog.model || '')
      const resolvedBy: 'model' | 'name' = normalizeLookup(query)
        .split(' ')
        .some(
          (token) =>
            model &&
            (model === token || token.includes(model) || model.includes(token)),
        )
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
  if (!uniqueTop || !best) return undefined

  const { data: serials } = await supabase
    .from('catalog_serials')
    .select('serial_number')
    .eq('catalog_id', best.catalog.id)
  const serialList = (serials || []).map((row) => row.serial_number)
  const serial = serialList[0]
  if (!serial) return undefined

  return {
    catalog: mapCatalog(best.catalog, serialList),
    serial,
    resolvedBy: best.resolvedBy,
    matchedLabel: `${best.catalog.brand} ${best.catalog.model}`,
    storagePath: best.catalog.storage_path,
  }
}

export async function searchSupabaseParts(
  serial: string,
  query: string,
  limit = 8,
) {
  if (!isSupabaseConfigured()) return undefined
  const { data, error } = await getSupabaseAdmin().rpc('search_parts', {
    p_serial: serial.replace(/[^A-Za-z0-9]/g, '').toUpperCase(),
    p_query: query,
    p_limit: Math.min(Math.max(limit, 1), 12),
  })
  if (error) throw error
  return ((data || []) as PartRow[]).map(mapPart)
}

export async function getAllSupabaseParts(serial: string) {
  const match = await findSupabaseCatalog(serial)
  if (!match) return undefined
  const { data, error } = await getSupabaseAdmin()
    .from('parts')
    .select(
      'code, description, original_description, quantity, item, page_number, category, assembly_code, assembly_title, source_type',
    )
    .eq('catalog_id', match.catalog.id)
    .order('page_number')
    .order('item')

  if (error) throw error
  const catalogName = `${match.catalog.brand} · ${match.catalog.model}`
  return {
    catalog: {
      ...match.catalog,
      partCount: data?.length || match.catalog.partCount,
    },
    parts: ((data || []) as PartRow[]).map((row) => ({
      ...mapPart(row),
      catalogId: match.catalog.id,
      catalogName,
      documentName: match.catalog.documentName,
      documentPages: match.catalog.documentPages,
      pdfAvailable: Boolean(match.storagePath),
    })),
    storagePath: match.storagePath,
  }
}

export async function getAllReadySupabaseParts() {
  if (!isSupabaseConfigured()) return undefined
  const supabase = getSupabaseAdmin()
  const { data: catalogs, error: catalogError } = await supabase
    .from('catalogs')
    .select(
      'id, brand, model, version, customer, order_reference, storage_path, original_filename, page_count, part_count',
    )
    .eq('status', 'ready')
    .order('processed_at', { ascending: false })

  if (catalogError) throw catalogError
  if (!catalogs?.length) return undefined
  const catalogRows = catalogs as CatalogRow[]
  const catalogById = new Map(catalogRows.map((catalog) => [catalog.id, catalog]))
  const rows: AllPartRow[] = []
  const pageSize = 1000
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await supabase
      .from('parts')
      .select(
        'catalog_id, code, description, original_description, quantity, item, page_number, category, assembly_code, assembly_title, source_type',
      )
      .in('catalog_id', catalogRows.map((catalog) => catalog.id))
      .order('catalog_id')
      .order('page_number')
      .range(offset, offset + pageSize - 1)
    if (error) throw error
    rows.push(...((data || []) as AllPartRow[]))
    if (!data || data.length < pageSize) break
  }

  const parts = rows.flatMap((row) => {
    const catalog = catalogById.get(row.catalog_id)
    if (!catalog) return []
    return [{
      ...mapPart(row),
      catalogId: catalog.id,
      catalogName: `${catalog.brand} · ${catalog.model}`,
      documentName: catalog.original_filename,
      documentPages: catalog.page_count || 0,
      pdfAvailable: Boolean(catalog.storage_path),
    }]
  })

  return {
    catalog: {
      id: 'all-ready',
      brand: 'Cataloghi Supabase',
      model: `${catalogRows.length} cataloghi`,
      version: 'Tutti i cataloghi approvati',
      customer: '',
      orderReference: '',
      serialNumbers: [],
      documentName: `${catalogRows.length} PDF`,
      documentPages: catalogRows.reduce(
        (total, catalog) => total + (catalog.page_count || 0),
        0,
      ),
      partCount: parts.length,
    } satisfies PublicCatalog,
    parts,
    catalogs: catalogRows,
  }
}

export async function findExplodedViewIds(
  catalogId: string,
  figureCodes: string[],
) {
  if (!isSupabaseConfigured() || !figureCodes.length) return new Map<string, string>()
  const { data, error } = await getSupabaseAdmin()
    .from('exploded_views')
    .select('id, figure_code')
    .eq('catalog_id', catalogId)
    .in('figure_code', [...new Set(figureCodes)])
  if (error) {
    if (error.code === '42P01' || error.code === 'PGRST205') {
      const { data: catalog } = await getSupabaseAdmin()
        .from('catalogs')
        .select('metadata')
        .eq('id', catalogId)
        .maybeSingle()
      const metadata =
        catalog?.metadata && typeof catalog.metadata === 'object'
          ? (catalog.metadata as { explodedViews?: unknown })
          : undefined
      const views = Array.isArray(metadata?.explodedViews)
        ? metadata.explodedViews
        : []
      return new Map(
        views.flatMap((view) => {
          if (!view || typeof view !== 'object') return []
          const row = view as { id?: unknown; figure_code?: unknown }
          return typeof row.id === 'string' && typeof row.figure_code === 'string'
            ? [[row.figure_code, row.id] as const]
            : []
        }),
      )
    }
    throw error
  }
  return new Map((data || []).map((view) => [view.figure_code, view.id]))
}

export async function createSignedPdfUrl(catalogId: string, expiresIn = 300) {
  if (!isSupabaseConfigured()) return undefined
  const supabase = getSupabaseAdmin()
  const { data: catalog, error } = await supabase
    .from('catalogs')
    .select('storage_path')
    .eq('id', catalogId)
    .eq('status', 'ready')
    .single()

  if (error || !catalog?.storage_path) return undefined
  const { data, error: signError } = await supabase.storage
    .from('catalogs')
    .createSignedUrl(catalog.storage_path, expiresIn)
  if (signError) throw signError
  return data.signedUrl
}

