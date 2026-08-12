import {
  ArrowRight,
  Bot,
  Box,
  Check,
  CircleHelp,
  FileText,
  Layers,
  LibraryBig,
  LoaderCircle,
  LogOut,
  MessageCircle,
  PackageSearch,
  RotateCcw,
  Search,
  Send,
  ShieldCheck,
  ImagePlus,
  UploadCloud,
  UserRound,
  X,
} from 'lucide-react'
import { FormEvent, useEffect, useRef, useState } from 'react'
import { catalog, exampleSearches, type Part } from './data/catalog'
import PartsCatalog from './components/PartsCatalog'
import ExplodedView, {
  type ExplodedSelection,
} from './components/ExplodedView'
import { AdminCatalogs } from './components/AdminCatalogs'
import { BrandMark } from './components/BrandMark'
import {
  ApiError,
  askPartsAssistant,
  getCatalogStats,
  identifyCatalog,
  type ChatHistoryItem,
} from './lib/api'
import { useAuth } from './lib/auth'

type Phase = 'serial' | 'search'
type ActiveView = 'chat' | 'catalog' | 'esplosi' | 'admin'

type Message = {
  id: number
  sender: 'assistant' | 'user'
  text: string
  eyebrow?: string
  imageUrl?: string
  results?: Part[]
  noResults?: boolean
}

type ChatImagePayload = {
  base64: string
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp'
  previewUrl: string
}

const initialMessage: Message = {
  id: 1,
  sender: 'assistant',
  eyebrow: 'Assistente ricambi',
  text: 'Buongiorno! Indica la matricola, il modello (es. T135) o il nome del catalogo. Poi cerca il ricambio, anche nella stessa frase. In ricerca puoi anche caricare una foto del pezzo.',
}

const LOOKUP_STOPWORDS = new Set([
  'macchina',
  'mezzo',
  'catalogo',
  'modello',
  'matricola',
  'dammi',
  'tutti',
  'tutte',
  'della',
  'delle',
  'del',
  'dei',
  'degli',
  'dello',
  'di',
  'la',
  'il',
  'lo',
  'le',
  'i',
  'un',
  'una',
  'per',
  'con',
  'su',
  'nel',
  'nella',
  'trova',
  'cerca',
  'ricambi',
  'ricambio',
  'vorrei',
  'voglio',
  'mostra',
  'elenca',
])

function residualSearchQuery(raw: string, matchedLabel: string) {
  const labelTokens = matchedLabel
    .toLocaleLowerCase('it')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2)

  const kept = raw
    .toLocaleLowerCase('it')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(
      (token) =>
        token.length >= 2 &&
        !LOOKUP_STOPWORDS.has(token) &&
        !labelTokens.includes(token),
    )

  return kept.join(' ').trim()
}

async function prepareChatImage(file: File): Promise<ChatImagePayload> {
  const allowed = new Set(['image/jpeg', 'image/png', 'image/webp'])
  if (!allowed.has(file.type)) {
    throw new Error('Formato non supportato. Usa JPG, PNG o WebP.')
  }
  if (file.size > 8 * 1024 * 1024) {
    throw new Error('Immagine troppo grande (max 8 MB).')
  }

  const bitmap = await createImageBitmap(file)
  const maxSide = 1280
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Impossibile preparare l’immagine.')
  context.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()

  const dataUrl = canvas.toDataURL('image/jpeg', 0.78)
  const base64 = dataUrl.replace(/^data:image\/jpeg;base64,/, '')
  if (base64.length > 1_800_000) {
    throw new Error('Immagine ancora troppo pesante dopo la compressione.')
  }
  return {
    base64,
    mediaType: 'image/jpeg',
    previewUrl: dataUrl,
  }
}

function PartCard({
  part,
  onOpenExploded,
}: {
  part: Part
  onOpenExploded?: (part: Part) => void
}) {
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
      {part.viewId && (
        <button
          type="button"
          className="part-exploded-link"
          onClick={() => onOpenExploded?.(part)}
        >
          <Layers size={15} />
          Mostra sull’esploso
        </button>
      )}
    </article>
  )
}

