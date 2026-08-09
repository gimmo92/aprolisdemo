# Apròlis Parts Finder

MVP web per trovare rapidamente un ricambio partendo dalla matricola del mezzo.
La conversazione identifica prima il catalogo compatibile e restituisce codice,
descrizione, quantità, riferimento e pagina del documento originale.

## Demo inclusa

- Marca: Charlatte Manutention
- Modello: T135 PH1 80V
- Matricole: `13510073`, `13510074`
- Catalogo sorgente: `t135_movincar_avio_global_services_ar197350_REV00.pdf`
- Dati indicizzati: tavole ricambi, pagine 449–457

I PDF originali non sono inclusi nel repository perché possono essere pesanti o
riservati. I dati dimostrativi presenti in `src/data/catalog.ts` sono stati
trascritti dalle tavole del catalogo locale.

## Avvio locale

```bash
npm install
npm run dev
```

Aprire l'indirizzo mostrato da Vite e provare la matricola `13510073`.

## Verifica

```bash
npm run lint
npm run build
```

## Evoluzione prevista

Per estendere l'MVP a tutti i cataloghi:

1. estrarre le tabelle ricambi dai PDF in un indice strutturato;
2. associare ogni indice alle matricole rilevate nei documenti e nei percorsi;
3. collegare la ricerca a un'API e a un archivio documentale protetto;
4. aggiungere autenticazione e gestione dei permessi prima dell'uso in produzione.
