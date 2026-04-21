import { PNG } from 'pngjs'
import fs from 'fs'
const buf = fs.readFileSync('/Users/jasperkennis/Projects/pixel-agents/webview-ui/public/assets/outdoor/summer-forest.png')
const png = PNG.sync.read(buf)
const CELL = 16

function extractProp(sheetCol, sheetRow, w, h, path) {
  const out = new PNG({ width: w * CELL, height: h * CELL })
  // Grass green bg so we see what's transparent vs solid
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = 0x6a; out.data[i+1] = 0x84; out.data[i+2] = 0x3c; out.data[i+3] = 255
  }
  for (let y = 0; y < h * CELL; y++) {
    for (let x = 0; x < w * CELL; x++) {
      const sx = sheetCol * CELL + x, sy = sheetRow * CELL + y
      const si = (sy * png.width + sx) * 4
      if (png.data[si + 3] < 128) continue
      const di = (y * (w * CELL) + x) * 4
      out.data[di] = png.data[si]; out.data[di+1] = png.data[si+1]; out.data[di+2] = png.data[si+2]; out.data[di+3] = 255
    }
  }
  fs.writeFileSync(path, PNG.sync.write(out))
}

extractProp(4, 0, 6, 4, '/tmp/prop-cliff.png')
extractProp(11, 12, 4, 3, '/tmp/prop-pond.png')
extractProp(12, 4, 3, 3, '/tmp/prop-cave.png')
extractProp(1, 10, 3, 2, '/tmp/prop-bridge.png')
extractProp(10, 0, 5, 4, '/tmp/prop-tree.png')
extractProp(2, 8, 2, 2, '/tmp/prop-bush-big.png')
console.log('ok')
