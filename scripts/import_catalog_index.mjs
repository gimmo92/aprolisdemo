import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { createClient } from '@supabase/supabase-js'

const url = process.env.SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !serviceKey) {
  throw new Error('Imposta SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY.')
}

const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})
const indexPath = process.argv[2] || 'data/catalog-index.json'
const index = JSON.parse(await readFile(indexPath, 'utf8'))
const { data: admin } = await supabase
  .from('profiles')
  .select('id')
  .eq('role', 'admin')
  .order('created_at')
  .limit(1)
  .single()
if (!admin) throw new Error('Crea e promuovi il primo amministratore prima dell’import.')

for (const source of index.catalogs || []) {
  const storagePath =
    process.env.LEGACY_CATALOG_STORAGE_PATH ||
    `${admin.id}/legacy-${basename(source.documentName)}`

  if (process.env.LEGACY_CATALOG_PDF) {
    const pdf = await readFile(process.env.LEGACY_CATALOG_PDF)
    const { error } = await supabase.storage
      .from('catalogs')
      .upload(storagePath, pdf, {
        contentType: 'application/pdf',
        upsert: false,
      })
    if (error && !/already exists/i.test(error.message)) throw error
  }

  const { data: existing } = await supabase
    .from('catalogs')
    .select('id')
    .eq('original_filename', source.documentName)
    .eq('revision', 'legacy-import')
    .maybeSingle()
  let catalogId = existing?.id
  const values = {
    brand: source.brand,
    model: source.model,
    version: source.version,
    customer: source.customer,
    order_reference: source.orderReference,
    original_filename: source.documentName,
    storage_path: storagePath,
    revision: 'legacy-import',
    page_count: source.documentPages,
    part_count: source.parts.length,
    status: 'ready',
    processed_at: new Date().toISOString(),
    created_by: admin.id,
    metadata: { importedFrom: indexPath, sourceId: source.id },
  }
  if (catalogId) {
    const { error } = await supabase.from('catalogs').update(values).eq('id', catalogId)
    if (error) throw error
  } else {
    const { data, error } = await supabase
      .from('catalogs')
      .insert(values)
      .select('id')
      .single()
    if (error) throw error
    catalogId = data.id
  }

  const serialRows = source.serialNumbers.map((serialNumber) => ({
    catalog_id: catalogId,
    serial_number: serialNumber,
  }))
  await supabase.from('catalog_serials').delete().eq('catalog_id', catalogId)
  const { error: serialError } = await supabase.from('catalog_serials').insert(serialRows)
  if (serialError) throw serialError

  const rows = source.parts.map((part) => ({
    catalog_id: catalogId,
    code: part.code,
    description: part.description,
    original_description: part.originalDescription,
    quantity: part.quantity,
    item: part.item || null,
    page_number: part.page,
    category: part.category,
    assembly_code: part.assemblyCode || null,
    assembly_title: part.assemblyTitle || null,
    source_type: part.sourceType || 'generic',
    confidence: 1,
    metadata: { extraction: 'legacy-json' },
  }))
  const { data: imported, error: importError } = await supabase.rpc(
    'replace_catalog_parts',
    { p_catalog_id: catalogId, p_rows: rows },
  )
  if (importError) throw importError
  console.log(`${source.documentName}: ${imported} ricambi importati`)
}

