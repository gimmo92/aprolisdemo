import type { VercelRequest, VercelResponse } from '@vercel/node'
import { z } from 'zod'
import {
  getAllBundledParts,
  getIndexStats,
  getPublicCatalog,
} from './lib/retrieval.js'
import {
  createSignedPdfUrl,
  findSupabaseCatalog,
} from './lib/supabase-retrieval.js'
import { getSupabaseAdmin, isSupabaseConfigured } from './lib/supabase.js'

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
) {
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET')
    return response.status(405).json({ error: 'Metodo non consentito.' })
  }

  const catalogId =
    typeof request.query.catalogId === 'string' ? request.query.catalogId : ''
  if (catalogId) {
    if (!z.string().uuid().safeParse(catalogId).success) {
      return response.status(400).json({ error: 'Catalogo non valido.' })
    }
    const page = z.coerce
      .number()
      .int()
      .positive()
      .catch(1)
      .parse(request.query.page)
    try {
      const signedUrl = await createSignedPdfUrl(catalogId)
      if (!signedUrl) {
        return response.status(404).json({ error: 'PDF non disponibile.' })
      }
      response.setHeader('Cache-Control', 'private, no-store')
      return response.redirect(302, `${signedUrl}#page=${page}`)
    } catch {
      return response.status(500).json({ error: 'Impossibile aprire il PDF.' })
    }
  }

  response.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300')

  const serial = typeof request.query.serial === 'string' ? request.query.serial : ''
  if (!serial) {
    if (isSupabaseConfigured()) {
      const supabase = getSupabaseAdmin()
      const [{ data: readyCatalogs }, { data: serials }] = await Promise.all([
        supabase
          .from('catalogs')
          .select('id, original_filename, part_count')
          .eq('status', 'ready'),
        supabase.from('catalog_serials').select('serial_number'),
      ])
      const bundled = getAllBundledParts(
        (readyCatalogs || []).map((row) => row.original_filename),
      )
      const readyParts = (readyCatalogs || []).reduce(
        (total, catalog) => total + (catalog.part_count || 0),
        0,
      )
      return response.status(200).json({
        stats: {
          catalogs:
            (readyCatalogs?.length || 0) + (bundled?.catalogs.length || 0),
          parts: readyParts + (bundled?.parts.length || 0),
          serialNumbers: [
            ...new Set([
              ...(serials || []).map((row) => row.serial_number),
              ...(bundled?.catalog.serialNumbers || []),
            ]),
          ],
          source: 'supabase+bundled',
        },
      })
    }
    return response.status(200).json({ stats: getIndexStats() })
  }

  let catalog = isSupabaseConfigured()
    ? (await findSupabaseCatalog(serial))?.catalog
    : undefined
  catalog ||= getPublicCatalog(serial)
  if (!catalog) {
    return response.status(404).json({
      error: 'Matricola non presente nei cataloghi indicizzati.',
    })
  }

  return response.status(200).json({ catalog })
}
