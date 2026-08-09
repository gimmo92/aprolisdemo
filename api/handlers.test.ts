import type { VercelRequest, VercelResponse } from '@vercel/node'
import { afterEach, describe, expect, it } from 'vitest'
import catalogHandler from './catalog.js'
import chatHandler from './chat.js'
import partsHandler from './parts.js'

function mockResponse() {
  const result: {
    statusCode: number
    body: unknown
    headers: Record<string, string>
  } = {
    statusCode: 200,
    body: undefined,
    headers: {},
  }

  const response = {
    setHeader(name: string, value: string) {
      result.headers[name] = value
      return response
    },
    status(code: number) {
      result.statusCode = code
      return response
    },
    json(body: unknown) {
      result.body = body
      return response
    },
  } as unknown as VercelResponse

  return { response, result }
}

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY
})

describe('API handlers', () => {
  it('returns catalog metadata for a known serial', () => {
    const { response, result } = mockResponse()
    const request = {
      method: 'GET',
      query: { serial: '13510073' },
    } as unknown as VercelRequest

    catalogHandler(request, response)

    expect(result.statusCode).toBe(200)
    expect(result.body).toMatchObject({
      catalog: {
        model: 'T135',
        partCount: expect.any(Number),
      },
    })
  })

  it('rejects an unknown serial before calling Anthropic', async () => {
    const { response, result } = mockResponse()
    const request = {
      method: 'POST',
      body: { serial: '99999999', query: 'freno', history: [] },
    } as unknown as VercelRequest

    await chatHandler(request, response)
    expect(result.statusCode).toBe(404)
  })

  it('reports a missing server-side API key', async () => {
    const { response, result } = mockResponse()
    const request = {
      method: 'POST',
      body: { serial: '13510073', query: 'freno', history: [] },
    } as unknown as VercelRequest

    await chatHandler(request, response)
    expect(result.statusCode).toBe(503)
    expect(result.body).toMatchObject({
      error: expect.stringContaining('ANTHROPIC_API_KEY'),
    })
  })

  it('returns the full indexed parts list with PDF references', () => {
    const { response, result } = mockResponse()
    const request = {
      method: 'GET',
      query: { serial: '13510073' },
    } as unknown as VercelRequest

    partsHandler(request, response)

    expect(result.statusCode).toBe(200)
    expect(result.body).toMatchObject({
      catalog: { model: 'T135' },
      parts: expect.arrayContaining([
        expect.objectContaining({
          code: 'LROEX100008',
          page: 301,
        }),
      ]),
      filters: {
        categories: expect.any(Array),
        sourceTypes: ['mechanical', 'electrical'],
        pageMin: expect.any(Number),
        pageMax: expect.any(Number),
      },
    })
  })
})
