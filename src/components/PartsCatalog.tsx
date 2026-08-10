import {
  ChevronLeft,
  ChevronRight,
  FileText,
  LoaderCircle,
  PackageOpen,
  RotateCcw,
  Search,
  SlidersHorizontal,
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
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
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
    const terms = normalize(query).split(' ').filter(Boolean)
    const requestedPage = Number.parseInt(pdfPage, 10)

    return parts.filter((part) => {
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
      return (
        terms.every((term) => searchable.includes(term)) &&
        (!machine || part.catalogName === machine) &&
        (!category || part.category === category) &&
        (!sourceType || part.sourceType === sourceType) &&
        (!pdfPage || part.page === requestedPage)
      )
    })
  }, [category, machine, parts, pdfPage, query, sourceType])

  useEffect(() => {
    setCurrentPage(1)
  }, [query, machine, category, sourceType, pdfPage])

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
            {catalog?.version} · {catalog?.orderReference} · {catalog?.documentPages}{' '}
            pagine
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

      <div className="parts-table-wrap">
        <table className="parts-table">
          <thead>
            <tr>
              <th>Codice</th>
              <th>Descrizione</th>
              <th>Qtà</th>
              <th>Pos.</th>
              <th>Tipo</th>
              <th>Riferimento PDF</th>
            </tr>
          </thead>
          <tbody>
            {visibleParts.map((part) => {
              const partCatalogId = part.catalogId || catalog?.id
              const documentName = part.documentName || catalog?.documentName
              const documentPages = part.documentPages || catalog?.documentPages
              const pdfAvailable = part.pdfAvailable ?? catalog?.pdfAvailable
              return (
              <tr key={`${partCatalogId}-${part.code}-${part.item}-${part.page}`}>
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
                    {part.sourceType === 'mechanical'
                      ? 'Meccanico'
                      : part.sourceType === 'electrical'
                        ? 'Elettrico'
                        : 'Generico'}
                  </span>
                </td>
                <td data-label="Riferimento PDF">
                  {pdfAvailable && partCatalogId ? (
                    <a
                      className="pdf-reference"
                      href={`/api/pdf?catalogId=${encodeURIComponent(partCatalogId)}&page=${part.page}`}
                      target="_blank"
                      rel="noreferrer"
                      title={`Apri ${documentName}`}
                    >
                      <FileText size={15} />
                      Apri pagina {part.page}
                    </a>
                  ) : (
                    <span className="pdf-reference" title={documentName}>
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
