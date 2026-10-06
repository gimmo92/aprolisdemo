import { Download } from 'lucide-react'
import { useEffect, useMemo } from 'react'
import { BrandMark } from './BrandMark'
import {
  formatDocumentDate,
  formatEuro,
  loadCommercialDocument,
} from '../lib/commercial'

type Props = {
  docId: string
}

export function CommercialDocument({ docId }: Props) {
  const document = useMemo(() => loadCommercialDocument(docId), [docId])

  useEffect(() => {
    if (!document) {
      window.document.title = 'Documento non trovato · Aftercore'
      return
    }
    const label = document.kind === 'offerta' ? 'Offerta' : 'Ordine'
    window.document.title = `${label} ${document.number} · Aftercore`
  }, [document])

  if (!document) {
    return (
      <main className="quote-page">
        <section className="quote-missing">
          <BrandMark />
          <h1>Documento non trovato</h1>
          <p>Apri di nuovo l’offerta o l’ordine dal dettaglio del ricambio.</p>
        </section>
      </main>
    )
  }

  const net = document.quantity * document.unitPrice
  const vat = net * document.vatRate
  const gross = net + vat
  const isQuote = document.kind === 'offerta'
  const title = isQuote ? 'Offerta' : 'Ordine'
  const delivery = document.inStock
    ? 'Pronto a magazzino, spedizione in 48 ore'
    : 'Non disponibile a magazzino, consegna indicativa in 10-12 giorni lavorativi'

  return (
    <main className="quote-page">
      <div className="quote-toolbar">
        <button type="button" onClick={() => window.print()}>
          <Download size={16} />
          Scarica PDF
        </button>
      </div>
      <article className="quote-sheet">
        <header className="quote-head">
          <BrandMark />
          <div>
            <span>{title}</span>
            <strong>{document.number}</strong>
          </div>
        </header>

        <section className="quote-meta">
          <div>
            <span>Data</span>
            <strong>{formatDocumentDate(document.issuedAt)}</strong>
          </div>
          <div>
            <span>{isQuote ? 'Validità' : 'Consegna prevista'}</span>
            <strong>{formatDocumentDate(document.validUntil)}</strong>
          </div>
          <div>
            <span>Riferimento catalogo</span>
            <strong>{document.orderReference}</strong>
          </div>
          <div>
            <span>Pagamento</span>
            <strong>Bonifico 30 giorni DFF</strong>
          </div>
        </section>

        <section className="quote-parties">
          <div>
            <span>Destinatario</span>
            <strong>{document.customer}</strong>
            <p>Macchina {document.brand} {document.model}</p>
            <p>{document.version}</p>
            {document.serial && <p>Matricola {document.serial}</p>}
          </div>
          <div>
            <span>Disponibilità</span>
            <strong>{document.inStock ? `In stock · ${document.stockQty} pz` : 'Non in stock'}</strong>
            <p>{delivery}</p>
          </div>
        </section>

        <table className="quote-lines">
          <thead>
            <tr>
              <th>Codice</th>
              <th>Descrizione</th>
              <th>Qtà</th>
              <th>Prezzo</th>
              <th>Importo</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{document.code}</td>
              <td>
                <strong>{document.description}</strong>
                <small>
                  {document.originalDescription}
                  {document.item ? ` · pos. ${document.item}` : ''}
                  {` · pag. ${document.page}`}
                  {document.category ? ` · ${document.category}` : ''}
                </small>
              </td>
              <td>{document.quantity}</td>
              <td>{formatEuro(document.unitPrice)}</td>
              <td>{formatEuro(net)}</td>
            </tr>
          </tbody>
        </table>

        <section className="quote-totals">
          <div>
            <span>Imponibile</span>
            <strong>{formatEuro(net)}</strong>
          </div>
          <div>
            <span>IVA {Math.round(document.vatRate * 100)}%</span>
            <strong>{formatEuro(vat)}</strong>
          </div>
          <div>
            <span>Totale</span>
            <strong>{formatEuro(gross)}</strong>
          </div>
        </section>

        <footer className="quote-notes">
          <p>
            {isQuote
              ? 'Offerta compilata sul ricambio identificato dal catalogo associato alla matricola. I prezzi sono di listino dimostrativo e non includono trasporto.'
              : 'Ordine compilato sul ricambio identificato dal catalogo associato alla matricola. I prezzi sono di listino dimostrativo e non includono trasporto.'}
          </p>
          <p>Aftercore · ricambi after-sales</p>
        </footer>
      </article>
    </main>
  )
}
