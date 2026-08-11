import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import {
  fallbackHotspots,
  scoreHotspotCandidate,
  type Hotspot,
} from './hotspotLayout'

export type { Hotspot } from './hotspotLayout'

const ITEM_RE = /^\d+(?:[.-]\d+)*(?:[A-Za-z])?$/
type PdfTextItem = {
  str?: string
  transform: number[]
}

function normalizeItem(value: string) {
  return value.trim().toUpperCase()
}

export async function renderExplodedPage(
  pdfUrl: string,
  pageNumber: number,
  itemNumbers: string[],
  canvas: HTMLCanvasElement,
): Promise<{ hotspots: Hotspot[]; drawingPage: number }> {
  const items = new Set(
    itemNumbers.map(normalizeItem).filter((item) => ITEM_RE.test(item)),
  )
  const pdfjs = await import('pdfjs-dist')
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker
  const loadingTask = pdfjs.getDocument({
    url: pdfUrl,
    withCredentials: false,
  })
  const pdf = await loadingTask.promise
  try {
    if (pageNumber < 1 || pageNumber > pdf.numPages) {
      throw new Error(`Pagina ${pageNumber} non presente nel PDF.`)
    }
    const candidates = await Promise.all(
      [pageNumber - 2, pageNumber - 1, pageNumber]
        .filter((candidate) => candidate >= 1 && candidate <= pdf.numPages)
        .map(async (candidate) => {
          const page = await pdf.getPage(candidate)
          const viewport = page.getViewport({ scale: 1.45 })
          const text = await page.getTextContent()
          const matches = text.items.flatMap((entry) => {
            if (!entry || typeof entry !== 'object') return []
            const item = entry as PdfTextItem
            if (!item.str) return []
            const token = normalizeItem(item.str)
            if (!items.has(token)) return []
            const [viewportX, viewportY] = viewport.convertToViewportPoint(
              item.transform[4],
              item.transform[5],
            )
            return [{
              item: token,
              transform: item.transform,
              x: viewportX / viewport.width,
              y: viewportY / viewport.height,
            }]
          })
          return {
            number: candidate,
            page,
            viewport,
            matches,
            score: scoreHotspotCandidate(matches),
          }
        }),
    )
    const selected = candidates.sort(
      (left, right) => right.score - left.score || right.number - left.number,
    )[0]
    if (!selected) throw new Error('Tavola PDF non disponibile.')

    const { page, viewport, matches } = selected
    canvas.width = Math.floor(viewport.width)
    canvas.height = Math.floor(viewport.height)
    await page.render({ canvas, viewport }).promise

    const scored = new Map<string, { score: number; x: number; y: number }>()
    for (const match of matches) {
      let score = 0
      if (match.y < 0.68) score += 3
      if (match.x < 0.62) score += 2
      const width = Math.abs(match.transform[0] || 0)
      score += Math.max(0, 2.5 - width / 40)
      const previous = scored.get(match.item)
      if (!previous || score > previous.score) {
        scored.set(match.item, {
          score,
          x: match.x,
          y: match.y,
        })
      }
    }

    const hotspots = [...scored.entries()]
      .map(([item, value]) => ({
        item,
        x: Number(value.x.toFixed(4)),
        y: Number(value.y.toFixed(4)),
      }))
      .sort(
        (left, right) =>
          left.y - right.y ||
          left.x - right.x ||
          left.item.localeCompare(right.item),
      )

    if (hotspots.length < Math.max(1, Math.floor(items.size / 3))) {
      return {
        hotspots: fallbackHotspots(
          [...items].sort((a, b) => a.length - b.length || a.localeCompare(b)),
        ),
        drawingPage: selected.number,
      }
    }
    return { hotspots, drawingPage: selected.number }
  } finally {
    await loadingTask.destroy()
  }
}
