import type { VercelRequest, VercelResponse } from '@vercel/node'
import {
  getAllBundledParts,
  getAllParts,
  type BundledPart,
} from './lib/retrieval.js'
import type { IndexedPart, PublicCatalog } from './lib/types.js'
import {
  getAllReadySupabaseParts,
  getAllSupabaseParts,
} from './lib/supabase-retrieval.js'
import { isSupabaseConfigured } from './lib/supabase.js'

type PartWithCatalog = IndexedPart & {
  catalogId?: string
  catalogName?: string
  documentName?: string
  documentPages?: number
  pdfAvailable?: boolean
}

type PartsResult = {
  catalog: PublicCatalog
  parts: PartWithCatalog[]
  storagePath?: string
}

function mergeParts(
  primary: PartsResult | undefined,
  bundled: ReturnType<typeof getAllBundledParts>,
): PartsResult | undefined {
  if (!primary && !bundled) return undefined
  if (!primary) return bundled
  if (!bundled?.parts.length) return primary

  const parts = [...primary.parts, ...bundled.parts]
  return {
    catalog: {
      id: 'all-catalogs',
      brand: 'Cataloghi',
      model: 'Supabase + demo locale',
      version: 'Indici approvati e cataloghi inclusi nel deploy',
      customer: '',
      orderReference: '',
      serialNumbers: [
        ...new Set([
          ...primary.catalog.serialNumbers,
          ...bundled.catalog.serialNumbers,
        ]),
      ],
      documentName: `${primary.catalog.documentName} + ${bundled.catalog.documentName}`,
      documentPages:
        primary.catalog.documentPages + bundled.catalog.documentPages,
      partCount: parts.length,
    },
    parts,
    storagePath: primary.storagePath,
  }
}

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
) {
  response.setHeader('Cache-Control', 'public, max-age=60, s-maxage=600')

  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET')
    return response.status(405).json({ error: 'Metodo non consentito.' })
  }

  const serial =
    typeof request.query.serial === 'string' ? request.query.serial : '13510073'
  const allCatalogs = request.query.scope === 'all'
  let result: PartsResult | undefined

  if (isSupabaseConfigured()) {
    try {
      if (allCatalogs) {
        const supabase = await getAllReadySupabaseParts()
        const knownDocuments = (supabase?.catalogs || []).map(
          (catalog) => catalog.original_filename,
        )
        result = mergeParts(supabase, getAllBundledParts(knownDocuments))
      } else {
        const supabase = await getAllSupabaseParts(serial)
        const local = getAllParts(serial)
        if (supabase && local) {
          const sameDocument =
            supabase.catalog.documentName.trim().toLocaleLowerCase('it') ===
            local.catalog.documentName.trim().toLocaleLowerCase('it')
          if (sameDocument) {
            result = supabase
          } else {
            // Keep both indexes when the demo PDF and the uploaded catalog differ.
            result = mergeParts(supabase, {
              catalog: local.catalog,
              parts: local.parts as BundledPart[],
              catalogs: [
                {
                  id: local.catalog.id,
                  documentName: local.catalog.documentName,
                  partCount: local.catalog.partCount,
                },
              ],
            })
          }
        } else {
          result = supabase
        }
      }
    } catch (error) {
      console.error('Supabase parts retrieval failed; using bundled fallback', error)
    }
  }

  if (!result) {
    result = allCatalogs
      ? getAllBundledParts()
      : getAllParts(serial)
  }

  if (!result) {
    return response.status(404).json({
      error: 'Matricola non presente nei cataloghi indicizzati.',
    })
  }

  const parts = result.parts.map((part) => ({
    code: part.code,
    description: part.description,
    originalDescription: part.originalDescription,
    quantity: part.quantity,
    item: part.item,
    page: part.page,
    category: part.category,
    sourceType: part.sourceType,
    assemblyCode: part.assemblyCode,
    assemblyTitle: part.assemblyTitle,
    ...('catalogId' in part && part.catalogId
      ? {
          catalogId: part.catalogId,
          catalogName: part.catalogName,
          documentName: part.documentName,
          documentPages: part.documentPages,
          pdfAvailable: part.pdfAvailable,
        }
      : {}),
  }))

  const categories = [...new Set(parts.map((part) => part.category))].sort((a, b) =>
    a.localeCompare(b, 'it'),
  )

  return response.status(200).json({
    catalog: {
      ...result.catalog,
      pdfAvailable: Boolean(result.storagePath),
    },
    parts,
    filters: {
      categories,
      sourceTypes: [...new Set(parts.map((part) => part.sourceType))],
      pageMin: parts.length ? Math.min(...parts.map((part) => part.page)) : 0,
      pageMax: parts.length ? Math.max(...parts.map((part) => part.page)) : 0,
    },
  })
}
