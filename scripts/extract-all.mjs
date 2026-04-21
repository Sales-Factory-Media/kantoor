import { PNG } from 'pngjs'
import fs from 'fs'

const buf = fs.readFileSync('/Users/jasperkennis/Projects/pixel-agents/webview-ui/public/assets/outdoor/summer-forest.png')
const png = PNG.sync.read(buf)
const CELL = 16

// Build a big grid showing all 256 tiles with label overlaid
const SHEET_COLS = 16, SHEET_ROWS = 16
const SCALE = 4  // each tile 64px
const GAP = 2

const outW = SHEET_COLS * (CELL * SCALE + GAP)
const outH = SHEET_ROWS * (CELL * SCALE + GAP)
const out = new PNG({ width: outW, height: outH })

// Background dark
for (let i = 0; i < out.data.length; i += 4) {
  out.data[i] = 20; out.data[i+1] = 20; out.data[i+2] = 30; out.data[i+3] = 255
}

for (let row = 0; row < SHEET_ROWS; row++) {
  for (let col = 0; col < SHEET_COLS; col++) {
    const outX = col * (CELL * SCALE + GAP)
    const outY = row * (CELL * SCALE + GAP)
    for (let y = 0; y < CELL; y++) {
      for (let x = 0; x < CELL; x++) {
        const sx = col * CELL + x, sy = row * CELL + y
        const si = (sy * png.width + sx) * 4
        if (png.data[si + 3] < 128) continue
        for (let dy = 0; dy < SCALE; dy++) {
          for (let dx = 0; dx < SCALE; dx++) {
            const dox = outX + x * SCALE + dx
            const doy = outY + y * SCALE + dy
            const di = (doy * outW + dox) * 4
            out.data[di] = png.data[si]
            out.data[di+1] = png.data[si+1]
            out.data[di+2] = png.data[si+2]
            out.data[di+3] = 255
          }
        }
      }
    }
  }
}

fs.writeFileSync('/tmp/sheet-gridded.png', PNG.sync.write(out))
console.log(`${outW}x${outH}`)
