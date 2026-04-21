import { PNG } from 'pngjs'
import fs from 'fs'

const buf = fs.readFileSync('/Users/jasperkennis/Projects/pixel-agents/webview-ui/public/assets/outdoor/summer-forest.png')
const png = PNG.sync.read(buf)
const CELL = 16
const SHEET_COLS = 16
const SHEET_ROWS = 16

function tileStats(col, row) {
  let rSum = 0, gSum = 0, bSum = 0, opaque = 0, trans = 0
  for (let y = 0; y < CELL; y++) {
    for (let x = 0; x < CELL; x++) {
      const px = col * CELL + x
      const py = row * CELL + y
      const idx = (py * png.width + px) * 4
      if (png.data[idx + 3] >= 128) {
        rSum += png.data[idx]
        gSum += png.data[idx + 1]
        bSum += png.data[idx + 2]
        opaque++
      } else trans++
    }
  }
  const r = opaque > 0 ? Math.round(rSum / opaque) : 0
  const g = opaque > 0 ? Math.round(gSum / opaque) : 0
  const b = opaque > 0 ? Math.round(bSum / opaque) : 0
  const transFrac = trans / (CELL * CELL)
  return { r, g, b, transFrac, opaque }
}

function classify({ r, g, b, transFrac }) {
  if (transFrac > 0.5) return 'TRANS'
  // Green-dominant -> grass
  if (g > r * 1.15 && g > b * 1.15 && g > 80) return 'grass'
  if (g > r && g > b && g > 50) return 'dark_green'
  // Blue-dominant -> water
  if (b > r * 1.1 && b > g * 1.1) return 'water'
  // Pinkish/brown cliff stone
  if (r > 120 && g > 90 && b > 80 && r >= g && r >= b) return 'cliff'
  // Grey/stone
  if (Math.abs(r - g) < 25 && Math.abs(g - b) < 25 && r > 100) return 'stone'
  // Brown dirt
  if (r > g && g > b && r > 80) return 'dirt'
  if (r < 60 && g < 60 && b < 60) return 'dark'
  return '???'
}

console.log('   ' + [...Array(SHEET_COLS).keys()].map(i => String(i).padStart(5)).join(''))
for (let row = 0; row < SHEET_ROWS; row++) {
  const cells = []
  for (let col = 0; col < SHEET_COLS; col++) {
    const stats = tileStats(col, row)
    const cls = classify(stats)
    cells.push(cls.padStart(5).slice(0, 5))
  }
  console.log(String(row).padStart(2) + ':' + cells.join(''))
}
