import type { VercelRequest, VercelResponse } from '@vercel/node'
import { z } from 'zod'
import {
  findLocalCatalogByLookup,
  getAllBundledParts,
  getIndexStats,
  getPublicCatalog,
} from './lib/retrieval.js'
import {
  createSignedPdfUrl,
  findSupabaseCatalogByLookup,
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

  const lookup =
    typeof request.query.q === 'string'
      ? request.query.q
      : typeof request.query.serial === 'string'
        ? request.query.serial
        : ''

  if (!lookup.trim()) {
    if (isSupabaseConfigured()) {
      const supabase = getSupabaseAdmin()
      const [{ data: readyCatalogs }, { data: serials }] = await Promise.all([
        supabase
          .from('catalogs')
          .select('id, original_filename, part_count, status')
          .in('status', ['ready', 'needs_review']),
        supabase.from('catalog_serials').select('serial_number'),
      ])
      const listable = (readyCatalogs || []).filter(
        (catalog) => (catalog.part_count || 0) > 0,
      )
      const bundled = getAllBundledParts(
        listable.map((row) => row.original_filename),
      )
      const readyParts = listable.reduce(
        (total, catalog) => total + (catalog.part_count || 0),
        0,
      )
      return response.status(200).json({
        stats: {
          catalogs: listable.length + (bundled?.catalogs.length || 0),
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

  const remote = isSupabaseConfigured()
    ? await findSupabaseCatalogByLookup(lookup)
    : undefined
  const local = findLocalCatalogByLookup(lookup)
  const match = remote || local
  if (!match) {
    // Keep exact serial lookup fallback for older clients.
    const catalog = getPublicCatalog(lookup.replace(/\D/g, ''))
    if (!catalog) {
      return response.status(404).json({
        error:
          'Matricola, macchina o catalogo non presenti negli indici disponibili.',
      })
    }
    return response.status(200).json({
      catalog,
      serial: catalog.serialNumbers[0],
      resolvedBy: 'serial',
      matchedLabel: `${catalog.brand} ${catalog.model}`,
    })
  }

  return response.status(200).json({
    catalog: match.catalog,
    serial: match.serial,
    resolvedBy: match.resolvedBy,
    matchedLabel: match.matchedLabel,
  })
}
