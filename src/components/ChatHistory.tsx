import { Plus, Trash2 } from 'lucide-react'

export type ChatSummary = {
  id: string
  title: string
  updatedAt: number
}

type ChatHistoryProps = {
  threads: ChatSummary[]
  activeId: string
  disabled?: boolean
  onOpen: (id: string) => void
  onCreate: () => void
  onDelete: (id: string) => void
}

export function ChatHistory({
  threads,
  activeId,
  disabled = false,
  onOpen,
  onCreate,
  onDelete,
}: ChatHistoryProps) {
  const ordered = [...threads].sort((left, right) => right.updatedAt - left.updatedAt)

  return (
    <aside className="chat-history" aria-label="Storico chat">
      <button
        type="button"
        className="chat-history-new"
        onClick={onCreate}
        disabled={disabled}
      >
        <Plus size={16} />
        Nuova chat
      </button>
      <ul>
        {ordered.map((thread) => (
          <li key={thread.id} className={thread.id === activeId ? 'active' : ''}>
            <button
              type="button"
              className="chat-history-item"
              aria-current={thread.id === activeId ? 'true' : undefined}
              disabled={disabled}
              onClick={() => onOpen(thread.id)}
            >
              {thread.title}
            </button>
            <button
              type="button"
              className="chat-history-delete"
              aria-label={`Elimina ${thread.title}`}
              disabled={disabled}
              onClick={() => onDelete(thread.id)}
            >
              <Trash2 size={14} />
            </button>
          </li>
        ))}
      </ul>
    </aside>
  )
}
