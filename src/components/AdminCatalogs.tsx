import { useCallback, useEffect, useState } from 'react'
import * as tus from 'tus-js-client'
import {
  AlertCircle,
  BadgeCheck,
  CheckCircle2,
  FileUp,
  LoaderCircle,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react'
import {
  authenticatedFetch,
  getValidSession,
  useAuth,
} from '../lib/auth'
import {
  supabase,
  supabasePublishableKey,
  supabaseUrl,
} from '../lib/supabase'

type AdminCatalog = {
  id: string
  brand: string
  model: string
  original_filename: string
  storage_path: string
  status: string
  part_count: number
  created_at: string
  source?: 'supabase' | 'bundled'
  serial_numbers?: string[]
  exploded_views?: Array<{
    id: string
    trace_rate: number
    asset_type: 'svg' | 'png'
  }>
  ingestion_jobs?: Array<{
    id: string
    status: string
    progress: number
    updated_at?: string
    error_message?: string
    report?: {
      deterministicParts?: number
      aiParts?: number
      unresolvedPages?: number[]
      remainingAiPages?: number[]
      explodedViews?: number
      interactiveExplodedViews?: number
      explodedTraceRate?: number
      persistedExplodedViews?: number
      explodedStorage?: 'normalized_tables' | 'catalog_metadata'
      explodedError?: {
        code?: string
        message?: string
      }
      aiErrors?: Array<{
        page?: number
        code?: string
        message?: string
        details?: {
          status?: number
          reason?: string
          response?: {
            message?: string
            error?: { type?: string; message?: string }
          }
        }
      }>
      detectedMetadata?: { missing?: string[] }
    }
  }>
}

type ApiPayload = {
  error?: string
  catalogs?: AdminCatalog[]
  catalogId?: string
  jobId?: string
  status?: string
  accepted?: number
  report?: NonNullable<AdminCatalog['ingestion_jobs']>[number]['report']
  approved?: boolean
}

function statusLabel(status: string, partCount?: number) {
  if (status === 'ready' && typeof partCount === 'number' && partCount < 1) {
    return 'Senza ricambi'
  }
  const labels: Record<string, string> = {
    uploaded: 'Caricato',
    queued: 'In coda',
    running: 'Indicizzazione',
    completed: 'Completato',
    processing: 'Indicizzazione',
    ready: 'Pronto',
    needs_review: 'Da verificare',
    failed: 'Errore',
  }
  return labels[status] || status
}

function isStaleJob(
  job: NonNullable<AdminCatalog['ingestion_jobs']>[number] | undefined,
) {
  if (job?.status !== 'running' || !job.updated_at) return false
  const updatedAt = Date.parse(job.updated_at)
  return Number.isFinite(updatedAt) && Date.now() - updatedAt >= 6 * 60 * 1000
}

const MAX_PDF_BYTES = 250 * 1024 * 1024

type QueueStatus = 'pending' | 'uploading' | 'indexing' | 'done' | 'error'

type QueueItem = {
  id: string
  file: File
  status: QueueStatus
  progress: number
  error?: string
}

function pdfProblem(file: File) {
  const namedPdf = /\.pdf$/i.test(file.name)
  if (file.type === 'application/pdf' || (file.type === '' && namedPdf)) {
    if (file.size === 0) return 'il file è vuoto'
    if (file.size > MAX_PDF_BYTES) return 'supera 250 MB'
    return null
  }
  return 'non è un PDF'
}

function sameFile(left: File, right: File) {
  return (
    left.name === right.name &&
    left.size === right.size &&
    left.lastModified === right.lastModified
  )
}

function queueStatusLabel(item: QueueItem) {
  if (item.status === 'pending') return 'In attesa'
  if (item.status === 'uploading') return `Caricamento ${item.progress}%`
  if (item.status === 'indexing') return 'Indicizzazione'
  if (item.status === 'done') return 'Completato'
  return item.error || 'Errore'
}

async function readApiPayload(response: Response): Promise<ApiPayload> {
  const text = await response.text()
  try {
    return JSON.parse(text) as ApiPayload
  } catch {
    return {
      error: response.ok
        ? 'Il server ha restituito una risposta non valida.'
        : `Indicizzazione interrotta dal server (${response.status}). Attendi sei minuti e premi Riprova.`,
    }
  }
}

export function AdminCatalogs() {
  const { session } = useAuth()
  const [role, setRole] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [catalogs, setCatalogs] = useState<AdminCatalog[]>([])

  const refresh = useCallback(async (silent = false) => {
    if (!supabase || !session) return
    if (!silent) setLoading(true)
    try {
      const active = await getValidSession()
      const { data } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', active.user.id)
        .single()
      setRole(data?.role)
      if (data?.role !== 'admin') return
      const response = await authenticatedFetch('/api/admin/catalogs')
      const payload = await readApiPayload(response)
      if (response.ok) setCatalogs(payload.catalogs || [])
    } catch (error) {
      if (!silent) {
        setMessage(
          error instanceof Error ? error.message : 'Sessione non disponibile.',
        )
      }
    } finally {
      if (!silent) setLoading(false)
    }
  }, [session])

  useEffect(() => {
    void refresh()
  }, [refresh])

  function patchQueue(id: string, patch: Partial<QueueItem>) {
    setQueue((current) =>
      current.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    )
  }

  function addFiles(list: FileList | File[]) {
    const incoming = Array.from(list)
    const rejected: string[] = []
    const accepted: QueueItem[] = []
    for (const file of incoming) {
      const problem = pdfProblem(file)
      if (problem) {
        rejected.push(`${file.name}: ${problem}.`)
        continue
      }
      accepted.push({
        id: crypto.randomUUID(),
        file,
        status: 'pending',
        progress: 0,
      })
    }
    setQueue((current) => {
      const next = [...current]
      for (const item of accepted) {
        if (
          next.some(
            (existing) =>
              existing.status !== 'done' && sameFile(existing.file, item.file),
          )
        ) {
          continue
        }
        next.push(item)
      }
      return next
    })
    if (rejected.length) setMessage(rejected.slice(0, 4).join(' '))
  }

  function uploadTus(
    selectedFile: File,
    objectName: string,
    onProgress: (percent: number) => void,
  ) {
    return new Promise<void>((resolve, reject) => {
      if (!supabaseUrl || !supabasePublishableKey) {
        reject(new Error('Supabase non configurato.'))
        return
      }
      const upload = new tus.Upload(selectedFile, {
        endpoint: `${supabaseUrl}/storage/v1/upload/resumable`,
        retryDelays: [0, 1_000, 3_000, 5_000, 10_000],
        chunkSize: 6 * 1024 * 1024,
        removeFingerprintOnSuccess: true,
        uploadDataDuringCreation: true,
        headers: {
          apikey: supabasePublishableKey,
          'x-upsert': 'false',
        },
        onBeforeRequest: async (request) => {
          const active = await getValidSession()
          request.setHeader('authorization', `Bearer ${active.access_token}`)
        },
        metadata: {
          bucketName: 'catalogs',
          objectName,
          contentType: 'application/pdf',
          cacheControl: '3600',
        },
        onError: reject,
        onProgress: (uploaded, total) =>
          onProgress(total > 0 ? Math.round((uploaded / total) * 100) : 0),
        onSuccess: () => resolve(),
      })
      upload.findPreviousUploads().then((previous) => {
        if (previous[0]) upload.resumeFromPreviousUpload(previous[0])
        upload.start()
      })
    })
  }

  async function runIndexing(
    catalogId: string,
    jobId: string,
    options?: { resetAi?: boolean; label?: string },
  ) {
    let latest: ApiPayload = {}
    let previousRemaining = ''
    let stalledPasses = 0
    for (let pass = 1; pass <= 500; pass += 1) {
      const response = await authenticatedFetch('/api/index_catalog', {
        method: 'POST',
        body: JSON.stringify({
          catalogId,
          jobId,
          ...(pass === 1 && options?.resetAi ? { resetAi: true } : {}),
        }),
      })
      latest = await readApiPayload(response)
      if (!response.ok) {
        throw new Error(latest.error || 'Indicizzazione non riuscita.')
      }
      const remainingPages = latest.report?.remainingAiPages || []
      const remaining = remainingPages.length
      const fatalAi = (latest.report?.aiErrors || []).some(
        (error) =>
          error?.code === 'ANTHROPIC_NOT_CONFIGURED' ||
          error?.code === 'ANTHROPIC_INTERNAL_ERROR',
      )
      if (!remaining || fatalAi) return latest
      const signature = remainingPages.join(',')
      stalledPasses = signature === previousRemaining ? stalledPasses + 1 : 0
      if (stalledPasses >= 5) {
        throw new Error(
          `Indicizzazione senza avanzamento: restano ${remaining} pagine. Premi Riprova.`,
        )
      }
      previousRemaining = signature
      setMessage(
        options?.label
          ? `${options.label}: ${remaining} pagine Claude ancora da elaborare (passaggio ${pass})…`
          : `Indicizzazione in corso: ${remaining} pagine Claude ancora da elaborare (passaggio ${pass})…`,
      )
    }
    throw new Error(
      'Indicizzazione oltre il limite di sicurezza di 500 passaggi. Premi Riprova per continuare.',
    )
  }

  async function submitCatalog(event: React.FormEvent) {
    event.preventDefault()
    if (!session) return
    const batch = queue.filter(
      (item) => item.status === 'pending' || item.status === 'error',
    )
    if (!batch.length) return
    setBusy(true)
    let completed = 0
    let failed = 0
    const finished = new Set<string>()
    try {
      for (const [index, item] of batch.entries()) {
        const position = `${index + 1}/${batch.length}`
        try {
          patchQueue(item.id, {
            status: 'uploading',
            progress: 0,
            error: undefined,
          })
          setMessage(`Caricamento ${position}: ${item.file.name}`)
          const active = await getValidSession()
          const safeName = item.file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
          const storagePath = `${active.user.id}/${crypto.randomUUID()}-${safeName}`
          await uploadTus(item.file, storagePath, (percent) => {
            patchQueue(item.id, { progress: percent })
          })
          setMessage(`Registrazione ${position}: ${item.file.name}`)
          const createResponse = await authenticatedFetch('/api/admin/catalogs', {
            method: 'POST',
            body: JSON.stringify({
              storagePath,
              originalFilename: item.file.name,
              fileSize: item.file.size,
            }),
          })
          const created = await readApiPayload(createResponse)
          if (!createResponse.ok || !created.catalogId || !created.jobId) {
            throw new Error(created.error || 'Catalogo non registrato.')
          }
          patchQueue(item.id, { status: 'indexing', progress: 100 })
          setMessage(`Indicizzazione ${position}: ${item.file.name}`)
          await runIndexing(created.catalogId, created.jobId, {
            label: `${item.file.name} (${position})`,
          })
          patchQueue(item.id, { status: 'done' })
          finished.add(item.id)
          completed += 1
          await refresh(true)
        } catch (error) {
          failed += 1
          patchQueue(item.id, {
            status: 'error',
            error:
              error instanceof Error ? error.message : 'Operazione non riuscita.',
          })
        }
      }
      setQueue((current) => current.filter((item) => !finished.has(item.id)))
      const summary = [
        completed === 1
          ? '1 catalogo indicizzato'
          : completed > 1
            ? `${completed} cataloghi indicizzati`
            : '',
        failed === 1 ? '1 errore' : failed > 1 ? `${failed} errori` : '',
      ]
        .filter(Boolean)
        .join(', ')
      setMessage(summary ? `${summary}.` : 'Nessun catalogo elaborato.')
      await refresh(true)
    } finally {
      setBusy(false)
    }
  }

  async function removeCatalog(catalog: AdminCatalog) {
    if (!session || !window.confirm(`Eliminare ${catalog.original_filename}?`)) return
    setBusy(true)
    const response = await authenticatedFetch(
      `/api/admin/catalogs?catalogId=${encodeURIComponent(catalog.id)}`,
      { method: 'DELETE' },
    )
    const payload = await readApiPayload(response)
    setMessage(
      response.ok
        ? 'Catalogo eliminato.'
        : payload.error || 'Eliminazione non riuscita.',
    )
    setBusy(false)
    await refresh()
  }

  async function retryCatalog(catalog: AdminCatalog) {
    const retryableJob = catalog.ingestion_jobs?.find((job) =>
      ['failed', 'completed'].includes(job.status) || isStaleJob(job),
    )
    if (!retryableJob || !session) return
    setBusy(true)
    setMessage(`Nuova indicizzazione di ${catalog.original_filename}…`)
    try {
      await runIndexing(catalog.id, retryableJob.id, {
        // Rigenera da zero solo i cataloghi già pronti; in needs_review continua.
        resetAi: catalog.status === 'ready',
      })
      setMessage('Indicizzazione completata.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Indicizzazione non riuscita.')
    } finally {
      setBusy(false)
      await refresh()
    }
  }

  async function approveCatalog(catalog: AdminCatalog) {
    if (
      !session ||
      !window.confirm(
        `Confermi di aver verificato ${catalog.original_filename} e di volerlo rendere operativo?`,
      )
    ) return
    setBusy(true)
    const response = await authenticatedFetch('/api/admin/catalogs', {
      method: 'PATCH',
      body: JSON.stringify({ action: 'approve', catalogId: catalog.id }),
    })
    const payload = await readApiPayload(response)
    setMessage(
      response.ok
        ? 'Catalogo approvato e disponibile nella ricerca.'
        : payload.error || 'Approvazione non riuscita.',
    )
    setBusy(false)
    await refresh()
  }

  if (loading) return <div className="admin-empty"><LoaderCircle className="spin" /></div>
  if (!supabase) {
    return (
      <div className="admin-empty">
        <AlertCircle />
        <h2>Supabase non configurato</h2>
        <p>Imposta VITE_SUPABASE_URL e VITE_SUPABASE_PUBLISHABLE_KEY.</p>
      </div>
    )
  }
  const runnable = queue.filter(
    (item) => item.status === 'pending' || item.status === 'error',
  )
  const onlyErrors =
    runnable.length > 0 && runnable.every((item) => item.status === 'error')

  if (role !== 'admin') {
    return (
      <div className="admin-empty">
        <AlertCircle />
        <h2>Account non amministratore</h2>
        <p>Promuovi questo utente dal SQL Editor Supabase, quindi aggiorna.</p>
        <div className="admin-actions">
          <button onClick={() => void refresh()}><RefreshCw size={16} /> Aggiorna</button>
        </div>
      </div>
    )
  }

  return (
    <section className="admin-layout">
      <header className="admin-header">
        <div>
          <span className="eyebrow">Area riservata</span>
          <h2>Gestione cataloghi</h2>
        </div>
      </header>
      <form className="upload-card" onSubmit={submitCatalog}>
        <div className="upload-title"><FileUp /><div><h3>Nuovi cataloghi PDF</h3><p>Carica uno o più documenti: i dati vengono riconosciuti automaticamente, un catalogo alla volta.</p></div></div>
        <label
          className={`file-drop${dragOver ? ' drag-over' : ''}`}
          onDragEnter={(event) => {
            event.preventDefault()
            if (!busy) setDragOver(true)
          }}
          onDragOver={(event) => {
            event.preventDefault()
            if (!busy) setDragOver(true)
          }}
          onDragLeave={(event) => {
            const next = event.relatedTarget
            if (!(next instanceof Node) || !event.currentTarget.contains(next)) {
              setDragOver(false)
            }
          }}
          onDrop={(event) => {
            event.preventDefault()
            setDragOver(false)
            if (!busy && event.dataTransfer.files.length) {
              addFiles(event.dataTransfer.files)
            }
          }}
        >
          <input
            name="catalogPdf"
            type="file"
            accept="application/pdf,.pdf"
            multiple
            disabled={busy}
            onChange={(event) => {
              if (event.target.files?.length) addFiles(event.target.files)
              event.target.value = ''
            }}
          />
          <FileUp />
          <strong>
            {queue.length
              ? `${queue.length} PDF in coda`
              : 'Seleziona o trascina uno o più PDF'}
          </strong>
          <span>Massimo 250 MB per file. L’indicizzazione procede in sequenza.</span>
        </label>
        {queue.length > 0 && (
          <ul className="upload-queue">
            {queue.map((item) => (
              <li key={item.id} className={`upload-queue-item ${item.status}`}>
                <strong title={item.file.name}>{item.file.name}</strong>
                <span className={`queue-status ${item.status}`}>
                  {queueStatusLabel(item)}
                </span>
                {(item.status === 'pending' || item.status === 'error') && (
                  <button
                    type="button"
                    onClick={() =>
                      setQueue((current) =>
                        current.filter((entry) => entry.id !== item.id),
                      )
                    }
                    disabled={busy}
                    aria-label={`Rimuovi ${item.file.name}`}
                  >
                    <X size={15} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="auto-detect-note">
          <CheckCircle2 size={18} />
          <div>
            <strong>Riconoscimento automatico</strong>
            <span>Brand, modello, versione, revisione, cliente, ordine e matricole saranno estratti dal PDF.</span>
          </div>
        </div>
        {busy && queue.some((item) => item.status === 'uploading') && (
          <div className="upload-progress">
            <span
              style={{
                width: `${queue.find((item) => item.status === 'uploading')?.progress || 0}%`,
              }}
            />
          </div>
        )}
        <button className="primary-button" disabled={busy || runnable.length === 0}>
          {busy ? <LoaderCircle className="spin" size={18} /> : <FileUp size={18} />}
          {busy
            ? 'Operazione in corso'
            : onlyErrors
              ? runnable.length > 1
                ? `Riprova i cataloghi in errore (${runnable.length})`
                : 'Riprova il catalogo in errore'
              : runnable.length > 1
                ? `Carica e indicizza (${runnable.length})`
                : 'Carica e indicizza'}
        </button>
        {message && <p className="form-message">{message}</p>}
      </form>
      <div className="catalog-admin-list">
        <div className="list-heading"><h3>Cataloghi</h3><button type="button" onClick={() => void refresh()} disabled={busy}><RefreshCw size={16} /> Aggiorna</button></div>
        {catalogs.map((catalog) => {
          const bundled = catalog.source === 'bundled' || catalog.id.startsWith('bundled:')
          const job = catalog.ingestion_jobs?.at(0)
          const stale = !bundled && isStaleJob(job)
          const state = bundled
            ? 'ready'
            : ['ready', 'needs_review', 'failed'].includes(catalog.status)
              ? catalog.status
              : job?.status || catalog.status
          const retryableReview =
            !bundled &&
            state === 'needs_review' &&
            Boolean(
              job?.report?.remainingAiPages?.length ||
              job?.report?.aiErrors?.length,
            )
          return (
            <article key={catalog.id} className="admin-catalog-row">
              <div className={`status-dot ${state}`} />
              <div className="admin-catalog-main">
                <strong>{catalog.brand} · {catalog.model}</strong>
                <span>{catalog.original_filename}</span>
              </div>
              <div className="admin-catalog-meta">
                <span className="status-badge">
                  {state === 'ready' && (catalog.part_count || 0) > 0 && (
                    <CheckCircle2 size={14} />
                  )}
                  {statusLabel(state, catalog.part_count)}{' '}
                  {bundled ? '' : job?.progress ? `${job.progress}%` : ''}
                </span>
                <div className="admin-row-actions">
                  {!bundled &&
                    (state === 'ready' ||
                      state === 'failed' ||
                      retryableReview ||
                      stale) && (
                      <button
                        className="icon-retry"
                        onClick={() => void retryCatalog(catalog)}
                        disabled={busy}
                        aria-label={
                          state === 'ready'
                            ? 'Rigenera indice ed esplosi'
                            : 'Riprova indicizzazione'
                        }
                        title={
                          state === 'ready'
                            ? 'Rigenera indice ed esplosi'
                            : 'Riprova indicizzazione'
                        }
                      >
                        <RefreshCw size={17} />
                      </button>
                    )}
                  {!bundled && state === 'needs_review' && (
                    <button
                      className="icon-approve"
                      onClick={() => void approveCatalog(catalog)}
                      disabled={busy}
                      aria-label="Approva catalogo"
                      title="Approva catalogo"
                    >
                      <BadgeCheck size={17} />
                    </button>
                  )}
                  {!bundled && (
                    <button
                      className="icon-danger"
                      onClick={() => void removeCatalog(catalog)}
                      disabled={busy}
                      aria-label="Elimina catalogo"
                    >
                      <Trash2 size={17} />
                    </button>
                  )}
                </div>
              </div>
            </article>
          )
        })}
        {!catalogs.length && <p className="empty-list">Nessun catalogo caricato.</p>}
      </div>
    </section>
  )
}

