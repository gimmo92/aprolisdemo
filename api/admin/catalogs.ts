import type { VercelRequest, VercelResponse } from '@vercel/node'
import { z } from 'zod'
import { getSupabaseAdmin, requireAdmin } from '../lib/supabase.js'

const catalogSchema = z.object({
  storagePath: z.string().min(3).max(500),
  originalFilename: z.string().min(3).max(255),
  fileSize: z.number().int().positive().max(250 * 1024 * 1024),
  brand: z.string().trim().min(1).max(100),
  model: z.string().trim().min(1).max(100),
  version: z.string().trim().max(100).optional().default(''),
  customer: z.string().trim().max(160).optional().default(''),
  orderReference: z.string().trim().max(100).optional().default(''),
  revision: z.string().trim().max(50).optional().default(''),
  serialNumbers: z.array(z.string().regex(/^[A-Za-z0-9._/-]{3,50}$/)).min(1).max(500),
})

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
) {
  response.setHeader('Cache-Control', 'no-store')
  const admin = await requireAdmin(request)
  if (!admin.ok) return response.status(admin.status).json({ error: admin.error })
  const supabase = getSupabaseAdmin()

  if (request.method === 'GET') {
    const { data, error } = await supabase
      .from('catalogs')
      .select(
        'id, brand, model, version, original_filename, storage_path, status, page_count, part_count, revision, created_at, updated_at, ingestion_jobs(id, status, progress, error_message, report, created_at, updated_at)',
      )
      .order('created_at', { ascending: false })
    if (error) return response.status(500).json({ error: error.message })
    return response.status(200).json({ catalogs: data || [] })
  }

  if (request.method === 'POST') {
    const parsed = catalogSchema.safeParse(request.body)
    if (!parsed.success) {
      return response.status(400).json({
        error: 'Metadati catalogo non validi.',
        details: parsed.error.issues.map((issue) => issue.message),
      })
    }
    const input = parsed.data
    const { data: catalog, error } = await supabase
      .from('catalogs')
      .insert({
        brand: input.brand,
        model: input.model,
        version: input.version || null,
        customer: input.customer || null,
        order_reference: input.orderReference || null,
        revision: input.revision || null,
        original_filename: input.originalFilename,
        storage_path: input.storagePath,
        file_size: input.fileSize,
        mime_type: 'application/pdf',
        status: 'uploaded',
        created_by: admin.user.id,
      })
      .select('id')
      .single()

    if (error || !catalog) {
      await supabase.storage.from('catalogs').remove([input.storagePath])
      return response.status(500).json({ error: error?.message || 'Catalogo non creato.' })
    }

    const serialRows = [...new Set(input.serialNumbers)].map((serial) => ({
      catalog_id: catalog.id,
      serial_number: serial,
    }))
    const { error: serialError } = await supabase
      .from('catalog_serials')
      .insert(serialRows)
    if (serialError) {
      await supabase.from('catalogs').delete().eq('id', catalog.id)
      await supabase.storage.from('catalogs').remove([input.storagePath])
      return response.status(500).json({ error: serialError.message })
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

  if (request.method === 'DELETE') {
    const catalogId =
      typeof request.query.catalogId === 'string' ? request.query.catalogId : ''
    if (!z.string().uuid().safeParse(catalogId).success) {
      return response.status(400).json({ error: 'catalogId non valido.' })
    }
    const { data: catalog } = await supabase
      .from('catalogs')
      .select('storage_path')
      .eq('id', catalogId)
      .single()
    if (!catalog) return response.status(404).json({ error: 'Catalogo non trovato.' })

    const { error } = await supabase.from('catalogs').delete().eq('id', catalogId)
    if (error) return response.status(500).json({ error: error.message })
    await supabase.storage.from('catalogs').remove([catalog.storage_path])
    return response.status(200).json({ deleted: true })
  }

  response.setHeader('Allow', 'GET, POST, DELETE')
  return response.status(405).json({ error: 'Metodo non consentito.' })
}

