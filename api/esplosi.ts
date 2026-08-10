import type { VercelRequest, VercelResponse } from '@vercel/node'
import { z } from 'zod'
import { createSignedPdfUrl } from './lib/supabase-retrieval.js'
import { getSupabaseAdmin, isSupabaseConfigured } from './lib/supabase.js'

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
) {
  response.setHeader('Cache-Control', 'private, max-age=60')

  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET')
    return response.status(405).json({ error: 'Metodo non consentito.' })
  }

  if (!isSupabaseConfigured()) {
    return response.status(503).json({ error: 'Supabase non configurato.' })
  }

  const catalogId =
    typeof request.query.catalogId === 'string' ? request.query.catalogId : ''
  const page = z.coerce.number().int().positive().catch(0).parse(request.query.page)
  if (!z.string().uuid().safeParse(catalogId).success) {
    return response.status(400).json({ error: 'Catalogo non valido.' })
  }
  if (page < 1) {
    return response.status(400).json({ error: 'Pagina non valida.' })
  }

  try {
    const supabase = getSupabaseAdmin()
    const { data: catalog, error: catalogError } = await supabase
      .from('catalogs')
      .select(
        'id, brand, model, version, original_filename, storage_path, page_count, part_count, status',
      )
      .eq('id', catalogId)
      .eq('status', 'ready')
      .maybeSingle()

    if (catalogError || !catalog?.storage_path) {
      return response.status(404).json({ error: 'Catalogo non trovato o senza PDF.' })
    }

    const { data: partRows, error: partsError } = await supabase
      .from('parts')
      .select(
        'code, description, original_description, quantity, item, page_number, category, assembly_code, assembly_title, source_type',
      )
      .eq('catalog_id', catalogId)
      .eq('page_number', page)
      .order('item')

    if (partsError) {
      return response.status(500).json({ error: partsError.message })
    }
    if (!partRows?.length) {
      return response.status(404).json({
        error: 'Nessun ricambio indicizzato su questa pagina.',
      })
    }

    const pdfUrl = await createSignedPdfUrl(catalogId, 3600)
    if (!pdfUrl) {
      return response.status(404).json({ error: 'PDF non disponibile.' })
    }

    const parts = partRows.map((row) => ({
      code: row.code,
      description: row.description || row.original_description || 'Ricambio',
      originalDescription: row.original_description || row.description || 'Ricambio',
      quantity: row.quantity ?? 0,
      item: row.item || '',
      page,
      category: row.category || 'Ricambi',
      sourceType: ['mechanical', 'electrical', 'generic'].includes(row.source_type)
        ? row.source_type
        : 'generic',
      ...(row.assembly_code ? { assemblyCode: row.assembly_code } : {}),
      ...(row.assembly_title ? { assemblyTitle: row.assembly_title } : {}),
    }))

    const assemblyTitle =
      parts.find((part) => part.assemblyTitle)?.assemblyTitle || `Pagina ${page}`
    const assemblyCode =
      parts.find((part) => part.assemblyCode)?.assemblyCode || ''

    return response.status(200).json({
      catalog: {
        id: catalog.id,
        brand: catalog.brand,
        model: catalog.model,
        version: catalog.version || '',
        customer: '',
        orderReference: '',
        serialNumbers: [],
        documentName: catalog.original_filename,
        documentPages: catalog.page_count || 0,
        partCount: catalog.part_count || 0,
        pdfAvailable: true,
      },
      page,
      assemblyTitle,
      assemblyCode,
      pdfUrl,
      parts,
    })
  } catch (error) {
    console.error('Esplosi API failed', error)
    return response.status(500).json({ error: 'Impossibile caricare l’esploso.' })
  }
}
