import { ChevronDown, Search } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ChatMachine } from '../lib/api'

type MachinePickerProps = {
  machines: ChatMachine[]
  loading?: boolean
  selectedSerial?: string
  disabled?: boolean
  onSelect: (machine: ChatMachine) => void
}

function machineLabel(machine: ChatMachine) {
  return `${machine.brand} · ${machine.model}`
}

function machineDetail(machine: ChatMachine) {
  const serials = machine.serialNumbers.slice(0, 3).join(', ')
  return [machine.version, serials].filter(Boolean).join(' · ')
}

function matches(machine: ChatMachine, query: string) {
  const terms = query
    .trim()
    .toLocaleLowerCase('it')
    .split(/\s+/)
    .filter(Boolean)
  if (!terms.length) return true
  const haystack = [
    machine.brand,
    machine.model,
    machine.version,
    ...machine.serialNumbers,
  ]
    .join(' ')
    .toLocaleLowerCase('it')
  return terms.every((term) => haystack.includes(term))
}

export function MachinePicker({
  machines,
  loading = false,
  selectedSerial,
  disabled = false,
  onSelect,
}: MachinePickerProps) {
  const listId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const selected = machines.find(
    (machine) =>
      machine.serial === selectedSerial ||
      machine.serialNumbers.includes(selectedSerial || ''),
  )
  const visible = useMemo(
    () => machines.filter((machine) => matches(machine, query)),
    [machines, query],
  )

  useEffect(() => {
    setActiveIndex(0)
  }, [query, open])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  const choose = (machine: ChatMachine) => {
    setQuery('')
    setOpen(false)
    if (machine.serial !== selectedSerial) onSelect(machine)
  }

  return (
    <div className="machine-picker" ref={rootRef}>
      <label className="machine-picker-field">
        <Search size={18} />
        <input
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          disabled={disabled}
          placeholder={
            loading
              ? 'Caricamento macchine…'
              : machines.length
                ? 'Cerca macchina, modello o matricola'
                : 'Nessuna macchina disponibile'
          }
          value={open ? query : selected ? machineLabel(selected) : query}
          onChange={(event) => {
            setQuery(event.target.value)
            setOpen(true)
          }}
          onFocus={() => {
            setQuery('')
            setOpen(true)
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setOpen(true)
              setActiveIndex((index) => Math.min(index + 1, visible.length - 1))
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              setActiveIndex((index) => Math.max(index - 1, 0))
            } else if (event.key === 'Enter' && open && visible[activeIndex]) {
              event.preventDefault()
              choose(visible[activeIndex])
            } else if (event.key === 'Escape') {
              setOpen(false)
            }
          }}
        />
        <ChevronDown size={16} />
      </label>
      {open && (
        <ul className="machine-picker-list" id={listId} role="listbox">
          {visible.length ? (
            visible.map((machine, index) => (
              <li key={machine.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={machine.serial === selected?.serial}
                  className={index === activeIndex ? 'active' : ''}
                  onMouseEnter={() => setActiveIndex(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(machine)}
                >
                  <strong>{machineLabel(machine)}</strong>
                  <span>{machineDetail(machine)}</span>
                </button>
              </li>
            ))
          ) : (
            <li className="machine-picker-empty">Nessuna macchina trovata</li>
          )}
        </ul>
      )}
    </div>
  )
}
