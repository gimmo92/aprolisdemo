import Anthropic from '@anthropic-ai/sdk'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { z } from 'zod'
import { findCatalog, searchParts } from './lib/retrieval.js'
import {
  findSupabaseCatalog,
  searchSupabaseParts,
} from './lib/supabase-retrieval.js'
import { isSupabaseConfigured } from './lib/supabase.js'
import type { IndexedPart } from './lib/types.js'

const requestSchema = z.object({
  serial: z.string().trim().min(4).max(32),
  query: z.string().trim().min(2).max(500),
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

const systemPrompt = `Sei l'assistente ricambi Apròlis.
Rispondi sempre in italiano, in modo sintetico e professionale.
Devi usare search_parts prima di proporre qualsiasi ricambio.
Puoi citare solo codici, quantità, riferimenti e pagine presenti nei risultati del tool.
Non inventare mai un codice o una compatibilità.
Se i risultati non sono sufficienti, dichiaralo e chiedi un dettaglio tecnico mirato.
La quantità è quella richiesta dalla tavola per quella specifica posizione, non la disponibilità a magazzino.`

function textFromResponse(message: Anthropic.Messages.Message) {
  return message.content
    .filter((block): block is Anthropic.Messages.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

function publicPart(part: IndexedPart) {
  return {
    code: part.code,
    description: part.description,
    originalDescription: part.originalDescription,
    quantity: part.quantity,
    item: part.item,
    page: part.page,
    category: part.category,
    keywords: [],
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

  const { serial, query, history } = parsed.data
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

  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    maxRetries: 1,
    timeout: 25_000,
  })

  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5'
  const messages: Anthropic.Messages.MessageParam[] = [
    ...history.map(
      (item): Anthropic.Messages.MessageParam => ({
        role: item.role,
        content: item.content,
      }),
    ),
    {
      role: 'user',
      content:
        `Matricola verificata: ${serial}. Modello: ${catalog.version}. ` +
        `Richiesta ricambio: ${query}`,
    },
  ]

  const retrieved = new Map<string, IndexedPart>()

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
          let parts: IndexedPart[] = []
          if (toolInput.success) {
            if (isSupabaseConfigured()) {
              try {
                parts =
                  (await searchSupabaseParts(
                    serial,
                    toolInput.data.query,
                    toolInput.data.limit,
                  )) || []
              } catch (error) {
                console.error('Supabase search failed; using bundled fallback', error)
              }
            }
            if (!parts.length && localCatalog) {
              parts = searchParts(serial, toolInput.data.query, toolInput.data.limit)
            }
          }

          for (const part of parts) {
            retrieved.set(`${part.code}|${part.item}|${part.page}`, part)
          }

          return {
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: JSON.stringify({
              catalog: {
                model: catalog.version,
                serial,
                document: catalog.documentName,
              },
              parts: parts.map(publicPart),
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
      })
    }

    const verifiedParts = [...retrieved.values()].slice(0, 6)
    const parts = verifiedParts.map(publicPart)
    const generatedAnswer =
      textFromResponse(aiMessage) ||
      (parts.length
        ? `Ho trovato ${parts.length} ricambi compatibili nel catalogo.`
        : 'Non ho trovato un ricambio sufficientemente compatibile.')
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
