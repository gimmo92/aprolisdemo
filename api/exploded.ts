import { gunzipSync } from 'node:zlib'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { z } from 'zod'
import { getSupabaseAdmin, isSupabaseConfigured } from './lib/supabase.js'

const viewIdSchema = z.string().uuid()

type ExplodedRow = {
  id: string
  catalog_id: string
  machine: string
  figure_code: string
  title: string
  page_index: number
  parts_pages: number[]
  svg_path: string
  asset_type: 'svg' | 'png'
  view_w: number
  view_h: number
  trace_rate: number
  metadata?: { assetBucket?: string }
  catalogs?: { status?: string } | Array<{ status?: string }>
  callouts?: Array<Record<string, unknown>>
}

function metadataViews(
  catalogs: Array<{ id: string; metadata: unknown }>,
): ExplodedRow[] {
  return catalogs.flatMap((catalog) => {
    if (!catalog.metadata || typeof catalog.metadata !== 'object') return []
    const views = (catalog.metadata as { explodedViews?: unknown }).explodedViews
    if (!Array.isArray(views)) return []
    return views.flatMap((view) => {
      if (!view || typeof view !== 'object') return []
      const row = view as Record<string, unknown>
      if (typeof row.id !== 'string') return []
      return [{
        id: row.id,
        catalog_id: catalog.id,
        machine: String(row.machine || 'Catalogo'),
        figure_code: String(row.figure_code || ''),
        title: String(row.title || row.figure_code || 'Tavola'),
        page_index: Number(row.page_index || 1),
        parts_pages: Array.isArray(row.parts_pages)
          ? row.parts_pages.map(Number)
          : [],
        svg_path: String(row.svg_path || ''),
        asset_type: row.asset_type === 'png' ? 'png' : 'svg',
        view_w: Number(row.view_w || 1),
        view_h: Number(row.view_h || 1),
        trace_rate: Number(row.trace_rate || 0),
        metadata:
          row.metadata && typeof row.metadata === 'object'
            ? (row.metadata as { assetBucket?: string })
            : undefined,
        callouts: Array.isArray(row.callouts)
          ? (row.callouts as Array<Record<string, unknown>>)
          : [],
      } satisfies ExplodedRow]
    })
  })
}

