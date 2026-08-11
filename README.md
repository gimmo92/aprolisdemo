# Apròlis Parts Finder

Web app con retrieval agentico per trovare un ricambio partendo dalla matricola
del mezzo. Claude interpreta la richiesta e interroga l'indice Supabase; gli
amministratori possono caricare PDF privati con upload riprendibile TUS e
indicizzazione automatica multi-brand.

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

1. Supabase Auth e RLS proteggono la tab **Gestione cataloghi**.
2. I PDF restano nel bucket privato `catalogs`; il browser usa upload TUS da 6 MB
   solo per l'ingestione.
   L'amministratore seleziona solo il file: brand, modello, versione, revisione,
   cliente, ordine e matricole vengono riconosciuti dal documento.
3. `POST /api/index_catalog` valida e indicizza Charlatte, Hangcha, Movexx e
   Fiorentini con parser deterministici e fallback Claude per metadati o pagine
   dubbie.
4. Durante l'indicizzazione PyMuPDF estrae gli esplosi come SVG sanitizzati,
   callout e fallback PNG. Gli asset sono persistiti nel bucket privato
   `exploded-views`; il PDF non viene mai inviato al browser a runtime.
5. `GET /api/catalog`, `GET /api/parts` e il tool di `POST /api/chat` leggono
   Postgres, filtrati per matricola. L'indice JSON resta un fallback temporaneo.
6. `GET /api/exploded` restituisce esclusivamente SVG/PNG e geometria JSON.

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
VITE_SUPABASE_URL=https://project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
SUPABASE_URL=https://project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=sb_secret_...
```

Solo URL e publishable key hanno il prefisso `VITE_`. La chiave Anthropic e la
service-role Supabase sono server-side e non devono mai avere quel prefisso.

Su Vercel:

1. aprire il progetto e andare in **Settings → Environment Variables**;
2. aggiungere `ANTHROPIC_API_KEY` e `SUPABASE_SERVICE_ROLE_KEY` come
   valori **Sensitive**;
3. abilitarla per Production, Preview e Development;
4. aggiungere le altre variabili elencate in `.env.example`;
5. avviare un nuovo deployment.

Per sincronizzare le variabili in locale:

```bash
npx vercel link
npx vercel env pull .env.local
```

## Bootstrap Supabase

1. creare un progetto Supabase e, con la CLI collegata, eseguire:

   ```bash
   npx supabase link --project-ref <project-ref>
   npx supabase db push
   ```

2. creare il primo utente dalla tab **Gestione cataloghi** o da Auth;
3. nel SQL Editor sostituire l'email placeholder ed eseguire
   `supabase/seed.sql` per promuovere quell'utente ad amministratore;
4. configurare le quattro variabili Supabase su Vercel e ridistribuire.

Le migration creano tabelle, indici full-text, bucket privati, policy RLS e RPC
server-side. `002_exploded_views.sql` aggiunge gli asset SVG/PNG e le callout.
L'upload è limitato a PDF da 250 MB. Il job termina `ready`, `needs_review`
oppure `failed`, con report, pagine da verificare e qualità `traceRate`.

Dopo l'applicazione della migration 002, reindicizzare i cataloghi già presenti
dalla tab **Gestione cataloghi** per generare gli esplosi persistiti.

### Import dell'indice T135 esistente

Dopo il bootstrap e la promozione admin:

```bash
LEGACY_CATALOG_PDF="/percorso/catalogo.pdf" npm run import:supabase
```

Senza `LEGACY_CATALOG_PDF` vengono importati i dati, ma il PDF deve già trovarsi
nel percorso indicato da `LEGACY_CATALOG_STORAGE_PATH`. L'import usa la RPC
atomica `replace_catalog_parts`.

## Verifica

```bash
npm run lint
npm run test
npm run build
```
