import Anthropic from '@anthropic-ai/sdk'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { z } from 'zod'
import { findCatalog, searchParts } from './lib/retrieval.js'
import {
  findExplodedViewIds,
  findSupabaseCatalog,
  searchSupabaseParts,
} from './lib/supabase-retrieval.js'
import { selectSpareParts, MAX_SPARE_PARTS } from './lib/spare-part-selection.js'
import { isSupabaseConfigured } from './lib/supabase.js'
import type { IndexedPart } from './lib/types.js'

const requestSchema = z
  .object({
    serial: z.string().trim().min(4).max(32),
    query: z.string().trim().max(500).default(''),
    imageBase64: z.string().min(80).max(2_500_000).optional(),
    mediaType: z.enum(['image/jpeg', 'image/png', 'image/webp']).optional(),
    history: z
      .array(
        z.object({
          role: z.enum(['user', 'assistant']),
          content: z.string().trim().min(1).max(800),
        }),
      )
      .max(6)
      .optional()
      .default([]),
  })
  .superRefine((value, ctx) => {
    const hasImage = Boolean(value.imageBase64 && value.mediaType)
    if (!hasImage && value.query.trim().length < 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Serve una query o un’immagine.',
        path: ['query'],
      })
    }
    if (value.imageBase64 && !value.mediaType) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'mediaType richiesto con imageBase64.',
        path: ['mediaType'],
      })
    }
  })

const toolInputSchema = z.object({
  query: z.string().trim().min(1).max(300),
  limit: z.number().int().min(1).max(10).optional().default(6),
})

const searchTool: Anthropic.Messages.Tool = {
  name: 'search_parts',
  description:
    'Cerca esclusivamente nell’indice ricambi già filtrato per la matricola corrente. ' +
    'Usa termini tecnici italiani, inglesi o francesi e includi eventuali sinonimi utili.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Termini di ricerca ottimizzati: componente, funzione, codice o sinonimi tecnici.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 10,
        description: 'Numero massimo di candidati da recuperare.',
      },
    },
    required: ['query'],
  },
}

const systemPrompt = `Sei l'agente di identificazione ricambi after-sales Aftercore.
Parli in italiano, tono tecnico ma chiaro.
Usi SOLO il catalogo restituito da search_parts per la matricola corrente, più gli eventuali candidati pre-calcolati nel messaggio. Non inventare codici, prezzi o descrizioni.
Il catalogo non ha prezzi né giacenza: price deve essere 0. Non dichiarare disponibilità di magazzino. La quantità è quella della tavola per quella posizione.

## ALLEGATI
- Se l'utente invia FOTO: osserva forma del pezzo, materiali, dentature, cinghie, etichette, part number stampati, brand/OEM.
- Combina foto + testo del messaggio.
- Se la foto è sfocata o ambigua, spiega cosa manca nel "message" e imposta spareParts=null o pochi candidati con confidence bassa.

## REGOLE DI MATCH
1. Proponi SOLO articoli presenti nel catalogo (code esatto del catalogo).
2. Il TIPO del pezzo in foto deve coincidere con la descrizione catalogo (es. pignone/ingranaggio ≠ valvola ≠ filtro).
3. Se l'utente scrive un codice/OEM identico a una voce catalogo → confidence DEVE essere 100 per quella voce.
4. confidence è un intero 0–100: quanto sei sicuro che quel codice corrisponda a foto + descrizione utente.
   - 90–100: codice visibile o match quasi certo
   - 70–89: stesso tipo e descrizione molto coerente
   - 50–69: plausibile ma da verificare
   - sotto 50: non includere il pezzo (meglio ometterlo)
5. Se nessun match credibile: spareParts=null. Meglio zero risultati che codici sbagliati.
6. Se manca il prezzo in catalogo usa 0. Non inventare availability di magazzino.

## STRUMENTO
Alla prima risposta chiama search_parts con termini tecnici mirati (italiano, inglese o francese) ricavati da foto e testo.
Quando non chiami il tool, la risposta finale è ESCLUSIVAMENTE JSON valido, senza markdown e senza testo fuori dal JSON:
{
  "message": "messaggio per l'utente: cosa hai visto, cosa proponi, cosa chiedere se serve",
  "spareParts": null oppure [
    {
      "code": "CODICE_CATALOGO",
      "description": "descrizione breve dal catalogo",
      "price": 0,
      "availability": "da_ordinare",
      "leadTimeDays": 0,
      "confidence": 85,
      "oemCode": "opzionale",
      "brand": "opzionale"
    }
  ]
}

Ordina spareParts per confidence decrescente. Massimo ${MAX_SPARE_PARTS} voci.`

