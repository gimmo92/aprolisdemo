import type { VercelRequest, VercelResponse } from '@vercel/node'
import { z } from 'zod'
import { listBundledCatalogs } from '../lib/retrieval.js'
import { getSupabaseAdmin, requireAdmin } from '../lib/supabase.js'

const catalogSchema = z.object({
  storagePath: z.string().min(3).max(500),
  originalFilename: z.string().min(3).max(255),
  fileSize: z.number().int().positive().max(250 * 1024 * 1024),
})

const approvalSchema = z.object({
  action: z.literal('approve'),
  catalogId: z.string().uuid(),
})

function filenameHints(filename: string) {
  const readable = filename
    .replace(/\.pdf$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const brand =
    ['Charlatte', 'Hangcha', 'Movexx', 'Fiorentini'].find((value) =>
      readable.toLocaleLowerCase('it').includes(value.toLocaleLowerCase('it')),
    ) || 'Rilevamento automatico'
  const model =
    readable.match(
      /\b(?:T\d{2,4}|CPD[A-Z0-9-]*\d[A-Z0-9-]*|CPCD[A-Z0-9-]*\d[A-Z0-9-]*|CBD[A-Z0-9-]*\d[A-Z0-9-]*)\b/i,
    )?.[0] || readable.slice(0, 100)
  return { brand, model: model || 'Rilevamento automatico' }
}

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
) {
  response.setHeader('Cache-Control', 'no-store')
  const admin = await requireAdmin(request)
  if (!admin.ok) return response.status(admin.status).json({ error: admin.error })
  const supabase = getSupabaseAdmin()

  if (request.method === 'GET') {
    const baseSelection =
      'id, brand, model, version, original_filename, storage_path, status, page_count, part_count, revision, created_at, updated_at, ingestion_jobs(id, status, progress, error_message, report, created_at, updated_at)'
    let { data, error } = await supabase
      .from('catalogs')
      .select(
        `${baseSelection}, exploded_views(id, trace_rate, asset_type)`,
      )
      .order('created_at', { ascending: false })
    if (error?.code === 'PGRST200' || error?.code === 'PGRST205') {
      const fallback = await supabase
        .from('catalogs')
        .select(baseSelection)
        .order('created_at', { ascending: false })
      data = (fallback.data || []).map((catalog) => ({
        ...catalog,
        exploded_views: [],
      }))
      error = fallback.error
    }
    if (error) return response.status(500).json({ error: error.message })
    const supabaseCatalogs = (data || []).map((catalog) => ({
      ...catalog,
      source: 'supabase' as const,
    }))
    const knownDocuments = supabaseCatalogs.map(
      (catalog) => catalog.original_filename,
    )
    const bundledCatalogs = listBundledCatalogs(knownDocuments)
    return response.status(200).json({
      catalogs: [...supabaseCatalogs, ...bundledCatalogs],
    })
  }

  if (request.method === 'POST') {
    const parsed = catalogSchema.safeParse(request.body)
    if (!parsed.success) {
      return response.status(400).json({
        error: 'File catalogo non valido.',
        details: parsed.error.issues.map((issue) => issue.message),
      })
    }
    const input = parsed.data
    const hints = filenameHints(input.originalFilename)
    const { data: catalog, error } = await supabase
      .from('catalogs')
      .insert({
        brand: hints.brand,
        model: hints.model,
        version: null,
        customer: null,
        order_reference: null,
        revision: null,
        original_filename: input.originalFilename,
        storage_path: input.storagePath,
        file_size: input.fileSize,
        mime_type: 'application/pdf',
        status: 'uploaded',
        created_by: admin.user.id,
        metadata: { metadataStatus: 'pending' },
      })
      .select('id')
      .single()

    if (error || !catalog) {
      await supabase.storage.from('catalogs').remove([input.storagePath])
      return response.status(500).json({ error: error?.message || 'Catalogo non creato.' })
    }

    const { data: job, error: jobError } = await supabase
      .from('ingestion_jobs')
      .insert({ catalog_id: catalog.id, status: 'queued', progress: 0 })
      .select('id')
      .single()
    if (jobError) {
      await supabase.from('catalogs').delete().eq('id', catalog.id)
      await supabase.storage.from('catalogs').remove([input.storagePath])
      return response.status(500).json({ error: jobError.message })
    }
    return response.status(201).json({ catalogId: catalog.id, jobId: job?.id })
  }

  if (request.method === 'PATCH') {
    const parsed = approvalSchema.safeParse(request.body)
    if (!parsed.success) {
      return response.status(400).json({ error: 'Richiesta di approvazione non valida.' })
    }
    const { data: catalog, error: catalogError } = await supabase
      .from('catalogs')
      .select('status, part_count, metadata')
      .eq('id', parsed.data.catalogId)
      .single()
    if (catalogError || !catalog) {
      return response.status(404).json({ error: 'Catalogo non trovato.' })
    }
    if (catalog.status === 'ready') {
      return response.status(200).json({ approved: true })
    }
    if (catalog.status !== 'needs_review' || catalog.part_count < 1) {
      return response.status(409).json({
        error: 'Il catalogo non è approvabile nello stato corrente.',
      })
    }
    const metadata =
      catalog.metadata && typeof catalog.metadata === 'object'
        ? catalog.metadata
        : {}
    const { error } = await supabase
      .from('catalogs')
      .update({
        status: 'ready',
        metadata: {
          ...metadata,
          review: {
            approvedAt: new Date().toISOString(),
            approvedBy: admin.user.id,
          },
        },
      })
      .eq('id', parsed.data.catalogId)
    if (error) return response.status(500).json({ error: error.message })
    return response.status(200).json({ approved: true })
  }

  if (request.method === 'DELETE') {
    const catalogId =
      typeof request.query.catalogId === 'string' ? request.query.catalogId : ''
    if (catalogId.startsWith('bundled:')) {
      return response.status(409).json({
        error: 'Il catalogo demo incluso nel deploy non può essere eliminato.',
      })
    }
    if (!z.string().uuid().safeParse(catalogId).success) {
      return response.status(400).json({ error: 'catalogId non valido.' })
    }
    const { data: catalog } = await supabase
      .from('catalogs')
      .select('storage_path')
      .eq('id', catalogId)
      .single()
    if (!catalog) return response.status(404).json({ error: 'Catalogo non trovato.' })

    const { data: explodedAssets } = await supabase
      .from('exploded_views')
      .select('svg_path')
      .eq('catalog_id', catalogId)
    const { error } = await supabase.from('catalogs').delete().eq('id', catalogId)
    if (error) return response.status(500).json({ error: error.message })
    await supabase.storage.from('catalogs').remove([catalog.storage_path])
    const assetPaths = (explodedAssets || []).map((asset) => asset.svg_path)
    if (assetPaths.length) {
      await supabase.storage.from('exploded-views').remove(assetPaths)
    }
    return response.status(200).json({ deleted: true })
  }

  response.setHeader('Allow', 'GET, POST, PATCH, DELETE')
  return response.status(405).json({ error: 'Metodo non consentito.' })
}

