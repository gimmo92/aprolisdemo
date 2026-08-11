import {
  ChevronLeft,
  ChevronRight,
  Layers,
  LoaderCircle,
  PackageOpen,
  Search,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ApiError,
  getExplodedView,
  getExplodedViews,
  type CatalogPart,
  type ExplodedViewResponse,
  type ExplodedViewSummary,
} from '../lib/api'

export type ExplodedSelection = {
  viewId: string
  item: string
}

type Props = {
  selection?: ExplodedSelection
  onSelectionChange?: (selection: ExplodedSelection) => void
}

function normalize(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('it')
    .trim()
}

export default function ExplodedView({ selection, onSelectionChange }: Props) {
  const [views, setViews] = useState<ExplodedViewSummary[]>([])
  const [detail, setDetail] = useState<ExplodedViewResponse>()
  const [catalogFilter, setCatalogFilter] = useState('')
  const [selectedKey, setSelectedKey] = useState('')
  const [selectedItem, setSelectedItem] = useState('')
  const [hoveredItem, setHoveredItem] = useState('')
  const [query, setQuery] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [isPageLoading, setIsPageLoading] = useState(false)
  const [error, setError] = useState('')
  const rowRefs = useRef<Record<string, HTMLButtonElement | null>>({})

  useEffect(() => {
    let active = true
    getExplodedViews()
      .then(({ views: nextViews }) => {
        if (active) setViews(nextViews)
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

  const catalogs = useMemo(
    () =>
      [...new Set(views.map((view) => view.machine))].sort((a, b) =>
        a.localeCompare(b, 'it'),
      ),
    [views],
  )
  const visibleViews = useMemo(
    () =>
      views.filter((view) => !catalogFilter || view.machine === catalogFilter),
    [catalogFilter, views],
  )

  useEffect(() => {
    if (selection?.viewId && views.some((view) => view.id === selection.viewId)) {
      setSelectedKey(selection.viewId)
    }
  }, [selection?.viewId, views])

  useEffect(() => {
    setSelectedKey((current) =>
      visibleViews.some((view) => view.id === current)
        ? current
        : visibleViews[0]?.id || '',
    )
  }, [visibleViews])

  useEffect(() => {
    if (!selectedKey) {
      setDetail(undefined)
      return
    }
    let active = true
    setIsPageLoading(true)
    setError('')
    getExplodedView(selectedKey)
      .then((nextDetail) => {
        if (!active) return
        setDetail(nextDetail)
        setSelectedItem(nextDetail.parts[0]?.item || '')
      })
      .catch((requestError: unknown) => {
        if (!active) return
        setDetail(undefined)
        setError(
          requestError instanceof ApiError
            ? requestError.message
            : 'Tavola non disponibile.',
        )
      })
      .finally(() => {
        if (active) setIsPageLoading(false)
      })
    return () => {
      active = false
    }
  }, [selectedKey])

  useEffect(() => {
    if (
      selection?.viewId === selectedKey &&
      detail?.parts.some((part) => part.item === selection.item)
    ) {
      setSelectedItem(selection.item)
    }
  }, [detail?.parts, selectedKey, selection])

  const selectItem = (item: string) => {
    setSelectedItem(item)
    onSelectionChange?.({ viewId: selectedKey, item })
  }

  useEffect(() => {
    rowRefs.current[selectedItem]?.scrollIntoView({
      block: 'nearest',
      behavior: 'smooth',
    })
  }, [selectedItem])

  const normalizedQuery = normalize(query)
  const matchingItems = useMemo(
    () =>
      new Set(
        (detail?.parts || [])
          .filter((part) =>
            normalize(
              `${part.item} ${part.code} ${part.description} ${part.originalDescription}`,
            ).includes(normalizedQuery),
          )
          .map((part) => part.item),
      ),
    [detail?.parts, normalizedQuery],
  )
  const visibleParts = (detail?.parts || []).filter(
    (part) => !normalizedQuery || matchingItems.has(part.item),
  )
  const selectedCallout = detail?.callouts.find((callout) =>
    callout.items.includes(selectedItem),
  )
  const selectedItems = selectedCallout?.items || [selectedItem]
  const selectedParts =
    detail?.parts.filter((part) => selectedItems.includes(part.item)) || []
  const selectedPart = selectedParts[0] || detail?.parts[0]
  const selectedIndex = Math.max(
    0,
    visibleViews.findIndex((view) => view.id === selectedKey),
  )
  const activePulseItem = hoveredItem || selectedItem

  if (isLoading) {
    return (
      <div className="catalog-state">
        <LoaderCircle className="spin" size={25} />
        <strong>Caricamento esplosi</strong>
        <span>Sto preparando le tavole e i riferimenti ricambio.</span>
      </div>
    )
  }

  if (!views.length) {
    return (
      <div className="catalog-state error">
        <PackageOpen size={27} />
        <strong>Nessun esploso disponibile</strong>
        <span>
          {error ||
            'Indicizza nuovamente un catalogo per generare SVG e callout lato server.'}
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
          <p>Clicca un pallino sul disegno per aprire il ricambio corrispondente.</p>
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
              {visibleViews.map((view) => (
                <option key={view.id} value={view.id}>
                  {view.title}
                  {view.figureCode ? ` · ${view.figureCode}` : ''} · tavola{' '}
                  {view.pageIndex}
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
                setSelectedKey(visibleViews[selectedIndex - 1]?.id || '')
              }
              aria-label="Tavola precedente"
            >
              <ChevronLeft size={18} />
            </button>
            <div>
              <strong>{detail?.view.title}</strong>
              <span>
                {detail?.view.machine} · {detail?.view.figureCode} · tavola{' '}
                {detail?.view.pageIndex}
              </span>
            </div>
            <button
              type="button"
              disabled={selectedIndex >= visibleViews.length - 1}
              onClick={() =>
                setSelectedKey(visibleViews[selectedIndex + 1]?.id || '')
              }
              aria-label="Tavola successiva"
            >
              <ChevronRight size={18} />
            </button>
          </div>

          <div className="exploded-canvas-wrap">
            {isPageLoading && (
              <div className="exploded-canvas-state">
                <LoaderCircle className="spin" size={24} />
                <span>Caricamento tavola interattiva…</span>
              </div>
            )}
            {!isPageLoading && detail?.view.assetType === 'svg' && detail.svg && (
              <div className="exploded-vector-stack">
                <div
                  className="exploded-svg-art"
                  aria-hidden="true"
                  dangerouslySetInnerHTML={{ __html: detail.svg }}
                />
                <svg
                  className="exploded-hotspot-layer"
                  viewBox={`0 0 ${detail.view.viewW} ${detail.view.viewH}`}
                  role="img"
                  aria-label="Posizioni cliccabili sull’esploso"
                >
                  {detail.callouts.map((callout) => {
                    const matches = callout.items.some((item) =>
                      matchingItems.has(item),
                    )
                    const dimmed = Boolean(normalizedQuery && !matches)
                    const active = callout.items.includes(selectedItem)
                    const pulsing = callout.items.includes(activePulseItem)
                    return (
                      <g
                        key={callout.id}
                        className={`exploded-callout ${active ? 'active' : ''} ${
                          pulsing ? 'pulsing' : ''
                        } ${dimmed ? 'dimmed' : ''}`}
                        onClick={() => selectItem(callout.items[0])}
                        role="button"
                        tabIndex={dimmed ? -1 : 0}
                        aria-label={`Ricambi posizione ${callout.label}`}
                        onKeyDown={(event) => {
                          if (!dimmed && (event.key === 'Enter' || event.key === ' ')) {
                            event.preventDefault()
                            selectItem(callout.items[0])
                          }
                        }}
                      >
                        <line
                          x1={callout.x}
                          y1={callout.y}
                          x2={callout.tipX}
                          y2={callout.tipY}
                        />
                        <circle
                          className="exploded-callout-tip"
                          cx={callout.tipX}
                          cy={callout.tipY}
                          r="3.2"
                        />
                        <circle
                          className="exploded-callout-dot"
                          cx={callout.x}
                          cy={callout.y}
                          r="5.2"
                        />
                        <text
                          x={callout.x}
                          y={callout.y}
                          dominantBaseline="central"
                          textAnchor="middle"
                        >
                          {callout.label}
                        </text>
                      </g>
                    )
                  })}
                </svg>
              </div>
            )}
            {!isPageLoading && detail?.view.assetType === 'png' && detail.imageUrl && (
              <div className="exploded-raster-fallback">
                <img src={detail.imageUrl} alt={`Tavola ${detail.view.title}`} />
                <div aria-label="Posizioni non tracciabili">
                  {detail.callouts.map((callout) => (
                    <button
                      key={callout.id}
                      type="button"
                      className={
                        callout.items.includes(selectedItem) ? 'active' : ''
                      }
                      onClick={() => selectItem(callout.items[0])}
                    >
                      {callout.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {!isPageLoading && error && (
              <div className="exploded-canvas-state">
                <PackageOpen size={24} />
                <span>{error}</span>
              </div>
            )}
          </div>
        </section>

        <aside className="exploded-part-panel">
          <div className="exploded-part-heading">
            <Layers size={18} />
            <span>Ricambio selezionato</span>
          </div>
          {selectedPart ? (
            <>
              <span className="exploded-item-pill">
                Pos. {selectedCallout?.label || selectedPart.item || '—'}
              </span>
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
              {selectedParts.length > 1 && (
                <div className="exploded-multiple-parts">
                  <span>Ricambi collegati alla stessa callout</span>
                  {selectedParts.map((part) => (
                    <button
                      key={`${part.item}-${part.code}`}
                      type="button"
                      onClick={() => selectItem(part.item)}
                    >
                      <strong>Pos. {part.item}</strong>
                      <span>{part.code}</span>
                    </button>
                  ))}
                </div>
              )}
            </>
          ) : (
            <p>Seleziona un pallino sull’esploso.</p>
          )}

          <div className="exploded-item-list">
            <label className="exploded-part-search">
              <Search size={15} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Cerca codice o descrizione"
                aria-label="Cerca nella tavola"
              />
            </label>
            <span>{visibleParts.length} posizioni sulla tavola</span>
            <div>
              {visibleParts.map((part: CatalogPart) => (
                <button
                  key={`${part.item}-${part.code}-${part.page}`}
                  type="button"
                  ref={(node) => {
                    rowRefs.current[part.item] = node
                  }}
                  className={selectedItem === part.item ? 'active' : ''}
                  onClick={() => selectItem(part.item)}
                  onMouseEnter={() => setHoveredItem(part.item)}
                  onMouseLeave={() => setHoveredItem('')}
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
