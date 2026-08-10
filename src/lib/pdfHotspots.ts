export type Hotspot = {
  item: string
  x: number
  y: number
  synthetic?: boolean
}

const ITEM_RE = /^\d+(?:[.-]\d+)*(?:[A-Za-z])?$/
const PDFJS_VERSION = '4.10.38'
const PDFJS_CDN = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}`

type PdfTextItem = {
  str?: string
  transform: number[]
}

type PdfPage = {
  getViewport: (params: { scale: number }) => {
    width: number
    height: number
  }
  render: (params: {
    canvasContext: CanvasRenderingContext2D
    viewport: { width: number; height: number }
  }) => { promise: Promise<void> }
  getTextContent: () => Promise<{ items: Array<PdfTextItem | unknown> }>
}

type PdfDocument = {
  numPages: number
  getPage: (pageNumber: number) => Promise<PdfPage>
  destroy: () => Promise<void>
}

type PdfJsModule = {
  GlobalWorkerOptions: { workerSrc: string }
  getDocument: (src: {
    url: string
    withCredentials?: boolean
  }) => { promise: Promise<PdfDocument> }
}

let pdfjsLoader: Promise<PdfJsModule> | null = null

function loadPdfJs() {
  if (!pdfjsLoader) {
    pdfjsLoader = import(
      /* @vite-ignore */
      `${PDFJS_CDN}/+esm`
    ).then((module) => {
      const pdfjs = module as PdfJsModule
      pdfjs.GlobalWorkerOptions.workerSrc = `${PDFJS_CDN}/build/pdf.worker.min.mjs`
      return pdfjs
    })
  }
  return pdfjsLoader
}

function normalizeItem(value: string) {
  return value.trim().toUpperCase()
}

export function fallbackHotspots(items: string[]): Hotspot[] {
  const unique = [...new Set(items.map(normalizeItem).filter(Boolean))]
  const columns = unique.length > 8 ? 2 : 1
  const rows = Math.max(1, Math.ceil(unique.length / columns))
  return unique.map((item, index) => {
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
  const pdfjs = await loadPdfJs()
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
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas non disponibile.')
    canvas.width = Math.floor(viewport.width)
    canvas.height = Math.floor(viewport.height)
    await page.render({ canvasContext: context, viewport }).promise

    const text = await page.getTextContent()
    const scored = new Map<string, { score: number; x: number; y: number }>()
    for (const entry of text.items) {
      if (!entry || typeof entry !== 'object') continue
      const item = entry as PdfTextItem
      if (!item.str) continue
      const token = normalizeItem(item.str)
      if (!items.has(token)) continue
      const transform = item.transform
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
    await pdf.destroy()
  }
}
