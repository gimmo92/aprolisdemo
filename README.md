# Apròlis Parts Finder

MVP web con retrieval agentico per trovare un ricambio partendo dalla matricola
del mezzo. Claude Sonnet 5 interpreta la richiesta, interroga un indice locale
tramite tool-use e restituisce codice, descrizione, quantità, riferimento e
pagina del documento originale.

## Demo inclusa

- Marca: Charlatte Manutention
- Modello: T135 PH1 80V
- Matricole: `13510073`, `13510074`
- Catalogo sorgente: `t135_movincar_avio_global_services_ar197350_REV00.pdf`
- Dati indicizzati: 559 righe meccaniche estratte + 26 ricambi elettrici

I PDF originali non sono inclusi nel repository perché possono essere pesanti o
riservati. Lo script `scripts/index_catalogs.py` genera l'indice distribuibile
`data/catalog-index.json`; i ricambi elettrici verificati sono in
`src/data/catalog.ts`.

## Architettura

1. `GET /api/catalog` verifica la matricola senza coinvolgere l'LLM.
2. `POST /api/chat` invia a Claude solo catalogo, richiesta e cronologia breve.
3. Claude chiama il tool server-side `search_parts`.
4. Il retriever cerca esclusivamente nell'indice della matricola verificata.
5. I dati mostrati dalla UI provengono dal tool, non dal testo generato.

## Avvio locale

```bash
npm install
python -m pip install -r requirements.txt
npm run index:catalogs
npm run dev
```

`npm run dev` usa Vercel Dev per servire sia Vite sia le funzioni `/api`.
Provare la matricola `13510073`.

## Variabili d'ambiente

Copiare `.env.example` in `.env.local` e inserire:

```dotenv
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-5
```

La chiave è letta soltanto dalla Vercel Function. Non usare mai il prefisso
`VITE_`, perché renderebbe il valore accessibile al browser.

Su Vercel:

1. aprire il progetto e andare in **Settings → Environment Variables**;
2. aggiungere `ANTHROPIC_API_KEY` come valore **Sensitive**;
3. abilitarla per Production, Preview e Development;
4. aggiungere `ANTHROPIC_MODEL` con valore `claude-sonnet-5`;
5. avviare un nuovo deployment.

Per sincronizzare le variabili in locale:

```bash
npx vercel link
npx vercel env pull .env.local
```

## Verifica

```bash
npm run lint
npm run test
npm run build
```
