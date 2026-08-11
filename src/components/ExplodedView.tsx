import {
  ChevronLeft,
  ChevronRight,
  Layers,
  LoaderCircle,
  PackageOpen,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import {
  ApiError,
  getIndexedParts,
  type CatalogPart,
} from '../lib/api'

type AssemblyGroup = {
  key: string
  catalogId: string
  catalogName: string
  page: number
  title: string
  code: string
  parts: CatalogPart[]
  pdfAvailable: boolean
}

export default function ExplodedView() {
  const [parts, setParts] = useState<CatalogPart[]>([])
  const [catalogFilter, setCatalogFilter] = useState('')
  const [selectedKey, setSelectedKey] = useState('')
  const [selectedItem, setSelectedItem] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    setIsLoading(true)
    getIndexedParts()
      .then((result) => {
        if (!active) return
        setParts(result.parts)
      })
      .catch((requestError: unknown) => {
        if (!active) return
        setError(
          requestError instanceof ApiError
            ? requestError.message
            : 'Impossibile caricare gli esplosi.',
        )
      })
      .finally(() => {
        if (active) setIsLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  const assemblies = useMemo(() => {
    const groups = new Map<string, AssemblyGroup>()
    for (const part of parts) {
      if (!part.catalogId || !part.page) continue
      const key = `${part.catalogId}:${part.page}`
      const existing = groups.get(key)
      if (existing) {
        existing.parts.push(part)
        continue
      }
      groups.set(key, {
        key,
        catalogId: part.catalogId,
        catalogName: part.catalogName || 'Catalogo',
        page: part.page,
        title: part.assemblyTitle || part.category || `Pagina ${part.page}`,
        code: part.assemblyCode || '',
        parts: [part],
        pdfAvailable: Boolean(part.pdfAvailable),
      })
    }
    return [...groups.values()].sort(
      (left, right) =>
        left.catalogName.localeCompare(right.catalogName, 'it') ||
        left.page - right.page,
    )
  }, [parts])

  const catalogs = useMemo(
    () =>
      [...new Set(assemblies.map((assembly) => assembly.catalogName))].sort((a, b) =>
        a.localeCompare(b, 'it'),
      ),
    [assemblies],
  )

  const visibleAssemblies = useMemo(
    () =>
      assemblies.filter(
        (assembly) => !catalogFilter || assembly.catalogName === catalogFilter,
      ),
    [assemblies, catalogFilter],
  )

  useEffect(() => {
    if (!visibleAssemblies.length) {
      setSelectedKey('')
      return
    }
    if (!visibleAssemblies.some((assembly) => assembly.key === selectedKey)) {
      setSelectedKey(visibleAssemblies[0].key)
    }
  }, [selectedKey, visibleAssemblies])

  const selectedAssembly = visibleAssemblies.find(
    (assembly) => assembly.key === selectedKey,
  )

  useEffect(() => {
    setSelectedItem(selectedAssembly?.parts[0]?.item || '')
  }, [selectedAssembly])

  const activeParts = selectedAssembly?.parts || []
  const selectedPart =
    activeParts.find((part) => part.item === selectedItem) || activeParts[0]
  const selectedIndex = Math.max(
    0,
    visibleAssemblies.findIndex((assembly) => assembly.key === selectedKey),
  )
  const pdfSrc =
    selectedAssembly?.pdfAvailable
      ? `/api/pdf?catalogId=${encodeURIComponent(selectedAssembly.catalogId)}&page=${selectedAssembly.page}`
      : ''

  if (isLoading) {
    return (
      <div className="catalog-state">
        <LoaderCircle className="spin" size={25} />
        <strong>Caricamento esplosi</strong>
        <span>Sto preparando le tavole e i riferimenti ricambio.</span>
      </div>
    )
  }

  if (!assemblies.length) {
    return (
      <div className="catalog-state error">
        <PackageOpen size={27} />
        <strong>Nessun esploso disponibile</strong>
        <span>
          {error ||
            'Indicizza un catalogo con ricambi per pagina per navigare le tavole.'}
        </span>
      </div>
    )
  }

  return (
    <div className="exploded-view">
      <div className="catalog-hero">
        <div>
          <span className="catalog-kicker">Tavole interattive</span>
          <h2>Esplosi catalogo</h2>
          <p>Clicca un pallino numerato per aprire il ricambio corrispondente.</p>
        </div>
        <div className="exploded-hero-filters">
          <label className="exploded-catalog-filter">
            <span>Macchina</span>
            <select
              value={catalogFilter}
              onChange={(event) => setCatalogFilter(event.target.value)}
            >
              <option value="">Tutte</option>
              {catalogs.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label className="exploded-catalog-filter exploded-table-filter">
            <span>Tavola</span>
            <select
              value={selectedKey}
              onChange={(event) => setSelectedKey(event.target.value)}
              aria-label="Seleziona tavola esploso"
            >
              {visibleAssemblies.map((assembly) => (
                <option key={assembly.key} value={assembly.key}>
                  {assembly.title}
                  {assembly.code ? ` · ${assembly.code}` : ''} · pag. {assembly.page}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div className="exploded-layout">
        <section className="exploded-stage">
          <div className="exploded-toolbar">
            <button
              type="button"
              disabled={selectedIndex <= 0}
              onClick={() =>
                setSelectedKey(visibleAssemblies[selectedIndex - 1]?.key || '')
              }
              aria-label="Tavola precedente"
            >
              <ChevronLeft size={18} />
            </button>
            <div>
              <strong>{selectedAssembly?.title}</strong>
              <span>
                {selectedAssembly?.catalogName} · pagina {selectedAssembly?.page}
              </span>
            </div>
            <button
              type="button"
              disabled={selectedIndex >= visibleAssemblies.length - 1}
              onClick={() =>
                setSelectedKey(visibleAssemblies[selectedIndex + 1]?.key || '')
              }
              aria-label="Tavola successiva"
            >
              <ChevronRight size={18} />
            </button>
          </div>

          <div className="exploded-canvas-wrap exploded-split">
            <div className="exploded-pdf-frame">
              {pdfSrc ? (
                <iframe title={`Esploso pagina ${selectedAssembly?.page}`} src={pdfSrc} />
              ) : (
                <div className="exploded-canvas-state">
                  <PackageOpen size={24} />
                  <span>PDF non disponibile per questa tavola. Usa i pallini a destra.</span>
                </div>
              )}
            </div>

            <div className="exploded-hotspot-board" aria-label="Posizioni cliccabili">
              {activeParts.map((part) => (
                <button
                  key={`${part.item}-${part.code}`}
                  type="button"
                  className={`exploded-hotspot static ${
                    selectedItem === part.item ? 'active' : ''
                  }`}
                  onClick={() => setSelectedItem(part.item)}
                  title={part.description}
                >
                  {part.item || '·'}
                </button>
              ))}
            </div>
          </div>
        </section>

        <aside className="exploded-part-panel">
          <div className="exploded-part-heading">
            <Layers size={18} />
            <span>Ricambio selezionato</span>
          </div>
          {selectedPart ? (
            <>
              <span className="exploded-item-pill">Pos. {selectedPart.item || '—'}</span>
              <h3>{selectedPart.description}</h3>
              <p>{selectedPart.originalDescription}</p>
              <dl>
                <div>
                  <dt>Codice</dt>
                  <dd>{selectedPart.code}</dd>
                </div>
                <div>
                  <dt>Quantità</dt>
                  <dd>{selectedPart.quantity}</dd>
                </div>
                <div>
                  <dt>Categoria</dt>
                  <dd>{selectedPart.category}</dd>
                </div>
                <div>
                  <dt>Pagina</dt>
                  <dd>{selectedPart.page}</dd>
                </div>
              </dl>
              {selectedAssembly?.pdfAvailable && (
                <a
                  className="exploded-pdf-link"
                  href={`/api/pdf?catalogId=${encodeURIComponent(
                    selectedAssembly.catalogId,
                  )}&page=${selectedAssembly.page}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Apri pagina PDF
                </a>
              )}
            </>
          ) : (
            <p>Seleziona un pallino sull’esploso.</p>
          )}

          <div className="exploded-item-list">
            <span>Posizioni sulla tavola</span>
            <div>
              {activeParts.map((part) => (
                <button
                  key={`${part.item}-${part.code}-${part.page}`}
                  type="button"
                  className={selectedItem === part.item ? 'active' : ''}
                  onClick={() => setSelectedItem(part.item)}
                >
                  <strong>{part.item || '—'}</strong>
                  <span>{part.code}</span>
                </button>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}
