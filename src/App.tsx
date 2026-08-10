import {
  ArrowRight,
  Bot,
  Box,
  Check,
  ChevronRight,
  CircleHelp,
  FileText,
  Hash,
  LibraryBig,
  LoaderCircle,
  MessageCircle,
  PackageSearch,
  RotateCcw,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  UploadCloud,
  UserRound,
  Wrench,
} from 'lucide-react'
import { FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import { catalog, exampleSearches, type Part } from './data/catalog'
import PartsCatalog from './components/PartsCatalog'
import { AdminCatalogs } from './components/AdminCatalogs'
import {
  ApiError,
  askPartsAssistant,
  getCatalogStats,
  identifyCatalog,
  type CatalogInfo,
  type ChatHistoryItem,
} from './lib/api'

type Phase = 'serial' | 'search'
type ActiveView = 'chat' | 'catalog' | 'admin'

type Message = {
  id: number
  sender: 'assistant' | 'user'
  text: string
  eyebrow?: string
  results?: Part[]
  noResults?: boolean
}

const initialMessage: Message = {
  id: 1,
  sender: 'assistant',
  eyebrow: 'Assistente ricambi',
  text: 'Buongiorno! Inserisci il numero di matricola del mezzo. Individuerò il catalogo corretto prima di cercare il ricambio.',
}

function BrandMark() {
  return (
    <div className="brand-mark" aria-label="Apròlis Parts Finder">
      <div className="brand-symbol">
        <span />
        <span />
        <span />
      </div>
      <div>
        <strong>APRÒLIS</strong>
        <small>PARTS FINDER</small>
      </div>
    </div>
  )
}

function PartCard({ part }: { part: Part }) {
  return (
    <article className="part-card">
      <div className="part-card-top">
        <span className="category-pill">{part.category}</span>
        <span className="verified-label">
          <Check size={13} strokeWidth={3} /> Verificato
        </span>
      </div>
      <div className="part-main">
        <div className="part-icon">
          <Box size={22} />
        </div>
        <div>
          <h3>{part.description}</h3>
          <span className="original-description">{part.originalDescription}</span>
        </div>
      </div>
      <div className="part-details">
        <div>
          <span>Codice ricambio</span>
          <strong>{part.code}</strong>
        </div>
        <div>
          <span>Quantità</span>
          <strong>{part.quantity}</strong>
        </div>
        <div>
          <span>Riferimento</span>
          <strong>{part.item}</strong>
        </div>
      </div>
      <div className="part-source">
        <FileText size={15} />
        <span>
          Catalogo T135 · pagina {part.page} di {catalog.documentPages}
        </span>
      </div>
    </article>
  )
}

function ChatMessage({ message }: { message: Message }) {
  const isAssistant = message.sender === 'assistant'

  return (
    <div className={`message-row ${isAssistant ? 'assistant' : 'user'}`}>
      <div className="message-avatar">
        {isAssistant ? <Bot size={19} /> : <UserRound size={18} />}
      </div>
      <div className="message-content">
        {message.eyebrow && <span className="message-eyebrow">{message.eyebrow}</span>}
        <div className="message-bubble">{message.text}</div>
        {message.noResults && (
          <div className="no-results-hint">
            <CircleHelp size={18} />
            Prova con il nome comune del componente, la categoria o il codice.
          </div>
        )}
        {!!message.results?.length && (
          <div className="results-list">
            <div className="results-heading">
              <span>{message.results.length} ricambi compatibili</span>
              <span>Ordinati per pertinenza</span>
            </div>
            {message.results.map((part) => (
              <PartCard key={`${part.code}-${part.item}-${part.page}`} part={part} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function App() {
  const [phase, setPhase] = useState<Phase>('serial')
  const [activeView, setActiveView] = useState<ActiveView>('chat')
  const [selectedSerial, setSelectedSerial] = useState<string>()
  const [catalogInfo, setCatalogInfo] = useState<CatalogInfo>()
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState<Message[]>([initialMessage])
  const [isThinking, setIsThinking] = useState(false)
  const [indexedPartCount, setIndexedPartCount] = useState(585)
  const messageId = useRef(2)
  const scrollArea = useRef<HTMLDivElement>(null)

  const placeholder =
    phase === 'serial'
      ? 'Es. 13510073'
      : 'Descrivi il ricambio, es. “fusibile 500A”'

  const progress = useMemo(() => (phase === 'serial' ? 1 : 2), [phase])

  useEffect(() => {
    getCatalogStats()
      .then(({ stats }) => setIndexedPartCount(stats.parts))
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    const area = scrollArea.current
    if (area) area.scrollTo({ top: area.scrollHeight, behavior: 'smooth' })
  }, [messages, isThinking])

  const addMessage = (message: Omit<Message, 'id'>) => {
    setMessages((current) => [
      ...current,
      { ...message, id: messageId.current++ },
    ])
  }

  const handleSerial = async (value: string) => {
    const cleanSerial = value.replace(/\D/g, '')
    addMessage({ sender: 'user', text: value })
    setIsThinking(true)

    try {
      const identifiedCatalog = await identifyCatalog(cleanSerial)
      setCatalogInfo(identifiedCatalog)
      setSelectedSerial(cleanSerial)
      setPhase('search')
      addMessage({
        sender: 'assistant',
        eyebrow: 'Catalogo individuato',
        text: `Perfetto. Ho associato la matricola ${cleanSerial} al ${identifiedCatalog.version} (${identifiedCatalog.orderReference}). Quale ricambio stai cercando?`,
      })
    } catch (error) {
      const message =
        error instanceof ApiError && error.status === 404
          ? `Non trovo la matricola ${value} nei cataloghi indicizzati. Prova con 13510073 o 13510074.`
          : error instanceof Error
            ? error.message
            : 'Non riesco a verificare la matricola in questo momento.'
      addMessage({
        sender: 'assistant',
        eyebrow: 'Matricola non verificata',
        text: message,
      })
    } finally {
      setIsThinking(false)
    }
  }

  const handleSearch = async (value: string) => {
    if (!selectedSerial) return
    const history: ChatHistoryItem[] = messages
      .slice(-6)
      .map((message) => ({
        role: message.sender === 'user' ? 'user' : 'assistant',
        content: message.text,
      }))
    addMessage({ sender: 'user', text: value })
    setIsThinking(true)

    try {
      const result = await askPartsAssistant(selectedSerial, value, history)
      if (result.parts.length) {
        addMessage({
          sender: 'assistant',
          eyebrow: 'Risposta Claude · fonti verificate',
          text: result.answer,
          results: result.parts,
        })
      } else {
        addMessage({
          sender: 'assistant',
          eyebrow: 'Nessuna corrispondenza',
          text: result.answer,
          noResults: true,
        })
      }
    } catch (error) {
      addMessage({
        sender: 'assistant',
        eyebrow: 'Ricerca non disponibile',
        text:
          error instanceof Error
            ? error.message
            : 'Si è verificato un errore durante la ricerca.',
        noResults: true,
      })
    } finally {
      setIsThinking(false)
    }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const value = input.trim()
    if (!value || isThinking) return
    setInput('')
    if (phase === 'serial') void handleSerial(value)
    else void handleSearch(value)
  }

  const reset = () => {
    setActiveView('chat')
    setPhase('serial')
    setSelectedSerial(undefined)
    setCatalogInfo(undefined)
    setInput('')
    setIsThinking(false)
    messageId.current = 2
    setMessages([initialMessage])
  }

  const handleSuggestion = (value: string) => {
    if (isThinking) return
    if (phase === 'serial') void handleSerial(value)
    else void handleSearch(value)
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <BrandMark />
        <div className="topbar-right">
          <span className="status-chip">
            <span className="status-dot" />
            Catalogo operativo
          </span>
          <button className="reset-button" onClick={reset} type="button">
            <RotateCcw size={16} />
            Nuova ricerca
          </button>
        </div>
      </header>

      <section className="workspace">
        <aside className="sidebar">
          <div className="sidebar-intro">
            <div className="eyebrow">
              <Sparkles size={14} />
              Ricerca assistita
            </div>
            <h1>Il ricambio giusto, senza sfogliare il catalogo.</h1>
            <p>
              Parti dalla matricola e descrivi ciò che ti serve. Il sistema
              consulta solo la documentazione compatibile.
            </p>
          </div>

          <div className="steps">
            <div className={`step ${progress >= 1 ? 'active' : ''}`}>
              <span className="step-number">{phase === 'search' ? <Check size={15} /> : '1'}</span>
              <div>
                <strong>Identifica il mezzo</strong>
                <small>{selectedSerial ? `Matricola ${selectedSerial}` : 'Inserisci la matricola'}</small>
              </div>
            </div>
            <div className="step-line" />
            <div className={`step ${progress >= 2 ? 'active' : ''}`}>
              <span className="step-number">2</span>
              <div>
                <strong>Cerca il ricambio</strong>
                <small>Scrivi nome, funzione o codice</small>
              </div>
            </div>
          </div>

          {selectedSerial ? (
            <div className="machine-card">
              <div className="machine-card-header">
                <div className="machine-icon"><Wrench size={19} /></div>
                <div>
                  <span>Mezzo identificato</span>
                  <strong>{catalogInfo?.model ?? catalog.model}</strong>
                </div>
                <ShieldCheck size={20} />
              </div>
              <dl>
                <div><dt>Marca</dt><dd>{catalogInfo?.brand ?? 'Charlatte'}</dd></div>
                <div><dt>Matricola</dt><dd>{selectedSerial}</dd></div>
                <div><dt>Versione</dt><dd>PH1 80V</dd></div>
                <div><dt>Catalogo</dt><dd>{catalogInfo?.documentPages ?? catalog.documentPages} pagine</dd></div>
              </dl>
            </div>
          ) : (
            <button
              className="demo-serial-card"
              type="button"
              onClick={() => handleSuggestion('13510073')}
            >
              <span className="demo-icon"><Hash size={18} /></span>
              <span>
                <small>Prova la matricola demo</small>
                <strong>13510073</strong>
              </span>
              <ChevronRight size={18} />
            </button>
          )}

          <div className="trust-note">
            <FileText size={17} />
            <p>
              <strong>Fonte verificabile</strong>
              Ogni risultato rimanda alla pagina del catalogo originale.
            </p>
          </div>
        </aside>

        <section className={`chat-panel ${activeView !== 'chat' ? 'catalog-view' : ''}`}>
          <div className="chat-header">
            <div>
              <span className="chat-online">
                <span /> {activeView === 'chat' ? 'Assistente online' : activeView === 'catalog' ? 'Indice aggiornato' : 'Area protetta'}
              </span>
              <h2>{activeView === 'chat' ? 'Ricerca ricambi' : activeView === 'catalog' ? 'Catalogo ricambi' : 'Amministrazione'}</h2>
            </div>
            <div className="view-tabs" role="tablist" aria-label="Sezione applicazione">
              <button
                type="button"
                role="tab"
                aria-selected={activeView === 'chat'}
                className={activeView === 'chat' ? 'active' : ''}
                onClick={() => setActiveView('chat')}
              >
                <MessageCircle size={16} />
                Chat
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeView === 'catalog'}
                className={activeView === 'catalog' ? 'active' : ''}
                onClick={() => setActiveView('catalog')}
              >
                <LibraryBig size={16} />
                Tutti i ricambi
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeView === 'admin'}
                className={activeView === 'admin' ? 'active' : ''}
                onClick={() => setActiveView('admin')}
              >
                <UploadCloud size={16} />
                Gestione cataloghi
              </button>
            </div>
            <div className={`catalog-count ${activeView === 'admin' ? 'hidden' : ''}`}>
              <PackageSearch size={19} />
              <span><strong>{activeView === 'chat' && catalogInfo ? catalogInfo.partCount : indexedPartCount}</strong> ricambi indicizzati</span>
            </div>
          </div>

          {activeView === 'chat' ? (
            <>
              <div className="chat-scroll" ref={scrollArea}>
                <div className="conversation">
                  {messages.map((message) => (
                    <ChatMessage key={message.id} message={message} />
                  ))}
                  {isThinking && (
                    <div className="message-row assistant">
                      <div className="message-avatar"><Bot size={19} /></div>
                      <div className="typing-indicator" aria-label="Ricerca in corso">
                        <span />
                        <span />
                        <span />
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div className="composer-wrap">
                {phase === 'search' && (
                  <div className="suggestions">
                    <span>Ricerche rapide</span>
                    {exampleSearches.map((example) => (
                      <button type="button" key={example} onClick={() => handleSuggestion(example)}>
                        {example}
                      </button>
                    ))}
                  </div>
                )}
                <form className="composer" onSubmit={submit}>
                  <Search size={20} />
                  <input
                    autoFocus
                    value={input}
                    onChange={(event) => setInput(event.target.value)}
                    placeholder={placeholder}
                    aria-label={placeholder}
                  />
                  <button type="submit" disabled={!input.trim() || isThinking} aria-label="Invia">
                    {isThinking ? <LoaderCircle className="spin" size={19} /> : <Send size={19} />}
                  </button>
                </form>
                <p className="composer-note">
                  <ShieldCheck size={13} /> Risposte basate esclusivamente sul catalogo associato
                  <ArrowRight size={13} />
                </p>
              </div>
            </>
          ) : activeView === 'catalog' ? (
            <div className="catalog-scroll">
              <PartsCatalog serial={selectedSerial} />
            </div>
          ) : (
            <div className="catalog-scroll admin-scroll">
              <AdminCatalogs />
            </div>
          )}
        </section>
      </section>
    </main>
  )
}

export default App
