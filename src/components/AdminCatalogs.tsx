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

function statusLabel(status: string) {
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

function reportSummary(
  job: NonNullable<AdminCatalog['ingestion_jobs']>[number] | undefined,
) {
  const report = job?.report
  // Per ora non mostriamo errori Claude/aiErrors in lista (es. ANTHROPIC_INVALID_JSON).
  if (report?.unresolvedPages?.length) {
    const preview = report.unresolvedPages.slice(0, 5).join(', ')
    return `${report.unresolvedPages.length} pagine non risolte (${preview}${report.unresolvedPages.length > 5 ? ', …' : ''})`
  }
  if (report?.detectedMetadata?.missing?.length) {
    return `Metadati mancanti: ${report.detectedMetadata.missing.join(', ')}`
  }
  if (report?.aiParts !== undefined) {
    const extraction = `Estrazione: ${report.deterministicParts || 0} deterministici + ${report.aiParts} Claude`
    return report.explodedError
      ? `${extraction} · Ricambi salvati; per gli esplosi applica la migration 002`
      : extraction
  }
  if (report?.explodedError) {
    return 'Ricambi salvati; per gli esplosi applica la migration 002'
  }
  return ''
}

function visibleJobError(message?: string) {
  if (!message) return ''
  if (/ANTHROPIC_INVALID_JSON|Anthropic non ha restituito/i.test(message)) {
    return ''
  }
  return message
}

function isStaleJob(
  job: NonNullable<AdminCatalog['ingestion_jobs']>[number] | undefined,
) {
  if (job?.status !== 'running' || !job.updated_at) return false
  const updatedAt = Date.parse(job.updated_at)
  return Number.isFinite(updatedAt) && Date.now() - updatedAt >= 6 * 60 * 1000
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
  const [file, setFile] = useState<File>()
  const [progress, setProgress] = useState(0)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [catalogs, setCatalogs] = useState<AdminCatalog[]>([])

  const refresh = useCallback(async () => {
    if (!supabase || !session) return
    setLoading(true)
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
      setMessage(
        error instanceof Error ? error.message : 'Sessione non disponibile.',
      )
    } finally {
      setLoading(false)
    }
  }, [session])

  useEffect(() => {
    void refresh()
  }, [refresh])

  function uploadTus(selectedFile: File, objectName: string) {
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
          setProgress(Math.round((uploaded / total) * 100)),
        onSuccess: () => resolve(),
      })
      upload.findPreviousUploads().then((previous) => {
        if (previous[0]) upload.resumeFromPreviousUpload(previous[0])
        upload.start()
      })
    })
  }

  async function runIndexing(catalogId: string, jobId: string) {
    let latest: ApiPayload = {}
    let previousRemaining = ''
    let stalledPasses = 0
    for (let pass = 1; pass <= 500; pass += 1) {
      const response = await authenticatedFetch('/api/index_catalog', {
        method: 'POST',
        body: JSON.stringify({ catalogId, jobId }),
      })
      latest = await readApiPayload(response)
      if (!response.ok) {
        throw new Error(latest.error || 'Indicizzazione non riuscita.')
      }
      const remainingPages = latest.report?.remainingAiPages || []
      const remaining = remainingPages.length
      if (!remaining || latest.report?.aiErrors?.length) return latest
      const signature = remainingPages.join(',')
      stalledPasses = signature === previousRemaining ? stalledPasses + 1 : 0
      if (stalledPasses >= 3) {
        throw new Error(
          `Indicizzazione senza avanzamento: restano ${remaining} pagine. Premi Riprova.`,
        )
      }
      previousRemaining = signature
      setMessage(
        `Indicizzazione in corso: ${remaining} pagine Claude ancora da elaborare (passaggio ${pass})…`,
      )
      await new Promise((resolve) => window.setTimeout(resolve, 500))
    }
    throw new Error(
      'Indicizzazione oltre il limite di sicurezza di 500 passaggi. Premi Riprova per continuare.',
    )
  }

  async function submitCatalog(event: React.FormEvent) {
    event.preventDefault()
    if (!file || !session) return
    if (file.type !== 'application/pdf' || file.size === 0) {
      setMessage('Seleziona un PDF valido e non vuoto.')
      return
    }
    if (file.size > 250 * 1024 * 1024) {
      setMessage('Il PDF supera il limite di 250 MB.')
      return
    }
    setBusy(true)
    setMessage('Caricamento PDF in corso…')
    setProgress(0)
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
    try {
      const active = await getValidSession()
      const storagePath = `${active.user.id}/${crypto.randomUUID()}-${safeName}`
      await uploadTus(file, storagePath)
      setMessage('Registrazione catalogo…')
      const createResponse = await authenticatedFetch('/api/admin/catalogs', {
        method: 'POST',
        body: JSON.stringify({
          storagePath,
          originalFilename: file.name,
          fileSize: file.size,
        }),
      })
      const created = await readApiPayload(createResponse)
      if (!createResponse.ok || !created.catalogId || !created.jobId) {
        throw new Error(created.error || 'Catalogo non registrato.')
      }

      setMessage('Indicizzazione in corso…')
      const indexed = await runIndexing(created.catalogId, created.jobId)
      setMessage(
        indexed.status === 'needs_review'
          ? 'Indicizzazione completata: alcune pagine richiedono verifica.'
          : `Catalogo pronto: ${indexed.accepted || 0} ricambi indicizzati.`,
      )
      setFile(undefined)
      setProgress(0)
      await refresh()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Operazione non riuscita.')
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
      const payload = await runIndexing(catalog.id, retryableJob.id)
      const detail = reportSummary({
        id: retryableJob.id,
        status: payload.status || 'needs_review',
        progress: 100,
        report: payload.report,
      })
      setMessage(
        `Catalogo aggiornato: ${payload.accepted || 0} ricambi indicizzati.${detail ? ` ${detail}.` : ''}`,
      )
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
        <div className="upload-title"><FileUp /><div><h3>Nuovo catalogo PDF</h3><p>Carica il documento: tutti i dati vengono riconosciuti automaticamente.</p></div></div>
        <label className="file-drop">
          <input name="catalogPdf" type="file" accept="application/pdf,.pdf" onChange={(e) => setFile(e.target.files?.[0])} required />
          <FileUp />
          <strong>{file?.name || 'Seleziona o trascina un PDF'}</strong>
          <span>Massimo 250 MB</span>
        </label>
        <div className="auto-detect-note">
          <CheckCircle2 size={18} />
          <div>
            <strong>Riconoscimento automatico</strong>
            <span>Brand, modello, versione, revisione, cliente, ordine e matricole saranno estratti dal PDF.</span>
          </div>
        </div>
        {busy && progress > 0 && <div className="upload-progress"><span style={{ width: `${progress}%` }} /></div>}
        <button className="primary-button" disabled={busy || !file}>
          {busy ? <LoaderCircle className="spin" size={18} /> : <FileUp size={18} />}
          {busy ? 'Operazione in corso' : 'Carica e indicizza'}
        </button>
        {message && <p className="form-message">{message}</p>}
      </form>
      <div className="catalog-admin-list">
        <div className="list-heading"><h3>Cataloghi</h3><button onClick={() => void refresh()}><RefreshCw size={16} /> Aggiorna</button></div>
        {catalogs.map((catalog) => {
          const bundled = catalog.source === 'bundled' || catalog.id.startsWith('bundled:')
          const job = catalog.ingestion_jobs?.at(0)
          const stale = !bundled && isStaleJob(job)
          const jobError = bundled ? '' : visibleJobError(job?.error_message)
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
                {jobError ? (
                  <small className="index-error">{jobError}</small>
                ) : null}
                {job?.report?.explodedError && (
                  <small className="index-error">
                    Esplosi [{job.report.explodedError.code || 'errore'}]:{' '}
                    {job.report.explodedError.message || 'asset non salvati'}
                  </small>
                )}
              </div>
              <div className="admin-catalog-meta">
                <span className="status-badge">
                  {state === 'ready' && <CheckCircle2 size={14} />}
                  {statusLabel(state)}{' '}
                  {bundled ? '' : job?.progress ? `${job.progress}%` : ''}
                </span>
                <span>{catalog.part_count || 0} ricambi</span>
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

