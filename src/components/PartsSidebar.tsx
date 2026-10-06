import { ArrowLeft } from 'lucide-react'
import type { ReactNode } from 'react'
import type { Part } from '../data/catalog'

type PartsSidebarProps = {
  parts: Part[]
  selectedKey?: string
  onSelect: (key: string) => void
  onBack: () => void
  renderDetail: (part: Part) => ReactNode
}

export function partKey(part: Part) {
  return `${part.code}-${part.item}-${part.page}`
}

export function PartsSidebar({
  parts,
  selectedKey,
  onSelect,
  onBack,
  renderDetail,
}: PartsSidebarProps) {
  const selected = parts.find((part) => partKey(part) === selectedKey)

  return (
    <aside className="parts-sidebar" aria-label="Ricambi compatibili">
      <header className="parts-sidebar-header">
        {selected ? (
          <button type="button" className="parts-sidebar-back" onClick={onBack}>
            <ArrowLeft size={16} />
            Elenco
          </button>
        ) : (
          <strong>Ricambi compatibili</strong>
        )}
        <span>{parts.length}</span>
      </header>
      {selected ? (
        <div className="parts-sidebar-detail">{renderDetail(selected)}</div>
      ) : (
        <ul className="parts-sidebar-list">
          {parts.map((part) => (
            <li key={partKey(part)}>
              <button type="button" onClick={() => onSelect(partKey(part))}>
                <strong>{part.description}</strong>
                <span>
                  {part.code}
                  {part.item ? ` · ${part.item}` : ''}
                  {typeof part.confidence === 'number' ? ` · ${part.confidence}%` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  )
}
