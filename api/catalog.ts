import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getIndexStats, getPublicCatalog } from './lib/retrieval.js'
import { findSupabaseCatalog } from './lib/supabase-retrieval.js'
import { getSupabaseAdmin, isSupabaseConfigured } from './lib/supabase.js'

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
) {
  response.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300')

  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET')
    return response.status(405).json({ error: 'Metodo non consentito.' })
  }

  const serial = typeof request.query.serial === 'string' ? request.query.serial : ''
  if (!serial) {
    if (isSupabaseConfigured()) {
      const supabase = getSupabaseAdmin()
      const [{ count: catalogs }, { count: parts }, { data: serials }] =
        await Promise.all([
          supabase.from('catalogs').select('*', { count: 'exact', head: true }),
          supabase.from('parts').select('*', { count: 'exact', head: true }),
          supabase.from('catalog_serials').select('serial_number'),
        ])
      return response.status(200).json({
        stats: {
          catalogs: catalogs || 0,
          parts: parts || 0,
          serialNumbers: (serials || []).map((row) => row.serial_number),
          source: 'supabase',
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
