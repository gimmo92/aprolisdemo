import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getIndexStats, getPublicCatalog } from './lib/retrieval'

export default function handler(request: VercelRequest, response: VercelResponse) {
  response.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300')

  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET')
    return response.status(405).json({ error: 'Metodo non consentito.' })
  }

  const serial = typeof request.query.serial === 'string' ? request.query.serial : ''
  if (!serial) {
    return response.status(200).json({ stats: getIndexStats() })
  }

  const catalog = getPublicCatalog(serial)
  if (!catalog) {
    return response.status(404).json({
      error: 'Matricola non presente nei cataloghi indicizzati.',
    })
  }

  return response.status(200).json({ catalog })
}
