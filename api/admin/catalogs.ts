import type { VercelRequest, VercelResponse } from '@vercel/node'
import { z } from 'zod'
import { getSupabaseAdmin, requireAdmin } from '../lib/supabase.js'

const catalogSchema = z.object({
  storagePath: z.string().min(3).max(500),
  originalFilename: z.string().min(3).max(255),
  fileSize: z.number().int().positive().max(250 * 1024 * 1024),
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

