import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import * as tus from 'tus-js-client'
import {
  AlertCircle,
  CheckCircle2,
  FileUp,
  LoaderCircle,
  LogIn,
  LogOut,
  RefreshCw,
  Trash2,
} from 'lucide-react'
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
  status: string
  part_count: number
  created_at: string
  ingestion_jobs?: Array<{
    id: string
    status: string
    progress: number
    error_message?: string
  }>
}

const initialForm = {
  brand: '',
  model: '',
  version: '',
  customer: '',
  orderReference: '',
  revision: '1',
  serialNumbers: '',
}

function statusLabel(status: string) {
  const labels: Record<string, string> = {
    uploaded: 'Caricato',
    queued: 'In coda',
    processing: 'Indicizzazione',
    ready: 'Pronto',
    needs_review: 'Da verificare',
    failed: 'Errore',
  }
  return labels[status] || status
}

export function AdminCatalogs() {
  const [session, setSession] = useState<Session | null>(null)
  const [role, setRole] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [authMode, setAuthMode] = useState<'login' | 'signup'>('login')
  const [form, setForm] = useState(initialForm)
  const [file, setFile] = useState<File>()
  const [progress, setProgress] = useState(0)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [catalogs, setCatalogs] = useState<AdminCatalog[]>([])

  useEffect(() => {
    if (!supabase) {
      setLoading(false)
      return
    }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoading(false)
    })
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession)
      if (!nextSession) setRole(undefined)
    })
    return () => data.subscription.unsubscribe()
  }, [])

  const authHeaders = useMemo(
    () =>
      session
        ? {
            Authorization: `Bearer ${session.access_token}`,
            'Content-Type': 'application/json',
          }
        : undefined,
    [session],
  )

  const refresh = useCallback(async () => {
    if (!supabase || !session || !authHeaders) return
    const { data } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', session.user.id)
      .single()
    setRole(data?.role)
    if (data?.role !== 'admin') return
    const response = await fetch('/api/admin/catalogs', { headers: authHeaders })
    const payload = await response.json()
    if (response.ok) setCatalogs(payload.catalogs || [])
  }, [authHeaders, session])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function authenticate(event: React.FormEvent) {
    event.preventDefault()
    if (!supabase) return
    setBusy(true)
    setMessage('')
    const result =
      authMode === 'login'
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password })
    setBusy(false)
    setMessage(
      result.error
        ? result.error.message
        : authMode === 'signup'
          ? 'Account creato. Conferma l’email, poi chiedi la promozione ad admin.'
          : 'Accesso effettuato.',
    )
  }

  function uploadTus(selectedFile: File, objectName: string) {
    return new Promise<void>((resolve, reject) => {
      if (!supabaseUrl || !supabasePublishableKey || !session) {
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
          authorization: `Bearer ${session.access_token}`,
          apikey: supabasePublishableKey,
          'x-upsert': 'false',
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

  async function submitCatalog(event: React.FormEvent) {
    event.preventDefault()
    if (!file || !session || !authHeaders) return
    if (file.type !== 'application/pdf' || file.size === 0) {
      setMessage('Seleziona un PDF valido e non vuoto.')
      return
    }
    if (file.size > 250 * 1024 * 1024) {
      setMessage('Il PDF supera il limite di 250 MB.')
      return
    }
    const serialNumbers = form.serialNumbers
      .split(/[\s,;]+/)
      .map((item) => item.trim())
      .filter(Boolean)
    if (!serialNumbers.length) {
      setMessage('Inserisci almeno una matricola.')
      return
    }

    setBusy(true)
    setMessage('Caricamento PDF in corso…')
    setProgress(0)
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
    const storagePath = `${session.user.id}/${crypto.randomUUID()}-${safeName}`
    try {
      await uploadTus(file, storagePath)
      setMessage('Registrazione catalogo…')
      const createResponse = await fetch('/api/admin/catalogs', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          ...form,
          serialNumbers,
          storagePath,
          originalFilename: file.name,
          fileSize: file.size,
        }),
      })
      const created = await createResponse.json()
      if (!createResponse.ok) throw new Error(created.error)

      setMessage('Indicizzazione in corso…')
      const indexResponse = await fetch('/api/index_catalog', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          catalogId: created.catalogId,
          jobId: created.jobId,
        }),
      })
      const indexed = await indexResponse.json()
      if (!indexResponse.ok) throw new Error(indexed.error)
      setMessage(
        indexed.status === 'needs_review'
          ? 'Indicizzazione completata: alcune pagine richiedono verifica.'
          : `Catalogo pronto: ${indexed.accepted || 0} ricambi indicizzati.`,
      )
      setFile(undefined)
      setForm(initialForm)
      setProgress(0)
      await refresh()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Operazione non riuscita.')
    } finally {
      setBusy(false)
    }
  }

  async function removeCatalog(catalog: AdminCatalog) {
    if (!authHeaders || !window.confirm(`Eliminare ${catalog.original_filename}?`)) return
    setBusy(true)
    const response = await fetch(
      `/api/admin/catalogs?catalogId=${encodeURIComponent(catalog.id)}`,
      { method: 'DELETE', headers: authHeaders },
    )
    const payload = await response.json()
    setMessage(response.ok ? 'Catalogo eliminato.' : payload.error)
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
  if (!session) {
    return (
      <section className="admin-auth">
        <LogIn size={30} />
        <h2>{authMode === 'login' ? 'Accesso amministratore' : 'Crea account'}</h2>
        <form onSubmit={authenticate}>
          <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <input type="password" placeholder="Password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} required />
          <button className="primary-button" disabled={busy}>
            {busy ? <LoaderCircle className="spin" size={18} /> : 'Continua'}
          </button>
        </form>
        <button className="link-button" onClick={() => setAuthMode(authMode === 'login' ? 'signup' : 'login')}>
          {authMode === 'login' ? 'Crea un account' : 'Ho già un account'}
        </button>
        {message && <p className="form-message">{message}</p>}
      </section>
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
          <button onClick={() => void supabase.auth.signOut()}><LogOut size={16} /> Esci</button>
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
        <button className="secondary-button" onClick={() => void supabase.auth.signOut()}>
          <LogOut size={16} /> Esci
        </button>
      </header>
      <form className="upload-card" onSubmit={submitCatalog}>
        <div className="upload-title"><FileUp /><div><h3>Nuovo catalogo PDF</h3><p>Upload riprendibile e indicizzazione automatica.</p></div></div>
        <label className="file-drop">
          <input type="file" accept="application/pdf,.pdf" onChange={(e) => setFile(e.target.files?.[0])} required />
          <FileUp />
          <strong>{file?.name || 'Seleziona o trascina un PDF'}</strong>
          <span>Massimo 250 MB</span>
        </label>
        <div className="metadata-grid">
          <label>Brand<input value={form.brand} onChange={(e) => setForm({ ...form, brand: e.target.value })} required /></label>
          <label>Modello<input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} required /></label>
          <label>Versione<input value={form.version} onChange={(e) => setForm({ ...form, version: e.target.value })} /></label>
          <label>Revisione<input value={form.revision} onChange={(e) => setForm({ ...form, revision: e.target.value })} /></label>
          <label>Cliente<input value={form.customer} onChange={(e) => setForm({ ...form, customer: e.target.value })} /></label>
          <label>Ordine / AR<input value={form.orderReference} onChange={(e) => setForm({ ...form, orderReference: e.target.value })} /></label>
          <label className="wide">Matricole<textarea value={form.serialNumbers} onChange={(e) => setForm({ ...form, serialNumbers: e.target.value })} placeholder="13510073, 13510074" required /></label>
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
          const job = catalog.ingestion_jobs?.at(0)
          const state = job?.status || catalog.status
          return (
            <article key={catalog.id} className="admin-catalog-row">
              <div className={`status-dot ${state}`} />
              <div className="admin-catalog-main">
                <strong>{catalog.brand} · {catalog.model}</strong>
                <span>{catalog.original_filename}</span>
                {job?.error_message && <small>{job.error_message}</small>}
              </div>
              <span className="status-badge">{state === 'ready' && <CheckCircle2 size={14} />}{statusLabel(state)} {job?.progress ? `${job.progress}%` : ''}</span>
              <span>{catalog.part_count || 0} ricambi</span>
              <button className="icon-danger" onClick={() => void removeCatalog(catalog)} disabled={busy} aria-label="Elimina catalogo"><Trash2 size={17} /></button>
            </article>
          )
        })}
        {!catalogs.length && <p className="empty-list">Nessun catalogo caricato.</p>}
      </div>
    </section>
  )
}

