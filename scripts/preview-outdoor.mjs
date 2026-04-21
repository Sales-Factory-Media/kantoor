// Quick offline preview: render a small patch of the new outdoor generator
// without needing a browser / webview. Renders to PNG.
import { PNG } from 'pngjs'
import fs from 'fs'

const buf = fs.readFileSync('/Users/jasperkennis/Projects/pixel-agents/webview-ui/public/assets/outdoor/summer-forest.png')
const sheet = PNG.sync.read(buf)
const CELL = 16

// Inline copy of the generator — just the deterministic parts we need
function createRng(seed) {
  let s = seed | 0
  return () => {
    s = (s + 0x6D2B79F5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const OUTDOOR_MARGIN = 30
const GRASS_TILES = [[0, 4], [0, 5]]
const OBJECTS = [
  { type: 'tree', sheetCol: 11, sheetRow: 0, w: 5, h: 4, minSpacing: 5, maxCount: 22, tier: 'landmark' },
  { type: 'cliff', sheetCol: 5, sheetRow: 0, w: 6, h: 4, minSpacing: 8, maxCount: 4, tier: 'landmark' },
  { type: 'pond', sheetCol: 11, sheetRow: 13, w: 4, h: 2, minSpacing: 6, maxCount: 4, tier: 'landmark' },
  { type: 'bridge', sheetCol: 1, sheetRow: 10, w: 4, h: 2, minSpacing: 6, maxCount: 2, tier: 'landmark' },
  { type: 'bush-a', sheetCol: 0, sheetRow: 8, w: 1, h: 1, minSpacing: 3, maxCount: 35, tier: 'prop' },
  { type: 'bush-b', sheetCol: 1, sheetRow: 8, w: 1, h: 1, minSpacing: 3, maxCount: 35, tier: 'prop' },
  { type: 'bush-big', sheetCol: 2, sheetRow: 8, w: 2, h: 2, minSpacing: 4, maxCount: 15, tier: 'prop' },
  { type: 'rock', sheetCol: 3, sheetRow: 7, w: 1, h: 1, minSpacing: 3, maxCount: 20, tier: 'prop' },
  { type: 'flowers-a', sheetCol: 0, sheetRow: 6, w: 1, h: 1, minSpacing: 2, maxCount: 80, tier: 'detail' },
  { type: 'flowers-b', sheetCol: 1, sheetRow: 6, w: 1, h: 1, minSpacing: 2, maxCount: 60, tier: 'detail' },
  { type: 'flowers-c', sheetCol: 2, sheetRow: 6, w: 1, h: 1, minSpacing: 2, maxCount: 60, tier: 'detail' },
]

// Office dimensions placeholder
const officeCols = 40
const officeRows = 20
const width = officeCols + OUTDOOR_MARGIN * 2
const height = officeRows + OUTDOOR_MARGIN * 2

const rng = createRng(42)
const occupied = new Set()
// Office + 2-tile buffer
for (let r = -2; r < officeRows + 2; r++) {
  for (let c = -2; c < officeCols + 2; c++) {
    occupied.add(`${c + OUTDOOR_MARGIN},${r + OUTDOOR_MARGIN}`)
  }
}

const placed = []
const tiers = ['landmark', 'prop', 'detail']
for (const tier of tiers) {
  const defs = OBJECTS.filter(o => o.tier === tier).sort((a, b) => {
    if (tier === 'landmark') return a.maxCount - b.maxCount
    return (b.w * b.h) - (a.w * a.h)
  })
  for (const def of defs) {
    let count = 0
    const maxAttempts = tier === 'landmark' ? def.maxCount * 40 : def.maxCount * 6
    for (let attempt = 0; attempt < maxAttempts && count < def.maxCount; attempt++) {
      const col = Math.floor(rng() * (width - def.w))
      const row = Math.floor(rng() * (height - def.h))
      let canPlace = true
      for (let dr = 0; dr < def.h && canPlace; dr++) {
        for (let dc = 0; dc < def.w && canPlace; dc++) {
          if (occupied.has(`${col + dc},${row + dr}`)) canPlace = false
        }
      }
      if (!canPlace) continue
      const tooClose = placed.some(p => {
        const dx = Math.abs((col + def.w/2) - (p.col + p.w/2))
        const dy = Math.abs((row + def.h/2) - (p.row + p.h/2))
        return dx < def.minSpacing + (p.w + def.w)/2 && dy < def.minSpacing + (p.h + def.h)/2
      })
      if (tooClose) continue
      placed.push({ ...def, col, row })
      for (let dr = 0; dr < def.h; dr++) for (let dc = 0; dc < def.w; dc++) occupied.add(`${col + dc},${row + dr}`)
      count++
    }
    console.error(`  ${def.type.padEnd(12)}: ${count}`)
  }
}

console.error(`Total placed: ${placed.length}`)
// Dump landmark positions so we can visually locate them
for (const p of placed.filter(x => x.tier === 'landmark')) {
  console.error(`  ${p.type} at col ${p.col} row ${p.row} (px ${p.col * 16}, ${p.row * 16})`)
}

// Render to PNG
const ground = new Uint8Array(width * height)
for (let i = 0; i < ground.length; i++) ground[i] = Math.floor(rng() * GRASS_TILES.length)

const outW = width * CELL, outH = height * CELL
const out = new PNG({ width: outW, height: outH })
// Clear bg
for (let i = 0; i < out.data.length; i += 4) { out.data[i] = 30; out.data[i+1] = 30; out.data[i+2] = 40; out.data[i+3] = 255 }

function stampSheet(sheetCol, sheetRow, destCol, destRow, w, h) {
  for (let ty = 0; ty < h * CELL; ty++) {
    for (let tx = 0; tx < w * CELL; tx++) {
      const sx = sheetCol * CELL + tx, sy = sheetRow * CELL + ty
      const si = (sy * sheet.width + sx) * 4
      if (sheet.data[si + 3] < 128) continue
      const dx = destCol * CELL + tx, dy = destRow * CELL + ty
      if (dx < 0 || dy < 0 || dx >= outW || dy >= outH) continue
      const di = (dy * outW + dx) * 4
      out.data[di] = sheet.data[si]
      out.data[di+1] = sheet.data[si+1]
      out.data[di+2] = sheet.data[si+2]
      out.data[di+3] = 255
    }
  }
}

// Base grass
for (let r = 0; r < height; r++) {
  for (let c = 0; c < width; c++) {
    const [gc, gr] = GRASS_TILES[ground[r * width + c]]
    stampSheet(gc, gr, c, r, 1, 1)
  }
}

// Office footprint (mark with building color)
for (let r = 0; r < officeRows; r++) {
  for (let c = 0; c < officeCols; c++) {
    const dx = (c + OUTDOOR_MARGIN) * CELL, dy = (r + OUTDOOR_MARGIN) * CELL
    for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
      const di = ((dy + y) * outW + (dx + x)) * 4
      out.data[di] = 40; out.data[di+1] = 40; out.data[di+2] = 50; out.data[di+3] = 255
    }
  }
}

// Props
for (const p of placed) stampSheet(p.sheetCol, p.sheetRow, p.col, p.row, p.w, p.h)

fs.writeFileSync('/tmp/outdoor-preview.png', PNG.sync.write(out))
console.error(`/tmp/outdoor-preview.png (${outW}x${outH})`)
