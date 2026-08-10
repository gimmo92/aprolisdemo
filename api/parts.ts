import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getAllParts } from './lib/retrieval.js'
import {
  getAllReadySupabaseParts,
  getAllSupabaseParts,
} from './lib/supabase-retrieval.js'
import { isSupabaseConfigured } from './lib/supabase.js'

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
  let result:
    | Awaited<ReturnType<typeof getAllReadySupabaseParts>>
    | Awaited<ReturnType<typeof getAllSupabaseParts>>
    | ReturnType<typeof getAllParts>
    | undefined
  if (isSupabaseConfigured()) {
    try {
      result = allCatalogs
        ? await getAllReadySupabaseParts()
        : await getAllSupabaseParts(serial)
    } catch (error) {
      console.error('Supabase parts retrieval failed; using bundled fallback', error)
    }
  }
  result ||= getAllParts(serial)
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
    ...('catalogId' in part
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
      pdfAvailable: 'storagePath' in result && Boolean(result.storagePath),
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
