import {
  ChevronLeft,
  ChevronRight,
  FileText,
  LoaderCircle,
  PackageOpen,
  RotateCcw,
  Search,
  SlidersHorizontal,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import {
  ApiError,
  getIndexedParts,
  type CatalogInfo,
  type CatalogPart,
} from '../lib/api'

const PAGE_SIZE = 25

function normalize(value: string) {
  return value
    .toLocaleLowerCase('it')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    // Codici tipo LM2525: "lm52" deve matchare come lm + 52
    .replace(/([a-z])([0-9])/g, '$1 $2')
    .replace(/([0-9])([a-z])/g, '$1 $2')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function compact(value: string) {
  return normalize(value).replace(/\s+/g, '')
}

function positionSortKey(value: string | number | undefined) {
  const text = String(value ?? '').trim()
  if (!text) return { empty: 1, nums: [] as number[], text: '' }
  const nums = text.match(/\d+/g)?.map((part) => Number.parseInt(part, 10)) || []
  return { empty: 0, nums, text: text.toLocaleLowerCase('it') }
}

function catalogPartKey(part: CatalogPart, fallbackCatalogId?: string) {
  return `${part.catalogId || fallbackCatalogId || ''}-${part.code}-${part.item}-${part.page}`
}

function sourceLabel(sourceType: CatalogPart['sourceType']) {
  if (sourceType === 'mechanical') return 'Meccanico'
  if (sourceType === 'electrical') return 'Elettrico'
  return 'Generico'
}

function comparePosition(left: string | number | undefined, right: string | number | undefined) {
  const a = positionSortKey(left)
  const b = positionSortKey(right)
  if (a.empty !== b.empty) return a.empty - b.empty
  const length = Math.max(a.nums.length, b.nums.length)
  for (let index = 0; index < length; index += 1) {
    const delta = (a.nums[index] ?? 0) - (b.nums[index] ?? 0)
    if (delta) return delta
  }
  return a.text.localeCompare(b.text, 'it', { numeric: true })
}

function CatalogPartDetail({
  part,
  catalogId,
  documentName,
  documentPages,
  onClose,
}: {
  part: CatalogPart
  catalogId?: string
  documentName?: string
  documentPages?: number
  onClose: () => void
}) {
  const pdfHref =
    part.pdfAvailable && catalogId && catalogId !== 'all-ready'
      ? `/api/catalog?catalogId=${encodeURIComponent(catalogId)}&page=${part.page}`
      : undefined

  return (
    <aside className="catalog-part-detail" aria-label="Dettaglio ricambio">
      <header>
        <div>
          <span className="catalog-kicker">Dettaglio</span>
          <h3>{part.description}</h3>
          {part.originalDescription !== part.description && (
            <p>{part.originalDescription}</p>
          )}
        </div>
        <button
          type="button"
          className="catalog-detail-close"
          onClick={onClose}
          aria-label="Chiudi dettagli"
        >
          <X size={16} />
        </button>
      </header>
      <dl>
        <div>
          <dt>Codice</dt>
          <dd>{part.code}</dd>
        </div>
        <div>
          <dt>Quantità</dt>
          <dd>{part.quantity}</dd>
        </div>
        <div>
          <dt>Posizione</dt>
          <dd>{part.item || '—'}</dd>
        </div>
        <div>
          <dt>Tipo</dt>
          <dd>{sourceLabel(part.sourceType)}</dd>
        </div>
        <div>
          <dt>Categoria</dt>
          <dd>{part.category || '—'}</dd>
        </div>
        {part.catalogName && (
          <div>
            <dt>Macchina</dt>
            <dd>{part.catalogName}</dd>
          </div>
        )}
        {(part.assemblyCode || part.assemblyTitle) && (
          <div>
            <dt>Assieme</dt>
            <dd>{[part.assemblyCode, part.assemblyTitle].filter(Boolean).join(' · ')}</dd>
          </div>
        )}
        <div>
          <dt>Tavola</dt>
          <dd>
            {pdfHref ? (
              <a className="pdf-reference" href={pdfHref} target="_blank" rel="noreferrer">
                <FileText size={15} />
                Pagina {part.page}
                {documentPages ? ` / ${documentPages}` : ''}
              </a>
            ) : (
              <span>
                Pagina {part.page}
                {documentPages ? ` / ${documentPages}` : ''}
              </span>
            )}
            {documentName && <small>{documentName}</small>}
          </dd>
        </div>
      </dl>
    </aside>
  )
}

type Props = {
  serial?: string
}

export default function PartsCatalog({ serial }: Props) {
  const [parts, setParts] = useState<CatalogPart[]>([])
  const [catalog, setCatalog] = useState<CatalogInfo>()
  const [categories, setCategories] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [machine, setMachine] = useState('')
  const [category, setCategory] = useState('')
  const [sourceType, setSourceType] = useState('')
  const [pdfPage, setPdfPage] = useState('')
  const [currentPage, setCurrentPage] = useState(1)
  const [selectedKey, setSelectedKey] = useState<string>()
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    setIsLoading(true)
    setError('')

    getIndexedParts(serial)
      .then((result) => {
        if (!active) return
        setParts(result.parts)
        setCatalog(result.catalog)
        setCategories(result.filters.categories)
      })
      .catch((requestError: unknown) => {
        if (!active) return
        setError(
          requestError instanceof ApiError
            ? requestError.message
            : 'Impossibile caricare l’indice ricambi.',
        )
      })
      .finally(() => {
        if (active) setIsLoading(false)
      })

    return () => {
      active = false
    }
  }, [serial])

  const machines = useMemo(
    () =>
      [...new Set(parts.map((part) => part.catalogName).filter(Boolean) as string[])]
        .sort((a, b) => a.localeCompare(b, 'it')),
    [parts],
  )

  const filteredParts = useMemo(() => {
    const terms = normalize(query).split(/\s+/).filter(Boolean)
    const queryCompact = compact(query)
    const requestedPage = Number.parseInt(pdfPage, 10)

    return parts
      .filter((part) => {
        const codeCompact = compact(part.code || '')
        const searchable = normalize(
          [
            part.code,
            part.description,
            part.originalDescription,
            part.item,
            part.category,
            part.catalogName,
            part.assemblyCode,
            part.assemblyTitle,
            part.page,
          ].join(' '),
        )
        const matchesQuery =
          !terms.length ||
          (Boolean(queryCompact) && codeCompact.includes(queryCompact)) ||
          terms.every((term) => codeCompact.includes(term) || searchable.includes(term))

        return (
          matchesQuery &&
          (!machine || part.catalogName === machine) &&
          (!category || part.category === category) &&
          (!sourceType || part.sourceType === sourceType) &&
          (!pdfPage || part.page === requestedPage)
        )
      })
      .sort((left, right) => {
        const byPosition = comparePosition(left.item, right.item)
        if (byPosition) return byPosition
        if (left.page !== right.page) return left.page - right.page
        return left.code.localeCompare(right.code, 'it', { numeric: true })
      })
  }, [category, machine, parts, pdfPage, query, sourceType])

  useEffect(() => {
    setCurrentPage(1)
    setSelectedKey(undefined)
  }, [query, machine, category, sourceType, pdfPage, serial])

  const selectedPart = filteredParts.find(
    (part) => catalogPartKey(part, catalog?.id) === selectedKey,
  )

  const totalPages = Math.max(1, Math.ceil(filteredParts.length / PAGE_SIZE))
  const visibleParts = filteredParts.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE,
  )

  const resetFilters = () => {
    setQuery('')
    setMachine('')
    setCategory('')
    setSourceType('')
    setPdfPage('')
  }

  if (isLoading) {
    return (
      <div className="catalog-state">
        <LoaderCircle className="spin" size={25} />
        <strong>Caricamento indice ricambi</strong>
        <span>Sto preparando codici e riferimenti al catalogo PDF.</span>
      </div>
    )
  }

  if (error) {
    return (
      <div className="catalog-state error">
        <PackageOpen size={27} />
        <strong>Indice non disponibile</strong>
        <span>{error}</span>
      </div>
    )
  }

  return (
    <div className="parts-catalog">
      <div className="catalog-hero">
        <div>
          <span className="catalog-kicker">Indice documentale</span>
          <h2>Tutti i ricambi indicizzati</h2>
          <p>
            {[catalog?.version, catalog?.orderReference, catalog?.documentPages
              ? `${catalog.documentPages} pagine`
              : null]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        <div className="catalog-total">
          <strong>{parts.length}</strong>
          <span>ricambi</span>
        </div>
      </div>

      <div className="catalog-filters">
        <label className="catalog-search">
          <Search size={18} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Cerca codice, descrizione o posizione"
          />
        </label>
        <label>
          <span>Macchina</span>
          <select value={machine} onChange={(event) => setMachine(event.target.value)}>
            <option value="">Tutte</option>
            {machines.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Categoria</span>
          <select value={category} onChange={(event) => setCategory(event.target.value)}>
            <option value="">Tutte</option>
            {categories.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Tipo</span>
          <select
            value={sourceType}
            onChange={(event) => setSourceType(event.target.value)}
          >
            <option value="">Tutti</option>
            <option value="mechanical">Meccanico</option>
            <option value="electrical">Elettrico</option>
            <option value="generic">Generico / AI</option>
          </select>
        </label>
        <label className="page-filter">
          <span>Pagina PDF</span>
          <input
            type="number"
            min="1"
            max={catalog?.documentPages}
            value={pdfPage}
            onChange={(event) => setPdfPage(event.target.value)}
            placeholder="Es. 301"
          />
        </label>
        <button type="button" className="clear-filters" onClick={resetFilters}>
          <RotateCcw size={15} />
          Azzera
        </button>
      </div>

      <div className="catalog-results-bar">
        <span>
          <SlidersHorizontal size={14} />
          <strong>{filteredParts.length}</strong> risultati
        </span>
        <span>
          PDF: <strong>{catalog?.documentName}</strong>
        </span>
      </div>

      <div className={`catalog-body${selectedPart ? ' has-detail' : ''}`}>
      <div className="parts-table-wrap">
        <table className="parts-table">
          <thead>
            <tr>
              <th>Codice</th>
              <th>Descrizione</th>
              <th>Qtà</th>
              <th>Pos.</th>
              <th>Tipo</th>
              <th>Tavola</th>
            </tr>
          </thead>
          <tbody>
            {visibleParts.map((part) => {
              const partCatalogId = part.catalogId || catalog?.id
              const documentName = part.documentName || catalog?.documentName
              const documentPages = part.documentPages || catalog?.documentPages
              const key = catalogPartKey(part, catalog?.id)
              return (
              <tr
                key={key}
                className={key === selectedKey ? 'is-selected' : undefined}
                tabIndex={0}
                aria-selected={key === selectedKey}
                onClick={() => setSelectedKey(key)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return
                  event.preventDefault()
                  setSelectedKey(key)
                }}
              >
                <td data-label="Codice">
                  <strong className="part-code">{part.code}</strong>
                </td>
                <td data-label="Descrizione">
                  <strong>{part.description}</strong>
                  {part.originalDescription !== part.description && (
                    <small>{part.originalDescription}</small>
                  )}
                  {part.catalogName && <small>{part.catalogName}</small>}
                </td>
                <td data-label="Quantità">
                  <span className="quantity-badge">{part.quantity}</span>
                </td>
                <td data-label="Posizione">{part.item}</td>
                <td data-label="Tipo">
                  <span className={`source-badge ${part.sourceType}`}>
                    {sourceLabel(part.sourceType)}
                  </span>
                </td>
                <td data-label="Tavola">
                  {part.pdfAvailable && partCatalogId && partCatalogId !== 'all-ready' ? (
                    <a
                      className="pdf-reference"
                      href={`/api/catalog?catalogId=${encodeURIComponent(partCatalogId)}&page=${part.page}`}
                      target="_blank"
                      rel="noreferrer"
                      title={`Apri ${documentName || 'PDF'} a pagina ${part.page}`}
                      onClick={(event) => event.stopPropagation()}
                    >
                      <FileText size={15} />
                      Pagina {part.page} / {documentPages}
                    </a>
                  ) : (
                    <span className="pdf-reference is-static" title={documentName}>
                      <FileText size={15} />
                      Pagina {part.page} / {documentPages}
                    </span>
                  )}
                </td>
              </tr>
              )
            })}
          </tbody>
        </table>
        {!visibleParts.length && (
          <div className="empty-catalog-results">
            <PackageOpen size={25} />
            <strong>Nessun ricambio trovato</strong>
            <span>Modifica o azzera i filtri applicati.</span>
          </div>
        )}
      </div>
      {selectedPart && (
        <CatalogPartDetail
          part={selectedPart}
          catalogId={selectedPart.catalogId || catalog?.id}
          documentName={selectedPart.documentName || catalog?.documentName}
          documentPages={selectedPart.documentPages || catalog?.documentPages}
          onClose={() => setSelectedKey(undefined)}
        />
      )}
      </div>

      <div className="catalog-pagination">
        <span>
          Pagina {currentPage} di {totalPages}
        </span>
        <div>
          <button
            type="button"
            disabled={currentPage === 1}
            onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
            aria-label="Pagina precedente"
          >
            <ChevronLeft size={17} />
          </button>
          <button
            type="button"
            disabled={currentPage === totalPages}
            onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}
            aria-label="Pagina successiva"
          >
            <ChevronRight size={17} />
          </button>
        </div>
      </div>
    </div>
  )
}
