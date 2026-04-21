import { PNG } from 'pngjs'
import fs from 'fs'
const buf = fs.readFileSync('/Users/jasperkennis/Projects/pixel-agents/webview-ui/public/assets/outdoor/summer-forest.png')
const png = PNG.sync.read(buf)
const CELL = 16
function extract(col, row, path) {
  const out = new PNG({ width: CELL, height: CELL })
  for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
    const si = ((row * CELL + y) * png.width + (col * CELL + x)) * 4
    const di = (y * CELL + x) * 4
    out.data[di] = png.data[si]; out.data[di+1] = png.data[si+1]; out.data[di+2] = png.data[si+2]; out.data[di+3] = png.data[si+3]
  }
  fs.writeFileSync(path, PNG.sync.write(out))
}
for (const [c, r] of [[0,4],[1,4],[2,4],[0,5],[1,5],[2,5],[3,5],[0,6],[1,6],[2,6],[3,7]]) extract(c, r, `/tmp/m_${c}_${r}.png`)
