import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getAllParts } from './lib/retrieval.js'

export default function handler(request: VercelRequest, response: VercelResponse) {
  response.setHeader('Cache-Control', 'public, max-age=60, s-maxage=600')

  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET')
    return response.status(405).json({ error: 'Metodo non consentito.' })
  }

  const serial =
    typeof request.query.serial === 'string' ? request.query.serial : '13510073'
  const result = getAllParts(serial)
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
  }))

  const categories = [...new Set(parts.map((part) => part.category))].sort((a, b) =>
    a.localeCompare(b, 'it'),
  )

  return response.status(200).json({
    catalog: result.catalog,
    parts,
    filters: {
      categories,
      sourceTypes: ['mechanical', 'electrical'],
      pageMin: Math.min(...parts.map((part) => part.page)),
      pageMax: Math.max(...parts.map((part) => part.page)),
    },
  })
}
