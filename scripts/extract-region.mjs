import { PNG } from 'pngjs'
import fs from 'fs'
const buf = fs.readFileSync('/Users/jasperkennis/Projects/pixel-agents/webview-ui/public/assets/outdoor/summer-forest.png')
const png = PNG.sync.read(buf)
const CELL = 16
function extractGridded(col0, row0, cols, rows, path) {
  const GAP = 2, SCALE = 4
  const outW = cols * (CELL * SCALE + GAP), outH = rows * (CELL * SCALE + GAP)
  const out = new PNG({ width: outW, height: outH })
  for (let i = 0; i < out.data.length; i += 4) { out.data[i] = 0x6a; out.data[i+1] = 0x84; out.data[i+2] = 0x3c; out.data[i+3] = 255 }
  for (let cr = 0; cr < rows; cr++) for (let cc = 0; cc < cols; cc++) {
    const ox = cc * (CELL * SCALE + GAP), oy = cr * (CELL * SCALE + GAP)
    for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
      const sx = (col0 + cc) * CELL + x, sy = (row0 + cr) * CELL + y
      const si = (sy * png.width + sx) * 4
      if (png.data[si + 3] < 128) continue
      for (let dy = 0; dy < SCALE; dy++) for (let dx = 0; dx < SCALE; dx++) {
        const dox = ox + x * SCALE + dx, doy = oy + y * SCALE + dy
        const di = (doy * outW + dox) * 4
        out.data[di] = png.data[si]; out.data[di+1] = png.data[si+1]; out.data[di+2] = png.data[si+2]; out.data[di+3] = 255
      }
    }
  }
  fs.writeFileSync(path, PNG.sync.write(out))
}
// Inspect cave area: cols 11-15, rows 4-7
extractGridded(11, 4, 5, 4, '/tmp/cave-region.png')
// Inspect water area: cols 10-15, rows 11-15
extractGridded(10, 11, 6, 5, '/tmp/water-region.png')
// Inspect bridge area: cols 0-4, rows 10-13
extractGridded(0, 10, 5, 4, '/tmp/bridge-region.png')
console.log('ok')