function textFromResponse(message: Anthropic.Messages.Message) {
  return message.content
    .filter((block): block is Anthropic.Messages.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

function publicPart(
  part: IndexedPart,
  catalogId?: string,
  viewId?: string,
  confidence?: number,
) {
  return {
    code: part.code,
    description: part.description,
    originalDescription: part.originalDescription,
    quantity: part.quantity,
    item: part.item,
    page: part.page,
    category: part.category,
    keywords: [],
    ...(catalogId ? { catalogId } : {}),
    ...(viewId ? { viewId } : {}),
    ...(typeof confidence === 'number' ? { confidence } : {}),
  }
}

const selectionSchema = z.object({
  message: z.string().trim().min(1).max(2000),
  spareParts: z
    .array(
      z.object({
        code: z.string(),
        confidence: z.coerce.number(),
      }),
    )
    .nullable()
    .optional(),
})

function extractSelection(text: string) {
  const fenced = text.trim().match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = (fenced?.[1] ?? text).trim()
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end < start) return null
  try {
    const parsed = selectionSchema.safeParse(JSON.parse(body.slice(start, end + 1)))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function formatHits(parts: IndexedPart[]) {
  if (!parts.length) return 'nessuno'
  return parts
    .map(
      (part) =>
        `- ${part.code} | ${part.description} | pos. ${part.item} | pag. ${part.page}`,
    )
    .join('\n')
}

async function lookupParts(serial: string, query: string, limit: number, allowLocal: boolean) {
  let parts: IndexedPart[] = []
  if (isSupabaseConfigured()) {
    try {
      parts = (await searchSupabaseParts(serial, query, limit)) || []
    } catch (error) {
      console.error('Supabase search failed; using bundled fallback', error)
    }
  }
  if (!parts.length && allowLocal) {
    parts = searchParts(serial, query, limit)
  }
  return parts
}

function rememberParts(retrieved: Map<string, IndexedPart>, parts: IndexedPart[]) {
  for (const part of parts) {
    retrieved.set(`${part.code}|${part.item}|${part.page}`, part)
  }
}

function safeAnswer(answer: string, parts: IndexedPart[]) {
  const verifiedCodes = new Set(parts.map((part) => part.code.toUpperCase()))
  const mentionedCodes =
    answer.match(/\b(?=[A-Z0-9._/-]{6,}\b)(?=[A-Z0-9._/-]*\d)[A-Z][A-Z0-9._/-]+\b/g) ??
    []
  const hasUnverifiedCode = mentionedCodes.some(
    (code) => !verifiedCodes.has(code.toUpperCase()),
  )

  if (hasUnverifiedCode) {
    return parts.length
      ? `Ho trovato ${parts.length} possibili ricambi nel catalogo. I dati verificati sono riportati nelle schede qui sotto.`
      : 'Non ho trovato un ricambio verificabile con i dettagli disponibili.'
  }
  return answer
}

function anthropicErrorDetails(error: unknown, model: string) {
  if (!(error instanceof Anthropic.APIError)) {
    return {
      error: 'Il servizio AI non è momentaneamente disponibile. Riprova tra poco.',
      code: 'ANTHROPIC_UNAVAILABLE',
    }
  }

  switch (error.status) {
    case 400:
      return {
        error: `Anthropic ha rifiutato la configurazione della richiesta per ${model}.`,
        code: 'ANTHROPIC_BAD_REQUEST',
      }
    case 401:
      return {
        error: 'La chiave Anthropic configurata su Vercel non è valida.',
        code: 'ANTHROPIC_INVALID_KEY',
      }
    case 403:
      return {
        error: `La chiave Anthropic non ha accesso al modello ${model}.`,
        code: 'ANTHROPIC_MODEL_FORBIDDEN',
      }
    case 404:
      return {
        error: `Il modello Anthropic ${model} non è disponibile per questo account.`,
        code: 'ANTHROPIC_MODEL_NOT_FOUND',
      }
    case 429:
      return {
        error: 'Quota Anthropic esaurita o limite di richieste raggiunto.',
        code: 'ANTHROPIC_RATE_LIMIT',
      }
    default:
      return {
        error: 'Anthropic non è momentaneamente disponibile. Riprova tra poco.',
        code: 'ANTHROPIC_UPSTREAM_ERROR',
      }
  }
}

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
) {
  response.setHeader('Cache-Control', 'no-store')

  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST')
    return response.status(405).json({ error: 'Metodo non consentito.' })
  }

  const parsed = requestSchema.safeParse(request.body)
  if (!parsed.success) {
    return response.status(400).json({
      error: 'Richiesta non valida.',
      details: parsed.error.issues.map((issue) => issue.message),
    })
  }

  const { serial, query, history, imageBase64, mediaType } = parsed.data
  const localCatalog = findCatalog(serial)
  const remoteCatalog = isSupabaseConfigured()
    ? await findSupabaseCatalog(serial)
    : undefined
  const catalog = remoteCatalog?.catalog || localCatalog
  if (!catalog) {
    return response.status(404).json({
      error: 'Matricola non presente nei cataloghi indicizzati.',
    })
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return response.status(503).json({
      error: 'Servizio AI non configurato. Imposta ANTHROPIC_API_KEY su Vercel.',
    })
  }

  const hasImage = Boolean(imageBase64 && mediaType)
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    maxRetries: 1,
    timeout: hasImage ? 50_000 : 25_000,
  })

  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5'
  const retrieved = new Map<string, IndexedPart>()
  const preliminary =
    query.trim().length >= 2
      ? await lookupParts(serial, query.trim(), MAX_SPARE_PARTS, Boolean(localCatalog))
      : []
  rememberParts(retrieved, preliminary)
  const requestText =
    `Matricola verificata: ${serial}. Modello: ${catalog.version}.\n` +
    `Candidati pre-calcolati dal server (ranking testuale, da verificare sulla foto):\n${formatHits(preliminary)}\n` +
    (hasImage
      ? `L'utente ha inviato una foto del ricambio${
          query.trim() ? ` con nota: ${query.trim()}` : ''
        }. Identifica il pezzo e cerca i candidati nel catalogo.`
      : `Richiesta ricambio: ${query}`)

  const userContent: Anthropic.Messages.ContentBlockParam[] = hasImage
    ? [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: mediaType!,
            data: imageBase64!.replace(/^data:[^;]+;base64,/, ''),
          },
        },
        { type: 'text', text: requestText },
      ]
    : [{ type: 'text', text: requestText }]

  const messages: Anthropic.Messages.MessageParam[] = [
    ...history.map(
      (item): Anthropic.Messages.MessageParam => ({
        role: item.role,
        content: item.content,
      }),
    ),
    {
      role: 'user',
      content: userContent,
    },
  ]

  try {
    let aiMessage = await client.messages.create({
      model,
      max_tokens: 900,
      system: systemPrompt,
      messages,
      tools: [searchTool],
      tool_choice: { type: 'tool', name: 'search_parts' },
    })

    for (let iteration = 0; iteration < 2; iteration += 1) {
      const toolUses = aiMessage.content.filter(
        (block): block is Anthropic.Messages.ToolUseBlock => block.type === 'tool_use',
      )
      if (!toolUses.length) break

      const toolResults: Anthropic.Messages.ToolResultBlockParam[] =
        await Promise.all(
          toolUses.map(async (toolUse) => {
          const toolInput = toolInputSchema.safeParse(toolUse.input)
          const parts = toolInput.success
            ? await lookupParts(
                serial,
                toolInput.data.query,
                toolInput.data.limit,
                Boolean(localCatalog),
              )
            : []
          rememberParts(retrieved, parts)

          return {
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: JSON.stringify({
              catalog: {
                model: catalog.version,
                serial,
                document: catalog.documentName,
              },
              parts: parts.map((part) => publicPart(part)),
            }),
          }
          }),
        )

      messages.push({ role: 'assistant', content: aiMessage.content })
      messages.push({ role: 'user', content: toolResults })
      aiMessage = await client.messages.create({
        model,
        max_tokens: 900,
        system: systemPrompt,
        messages,
        tools: [searchTool],
        ...(iteration === 1 ? { tool_choice: { type: 'none' as const } } : {}),
      })
    }

    const selection = extractSelection(textFromResponse(aiMessage))
    const selected = selectSpareParts(query, [...retrieved.values()], selection?.spareParts)
    const verifiedParts = selected.map((entry) => entry.part)
    let viewIds = new Map<string, string>()
    if (remoteCatalog) {
      try {
        viewIds = await findExplodedViewIds(
          remoteCatalog.catalog.id,
          verifiedParts.flatMap((part) =>
            part.assemblyCode ? [part.assemblyCode] : [],
          ),
        )
      } catch (error) {
        console.error('Exploded deep-link lookup failed', error)
      }
    }
    const parts = selected.map((entry) =>
      publicPart(
        entry.part,
        catalog.id,
        entry.part.assemblyCode ? viewIds.get(entry.part.assemblyCode) : undefined,
        entry.confidence,
      ),
    )
    const generatedAnswer =
      selection?.message ||
      (parts.length
        ? `Ho trovato ${parts.length} ricambi compatibili nel catalogo.`
        : 'Non ho trovato un ricambio sufficientemente compatibile. Servono un codice, una foto più nitida o il tipo di pezzo.')
    const answer = safeAnswer(generatedAnswer, verifiedParts)

    return response.status(200).json({
      answer,
      parts,
      catalog: {
        id: catalog.id,
        model: catalog.model,
        version: catalog.version,
        serial,
        documentName: catalog.documentName,
        documentPages: catalog.documentPages,
        partCount: catalog.partCount,
      },
      model,
    })
  } catch (error) {
    const details = anthropicErrorDetails(error, model)
    console.error('Anthropic retrieval failed', {
      code: details.code,
      model,
      status: error instanceof Anthropic.APIError ? error.status : undefined,
      requestId: error instanceof Anthropic.APIError ? error.requestID : undefined,
      message: error instanceof Error ? error.message : 'Unknown error',
    })
    return response.status(502).json({
      ...details,
    })
  }
}
