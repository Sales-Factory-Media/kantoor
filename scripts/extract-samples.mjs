import { PNG } from 'pngjs'
import fs from 'fs'

const buf = fs.readFileSync('/Users/jasperkennis/Projects/pixel-agents/webview-ui/public/assets/outdoor/summer-forest.png')
const png = PNG.sync.read(buf)
const CELL = 16

function extractTile(col, row, outPath) {
  const out = new PNG({ width: CELL, height: CELL })
  for (let y = 0; y < CELL; y++) {
    for (let x = 0; x < CELL; x++) {
      const sx = col * CELL + x
      const sy = row * CELL + y
      const si = (sy * png.width + sx) * 4
      const di = (y * CELL + x) * 4
      out.data[di] = png.data[si]
      out.data[di + 1] = png.data[si + 1]
      out.data[di + 2] = png.data[si + 2]
      out.data[di + 3] = png.data[si + 3]
    }
  }
  fs.writeFileSync(outPath, PNG.sync.write(out))
}

// Check candidate grass tiles
for (const [c, r] of [[0,8],[1,8],[2,8],[3,8],[0,9],[1,9],[2,9],[3,9],[12,4],[13,4],[14,4]]) {
  extractTile(c, r, `/tmp/tile_${c}_${r}.png`)
}
console.log('extracted')
