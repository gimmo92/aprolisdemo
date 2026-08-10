import type { VercelRequest, VercelResponse } from '@vercel/node'
import { z } from 'zod'
import { createSignedPdfUrl } from './lib/supabase-retrieval.js'

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
  const page = z.coerce.number().int().positive().catch(1).parse(request.query.page)
  const format =
    typeof request.query.format === 'string' ? request.query.format : ''
  if (!z.string().uuid().safeParse(catalogId).success) {
    return response.status(400).json({ error: 'Catalogo non valido.' })
  }

  try {
    const expiresIn = format === 'json' ? 3600 : 300
    const signedUrl = await createSignedPdfUrl(catalogId, expiresIn)
    if (!signedUrl) return response.status(404).json({ error: 'PDF non disponibile.' })
    response.setHeader('Cache-Control', 'private, no-store')
    if (format === 'json') {
      return response.status(200).json({
        catalogId,
        page,
        pdfUrl: signedUrl,
      })
    }
    return response.redirect(302, `${signedUrl}#page=${page}`)
  } catch {
    return response.status(500).json({ error: 'Impossibile aprire il PDF.' })
  }
}
