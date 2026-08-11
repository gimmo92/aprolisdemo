import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { fallbackHotspots, type Hotspot } from './hotspotLayout'

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
): Promise<Hotspot[]> {
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
    const page = await pdf.getPage(pageNumber)
    const viewport = page.getViewport({ scale: 1.45 })
    canvas.width = Math.floor(viewport.width)
    canvas.height = Math.floor(viewport.height)
    await page.render({ canvas, viewport }).promise

    const text = await page.getTextContent()
    const scored = new Map<string, { score: number; x: number; y: number }>()
    for (const entry of text.items) {
      if (!entry || typeof entry !== 'object') continue
      const item = entry as PdfTextItem
      if (!item.str) continue
      const token = normalizeItem(item.str)
      if (!items.has(token)) continue
      const transform = item.transform
      const [viewportX, viewportY] = viewport.convertToViewportPoint(
        transform[4],
        transform[5],
      )
      const tx = viewportX / viewport.width
      const ty = viewportY / viewport.height
      let score = 0
      if (ty < 0.68) score += 3
      if (tx < 0.62) score += 2
      const width = Math.abs(transform[0] || 0)
      score += Math.max(0, 2.5 - width / 40)
      const previous = scored.get(token)
      if (!previous || score > previous.score) {
        scored.set(token, { score, x: tx, y: ty })
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
      return fallbackHotspots(
        [...items].sort((a, b) => a.length - b.length || a.localeCompare(b)),
      )
    }
    return hotspots
  } finally {
    await loadingTask.destroy()
  }
}