function stripUnsafeSvg(markup: string) {
  return markup
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<foreignObject\b[^>]*>[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*')/gi, '')
    .replace(
      /\s+(?:xlink:href|href)\s*=\s*(?:"(?:https?:)?\/\/[^"]*"|'(?:https?:)?\/\/[^']*')/gi,
      '',
    )
}

function publicView(row: ExplodedRow) {
  return {
    id: row.id,
    catalogId: row.catalog_id,
    machine: row.machine,
    figureCode: row.figure_code,
    title: row.title,
    pageIndex: row.page_index,
    partsPages: row.parts_pages,
    assetType: row.asset_type,
    viewW: row.view_w,
    viewH: row.view_h,
    traceRate: row.trace_rate,
  }
}

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
) {
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET')
    return response.status(405).json({ error: 'Metodo non consentito.' })
  }
  if (!isSupabaseConfigured()) {
    return response.status(503).json({ error: 'Supabase non configurato.' })
  }

  const supabase = getSupabaseAdmin()
  const rawViewId =
    typeof request.query.viewId === 'string' ? request.query.viewId : ''

  try {
    if (!rawViewId) {
      const { data: catalogs, error: catalogError } = await supabase
        .from('catalogs')
        .select('id, metadata')
        .eq('status', 'ready')
      if (catalogError) throw catalogError
      const readyIds = (catalogs || []).map((catalog) => catalog.id)
      let normalizedRows: ExplodedRow[] = []
      if (readyIds.length) {
        const { data, error } = await supabase
          .from('exploded_views')
          .select(
            'id, catalog_id, machine, figure_code, title, page_index, parts_pages, svg_path, asset_type, view_w, view_h, trace_rate, metadata',
          )
          .in('catalog_id', readyIds)
          .order('machine')
          .order('title')
        if (error && error.code !== '42P01' && error.code !== 'PGRST205') {
          throw error
        }
        normalizedRows = (data || []) as ExplodedRow[]
      }
      const merged = new Map<string, ExplodedRow>()
      for (const row of normalizedRows) merged.set(row.id, row)
      for (const row of metadataViews(catalogs || [])) {
        if (!merged.has(row.id)) merged.set(row.id, row)
      }
      response.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300')
      return response
        .status(200)
        .json({ views: [...merged.values()].map(publicView) })
    }

    const parsed = viewIdSchema.safeParse(rawViewId)
    if (!parsed.success) {
      return response.status(400).json({ error: 'Tavola non valida.' })
    }
    const { data, error } = await supabase
      .from('exploded_views')
      .select(
        'id, catalog_id, machine, figure_code, title, page_index, parts_pages, svg_path, asset_type, view_w, view_h, trace_rate, metadata',
      )
      .eq('id', parsed.data)
      .maybeSingle()
    let view = data as ExplodedRow | null
    if (error && error.code !== '42P01' && error.code !== 'PGRST205') {
      throw error
    }
    if (!view) {
      const { data: catalogs, error: catalogError } = await supabase
        .from('catalogs')
        .select('id, metadata')
        .eq('status', 'ready')
      if (catalogError) throw catalogError
      view =
        metadataViews(catalogs || []).find((candidate) => candidate.id === parsed.data) ||
        null
    }
    if (view) {
      const { data: catalog } = await supabase
        .from('catalogs')
        .select('status')
        .eq('id', view.catalog_id)
        .eq('status', 'ready')
        .maybeSingle()
      if (!catalog) view = null
    }
    if (!view) {
      return response.status(404).json({ error: 'Tavola non disponibile.' })
    }

    const partsRequest = supabase
      .from('parts')
      .select(
        'code, description, original_description, quantity, item, page_number, category, assembly_code, assembly_title, source_type',
      )
      .eq('catalog_id', view.catalog_id)
      .in('page_number', view.parts_pages)
      .order('page_number')
      .order('item')
    const [{ data: callouts, error: calloutError }, { data: parts, error: partsError }] =
      await Promise.all([
        view.callouts
          ? Promise.resolve({ data: view.callouts, error: null })
          : supabase
              .from('exploded_callouts')
              .select('id, label, items, x, y, tip_x, tip_y, traced')
              .eq('view_id', view.id)
              .order('label'),
        partsRequest,
      ])
    if (calloutError || partsError) throw calloutError || partsError

    let svg: string | undefined
    let imageUrl: string | undefined
    const assetBuckets = [
      view.metadata?.assetBucket,
      'exploded-views',
      'catalogs',
    ].filter((bucket, index, all): bucket is string =>
      Boolean(bucket) && all.indexOf(bucket) === index,
    )
    if (view.asset_type === 'svg') {
      let asset: Blob | null = null
      let assetError: unknown
      for (const bucket of assetBuckets) {
        const result = await supabase.storage.from(bucket).download(view.svg_path)
        if (result.data) {
          asset = result.data
          assetError = undefined
          break
        }
        assetError = result.error
      }
      if (assetError || !asset) throw assetError || new Error('SVG non disponibile')
      let bytes = Buffer.from(await asset.arrayBuffer())
      if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes)
      svg = stripUnsafeSvg(bytes.toString('utf8'))
    } else {
      let asset: Blob | null = null
      let assetError: unknown
      for (const bucket of assetBuckets) {
        const result = await supabase.storage.from(bucket).download(view.svg_path)
        if (result.data) {
          asset = result.data
          assetError = undefined
          break
        }
        assetError = result.error
      }
      if (assetError || !asset) {
        throw assetError || new Error('Immagine non disponibile')
      }
      const bytes = Buffer.from(await asset.arrayBuffer())
      imageUrl = `data:image/png;base64,${bytes.toString('base64')}`
    }

    response.setHeader('Cache-Control', 'public, max-age=300, s-maxage=3600')
    return response.status(200).json({
      view: publicView(view),
      svg,
      imageUrl,
      callouts: (callouts || []).map((callout) => ({
        id: callout.id,
        label: callout.label,
        items: (callout.items || []).map(String),
        x: callout.x,
        y: callout.y,
        tipX: callout.tip_x,
        tipY: callout.tip_y,
        traced: callout.traced,
      })),
      parts: (parts || [])
        .filter(
          (part) =>
            part.assembly_code === view.figure_code ||
            part.assembly_title === view.title,
        )
        .map((part) => ({
        code: part.code,
        description: part.description || part.original_description || 'Ricambio',
        originalDescription:
          part.original_description || part.description || 'Ricambio',
        quantity: part.quantity ?? 0,
        item: part.item || '',
        page: part.page_number,
        category: part.category || 'Ricambi',
        assemblyCode: part.assembly_code || undefined,
        assemblyTitle: part.assembly_title || undefined,
        sourceType: ['mechanical', 'electrical'].includes(part.source_type)
          ? part.source_type
          : 'generic',
        catalogId: view.catalog_id,
          catalogName: view.machine,
        })),
    })
  } catch (error) {
    console.error('Exploded view API failed', error)
    return response.status(500).json({ error: 'Impossibile caricare la tavola.' })
  }
}
