import { PNG } from 'pngjs'
import fs from 'fs'

const buf = fs.readFileSync('/Users/jasperkennis/Projects/pixel-agents/webview-ui/public/assets/outdoor/summer-forest.png')
const png = PNG.sync.read(buf)

// Sample many points known to be grass-background (around cliff edges, tree base, etc)
// These are x,y pixel positions where plain grass should be visible
const samples = []
// Near cliff left edge (tile col 4, row 0 — expect grass on outside edge)
for (let y = 0; y < 4; y++) for (let x = 64; x < 68; x++) samples.push([x, y])
// Near tree right-bottom corner
for (let y = 48; y < 56; y++) for (let x = 170; x < 180; x++) samples.push([x, y])
// Around flowers (col 3, row 4)
for (let y = 64; y < 80; y++) for (let x = 48; x < 64; x++) samples.push([x, y])
// Between tree and cliff (col 9-10, row 2)
for (let y = 32; y < 48; y++) for (let x = 154; x < 160; x++) samples.push([x, y])

const buckets = new Map()
for (const [x, y] of samples) {
  const idx = (y * png.width + x) * 4
  if (png.data[idx + 3] < 128) continue
  const r = png.data[idx], g = png.data[idx + 1], b = png.data[idx + 2]
  // Skip non-greenish pixels (shadows, dirt, stones)
  if (g < r * 1.0 || g < b * 1.0) continue
  // Bucket by RGB rounded to 16
  const key = `${Math.floor(r/16)*16},${Math.floor(g/16)*16},${Math.floor(b/16)*16}`
  buckets.set(key, (buckets.get(key) || 0) + 1)
}

// Top 5 colors
const sorted = [...buckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
for (const [rgb, count] of sorted) {
  const [r, g, b] = rgb.split(',').map(Number)
  const hex = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')
  console.log(`  ${hex}  (rgb ${r},${g},${b}) x ${count}`)
}
