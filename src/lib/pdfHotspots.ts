import * as pdfjs from 'pdfjs-dist'
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker

export type Hotspot = {
  item: string
  x: number
  y: number
  synthetic?: boolean
}

const ITEM_RE = /^\d+(?:[.-]\d+)*(?:[A-Za-z])?$/

function normalizeItem(value: string) {
  return value.trim().toUpperCase()
}

function fallbackHotspots(items: string[]): Hotspot[] {
  const columns = items.length > 8 ? 2 : 1
  const rows = Math.max(1, Math.ceil(items.length / columns))
  return items.map((item, index) => {
    const column = index % columns
    const row = Math.floor(index / columns)
    return {
      item,
      x: 0.08 + column * 0.12,
      y: 0.12 + ((row + 0.5) * 0.76) / rows,
      synthetic: true,
    }
  })
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
    const viewport = page.getViewport({ scale: 1.35 })
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas non disponibile.')
    canvas.width = Math.floor(viewport.width)
    canvas.height = Math.floor(viewport.height)
    await page.render({ canvasContext: context, viewport }).promise

    const text = await page.getTextContent()
    const scored = new Map<string, { score: number; x: number; y: number }>()
    for (const entry of text.items) {
      if (!('str' in entry) || !entry.str) continue
      const token = normalizeItem(entry.str)
      if (!items.has(token)) continue
      const transform = entry.transform
      const tx = transform[4] / viewport.width
      const ty = 1 - transform[5] / viewport.height
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
      .sort((left, right) => left.y - right.y || left.x - right.x || left.item.localeCompare(right.item))

    if (hotspots.length < Math.max(1, Math.floor(items.size / 3))) {
      return fallbackHotspots([...items].sort((a, b) => a.length - b.length || a.localeCompare(b)))
    }
    return hotspots
  } finally {
    await pdf.destroy()
  }
}
