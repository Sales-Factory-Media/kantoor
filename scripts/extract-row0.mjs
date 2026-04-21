import { PNG } from 'pngjs'
import fs from 'fs'
const buf = fs.readFileSync('/Users/jasperkennis/Projects/pixel-agents/webview-ui/public/assets/outdoor/summer-forest.png')
const png = PNG.sync.read(buf)
for (const col of [3, 4, 5, 9, 10, 11]) {
  const out = new PNG({ width: 16, height: 16 })
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const si = ((0 + y) * png.width + (col * 16 + x)) * 4
    const di = (y * 16 + x) * 4
    out.data[di] = png.data[si]; out.data[di+1] = png.data[si+1]; out.data[di+2] = png.data[si+2]; out.data[di+3] = png.data[si+3]
  }
  fs.writeFileSync(`/tmp/r0_${col}.png`, PNG.sync.write(out))
}
console.log('ok')