function ChatMessage({
  message,
  onOpenExploded,
}: {
  message: Message
  onOpenExploded?: (part: Part) => void
}) {
  const isAssistant = message.sender === 'assistant'

  return (
    <div className={`message-row ${isAssistant ? 'assistant' : 'user'}`}>
      <div className="message-avatar">
        {isAssistant ? <Bot size={19} /> : <UserRound size={18} />}
      </div>
      <div className="message-content">
        {message.eyebrow && <span className="message-eyebrow">{message.eyebrow}</span>}
        <div className="message-bubble">
          {message.imageUrl && (
            <img
              className="message-image"
              src={message.imageUrl}
              alt="Foto ricambio"
            />
          )}
          {message.text}
        </div>
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
              <PartCard
                key={`${part.code}-${part.item}-${part.page}`}
                part={part}
                onOpenExploded={onOpenExploded}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function App() {
  const { session, signOut } = useAuth()
  const [phase, setPhase] = useState<Phase>('serial')
  const [activeView, setActiveView] = useState<ActiveView>('chat')
  const [selectedSerial, setSelectedSerial] = useState<string>()
  const [input, setInput] = useState('')
  const [pendingImage, setPendingImage] = useState<ChatImagePayload>()
  const [messages, setMessages] = useState<Message[]>([initialMessage])
  const [isThinking, setIsThinking] = useState(false)
  const [indexedPartCount, setIndexedPartCount] = useState(585)
  const [explodedSelection, setExplodedSelection] =
    useState<ExplodedSelection>()
  const messageId = useRef(2)
  const scrollArea = useRef<HTMLDivElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)

  const placeholder =
    phase === 'serial'
      ? 'Es. 13510073, T135, oppure “sensori T135”'
      : pendingImage
        ? 'Aggiungi un dettaglio (opzionale) e invia'
        : 'Descrivi il ricambio o carica una foto'

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

  const runPartsSearch = async (
    serial: string,
    value: string,
    options?: { skipUserMessage?: boolean; image?: ChatImagePayload },
  ) => {
    const image = options?.image
    const history: ChatHistoryItem[] = messages
      .slice(-6)
      .map((message) => ({
        role: message.sender === 'user' ? 'user' : 'assistant',
        content: message.text,
      }))
    if (!options?.skipUserMessage) {
      addMessage({
        sender: 'user',
        text: value || (image ? 'Foto del ricambio' : value),
        imageUrl: image?.previewUrl,
      })
    }
    setIsThinking(true)

    try {
      const result = await askPartsAssistant(
        serial,
        value || 'Identifica il ricambio nella foto',
        history,
        image
          ? { base64: image.base64, mediaType: image.mediaType }
          : undefined,
      )
      if (result.parts.length) {
        addMessage({
          sender: 'assistant',
          eyebrow: image
            ? 'Riconoscimento foto · fonti verificate'
            : 'Risposta Claude · fonti verificate',
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

  const handleSerial = async (value: string) => {
    addMessage({ sender: 'user', text: value })
    setIsThinking(true)

    try {
      const lookup = await identifyCatalog(value)
      setSelectedSerial(lookup.serial)
      setPhase('search')

      const how =
        lookup.resolvedBy === 'serial'
          ? `matricola ${lookup.serial}`
          : lookup.resolvedBy === 'model'
            ? `modello ${lookup.matchedLabel}`
            : `catalogo ${lookup.matchedLabel}`
      const residual = residualSearchQuery(value, lookup.matchedLabel)

      if (residual.length >= 3) {
        addMessage({
          sender: 'assistant',
          eyebrow: 'Catalogo individuato',
          text: `Ok, uso ${how} (${lookup.catalog.version}). Cerco: “${residual}”.`,
        })
        setIsThinking(false)
        await runPartsSearch(lookup.serial, residual, { skipUserMessage: true })
        return
      }

      addMessage({
        sender: 'assistant',
        eyebrow: 'Catalogo individuato',
        text: `Perfetto. Ho associato ${how} al catalogo ${lookup.catalog.version}${
          lookup.catalog.orderReference ? ` (${lookup.catalog.orderReference})` : ''
        }. Quale ricambio stai cercando?`,
      })
    } catch (error) {
      const message =
        error instanceof ApiError && error.status === 404
          ? `Non trovo matricola, macchina o catalogo per “${value}”. Prova con 13510073, T135 o il nome del catalogo.`
          : error instanceof Error
            ? error.message
            : 'Non riesco a individuare il catalogo in questo momento.'
      addMessage({
        sender: 'assistant',
        eyebrow: 'Catalogo non individuato',
        text: message,
      })
    } finally {
      setIsThinking(false)
    }
  }

  const handleSearch = async (value: string, image?: ChatImagePayload) => {
    if (!selectedSerial) return
    await runPartsSearch(selectedSerial, value, { image })
  }

  const onPickImage = async (file?: File | null) => {
    if (!file || isThinking || phase !== 'search') return
    try {
      const prepared = await prepareChatImage(file)
      setPendingImage(prepared)
    } catch (error) {
      addMessage({
        sender: 'assistant',
        eyebrow: 'Immagine non valida',
        text:
          error instanceof Error
            ? error.message
            : 'Non riesco a usare questa immagine.',
        noResults: true,
      })
    } finally {
      if (imageInputRef.current) imageInputRef.current.value = ''
    }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const value = input.trim()
    if (isThinking) return
    if (phase === 'serial') {
      if (!value) return
      setInput('')
      void handleSerial(value)
      return
    }
    if (!value && !pendingImage) return
    const image = pendingImage
    setInput('')
    setPendingImage(undefined)
    void handleSearch(value, image)
  }

  const reset = () => {
    setActiveView('chat')
    setPhase('serial')
    setSelectedSerial(undefined)
    setInput('')
    setPendingImage(undefined)
    setIsThinking(false)
    setExplodedSelection(undefined)
    messageId.current = 2
    setMessages([initialMessage])
  }

  const handleSuggestion = (value: string) => {
    if (isThinking) return
    if (phase === 'serial') void handleSerial(value)
    else void handleSearch(value)
  }

  const openExplodedPart = (part: Part) => {
    if (!part.viewId) return
    setExplodedSelection({ viewId: part.viewId, item: part.item })
    setActiveView('esplosi')
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <BrandMark href="/" showProduct />
        <div className="topbar-right">
          <span className="status-chip">
            <span className="status-dot" />
            {session.user.email || 'Catalogo operativo'}
          </span>
          <button className="reset-button" onClick={reset} type="button">
            <RotateCcw size={16} />
            Nuova ricerca
          </button>
          <button
            className="reset-button"
            onClick={() => void signOut()}
            type="button"
          >
            <LogOut size={16} />
            Esci
          </button>
        </div>
      </header>

      <section className="workspace">
        <section className={`chat-panel ${activeView !== 'chat' ? 'catalog-view' : ''}`}>
          <div className="chat-header">
            <div>
              <span className="chat-online">
                <span />{' '}
                {activeView === 'chat'
                  ? 'Assistente online'
                  : activeView === 'catalog'
                    ? 'Indice aggiornato'
                    : activeView === 'esplosi'
                      ? 'Tavole interattive'
                      : 'Area protetta'}
              </span>
              <h2>
                {activeView === 'chat'
                  ? 'Ricerca ricambi'
                  : activeView === 'catalog'
                    ? 'Catalogo ricambi'
                    : activeView === 'esplosi'
                      ? 'Esplosi'
                      : 'Amministrazione'}
              </h2>
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
                aria-selected={activeView === 'esplosi'}
                className={activeView === 'esplosi' ? 'active' : ''}
                onClick={() => setActiveView('esplosi')}
              >
                <Layers size={16} />
                Esplosi
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
              <span><strong>{indexedPartCount}</strong> ricambi indicizzati</span>
            </div>
          </div>

          {activeView === 'chat' ? (
            <>
              <div className="chat-scroll" ref={scrollArea}>
                <div className="conversation">
                  {messages.map((message) => (
                    <ChatMessage
                      key={message.id}
                      message={message}
                      onOpenExploded={openExplodedPart}
                    />
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
                  {phase === 'search' && (
                    <>
                      <input
                        ref={imageInputRef}
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        hidden
                        onChange={(event) =>
                          void onPickImage(event.target.files?.[0])
                        }
                      />
                      <button
                        type="button"
                        className="composer-attach"
                        disabled={isThinking}
                        aria-label="Carica foto ricambio"
                        title="Carica foto ricambio"
                        onClick={() => imageInputRef.current?.click()}
                      >
                        <ImagePlus size={18} />
                      </button>
                    </>
                  )}
                  <button
                    type="submit"
                    disabled={
                      isThinking ||
                      (phase === 'serial'
                        ? !input.trim()
                        : !input.trim() && !pendingImage)
                    }
                    aria-label="Invia"
                  >
                    {isThinking ? (
                      <LoaderCircle className="spin" size={19} />
                    ) : (
                      <Send size={19} />
                    )}
                  </button>
                </form>
                {pendingImage && phase === 'search' && (
                  <div className="composer-image-preview">
                    <img src={pendingImage.previewUrl} alt="Anteprima foto" />
                    <button
                      type="button"
                      aria-label="Rimuovi foto"
                      onClick={() => setPendingImage(undefined)}
                    >
                      <X size={14} />
                    </button>
                  </div>
                )}
                <p className="composer-note">
                  <ShieldCheck size={13} /> Risposte basate esclusivamente sul catalogo associato
                  <ArrowRight size={13} />
                </p>
              </div>
            </>
          ) : activeView === 'catalog' ? (
            <div className="catalog-scroll">
              <PartsCatalog />
            </div>
          ) : activeView === 'esplosi' ? (
            <div className="catalog-scroll">
              <ExplodedView
                selection={explodedSelection}
                onSelectionChange={setExplodedSelection}
              />
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
