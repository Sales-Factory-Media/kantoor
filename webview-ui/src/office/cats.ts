/**
 * Cat entities that wander the hallway.
 * Lightweight FSM: walk randomly in corridor tiles, pause occasionally.
 */

import type { SpriteData } from './types.js'
import { Direction } from './types.js'
import { TILE_SIZE } from '../constants.js'

// ── Cat sprite loading ───────────────────────────────────────

/** Cat sprites: 4 directions × 3 walk frames, extracted from cat.png */
export interface CatSprites {
  /** [direction][frame] */
  walk: SpriteData[][]
}

/** Load cat sprites from an image URL (cat.png in assets/characters/).
 *  Returns a promise that resolves to an array of CatSprites (one per color). */
export async function loadCatSprites(imageUrl: string): Promise<CatSprites[]> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = img.width
      canvas.height = img.height
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(img, 0, 0)
      const imageData = ctx.getImageData(0, 0, img.width, img.height)
      const pngData = { width: img.width, height: img.height, data: new Uint8Array(imageData.data.buffer) }
      resolve(parseCatSpriteSheet(pngData))
    }
    img.onerror = () => resolve([])
    img.src = imageUrl
  })
}

/** Parse cat.png sprite sheet (512×256, 32×32 cells).
 *
 *  4 cat colors across columns (starts at col 0, 4, 8, 12 — each color
 *  occupies 3 frame columns + 1 gap column).
 *
 *  PNG row layout (verified by eye against the asset):
 *    row 0 → side view, cat faces RIGHT  (horizontal silhouette)
 *    row 1 → back view, cat faces UP     (vertical silhouette, tail/back visible)
 *    row 2 → front view, cat faces DOWN  (vertical silhouette, face visible)
 *    row 3 → side view, cat faces LEFT   (horizontal silhouette, mirrored)
 *
 *  We remap into walk[Direction] so `walk[cat.dir]` returns the correct view
 *  regardless of the PNG's row order.
 *
 *  Returns sprites for all 4 cat colors. */
export function parseCatSpriteSheet(
  pngData: { width: number; height: number; data: Uint8Array },
): CatSprites[] {
  const CELL = 32
  const cats: CatSprites[] = []
  const catStarts = [0, 4, 8, 12] // column start for each cat color

  // Which Direction lives on each PNG row.
  // Direction enum: DOWN=0, LEFT=1, RIGHT=2, UP=3.
  const DIR_FOR_ROW: Direction[] = [
    Direction.RIGHT, // row 0
    Direction.UP,    // row 1
    Direction.DOWN,  // row 2
    Direction.LEFT,  // row 3
  ]

  for (const startCol of catStarts) {
    const walk: SpriteData[][] = [[], [], [], []] // indexed by Direction

    for (let row = 0; row < 4; row++) {
      const dir = DIR_FOR_ROW[row]
      for (let frame = 0; frame < 3; frame++) {
        const cellX = startCol + frame
        walk[dir].push(extractAndScaleCell(pngData, cellX, row, CELL))
      }
    }

    cats.push({ walk })
  }

  return cats
}

/** Extract a cell from the sprite sheet, crop to content, and scale to fit 16×16 */
function extractAndScaleCell(
  png: { width: number; height: number; data: Uint8Array },
  cellX: number, cellY: number, cellSize: number,
): SpriteData {
  // Extract cell pixels
  const raw: Array<{ r: number; g: number; b: number; a: number }[]> = []
  let minX = cellSize, minY = cellSize, maxX = 0, maxY = 0
  for (let y = 0; y < cellSize; y++) {
    const row: Array<{ r: number; g: number; b: number; a: number }> = []
    for (let x = 0; x < cellSize; x++) {
      const px = cellX * cellSize + x
      const py = cellY * cellSize + y
      const idx = (py * png.width + px) * 4
      const a = png.data[idx + 3]
      if (a > 128) {
        row.push({ r: png.data[idx], g: png.data[idx + 1], b: png.data[idx + 2], a })
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      } else {
        row.push({ r: 0, g: 0, b: 0, a: 0 })
      }
    }
    raw.push(row)
  }

  if (maxX < minX) {
    // Empty cell
    return [['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '']]
  }

  // Crop to content
  const cropW = maxX - minX + 1
  const cropH = maxY - minY + 1

  // Scale to fit within 16×16, nearest neighbor
  const TARGET = 16
  const scale = Math.min(TARGET / cropW, TARGET / cropH)
  const scaledW = Math.max(1, Math.round(cropW * scale))
  const scaledH = Math.max(1, Math.round(cropH * scale))
  const offsetX = Math.floor((TARGET - scaledW) / 2)
  const offsetY = TARGET - scaledH // bottom-align

  const sprite: SpriteData = []
  for (let dy = 0; dy < TARGET; dy++) {
    const row: string[] = []
    for (let dx = 0; dx < TARGET; dx++) {
      const sx = dx - offsetX
      const sy = dy - offsetY
      if (sx >= 0 && sx < scaledW && sy >= 0 && sy < scaledH) {
        const srcX = minX + Math.floor(sx / scale)
        const srcY = minY + Math.floor(sy / scale)
        const p = raw[srcY]?.[srcX]
        if (p && p.a > 128) {
          const hex = '#' +
            p.r.toString(16).padStart(2, '0') +
            p.g.toString(16).padStart(2, '0') +
            p.b.toString(16).padStart(2, '0')
          row.push(hex)
        } else {
          row.push('')
        }
      } else {
        row.push('')
      }
    }
    sprite.push(row)
  }
  return sprite
}

// ── Cat entity ───────────────────────────────────────────────

export interface Cat {
  id: number
  /** Pixel position */
  x: number
  y: number
  /** Current tile */
  tileCol: number
  tileRow: number
  /** Direction facing */
  dir: Direction
  /** Walk or idle */
  state: 'walk' | 'idle'
  /** Remaining path */
  path: Array<{ col: number; row: number }>
  /** 0-1 lerp between tiles */
  moveProgress: number
  /** Animation frame (0-2) */
  frame: number
  frameTimer: number
  /** Pause timer when idle */
  idleTimer: number
  /** Which cat color variant (index into CatSprites[]) */
  variant: number
  /** Cat sprite data */
  sprites: CatSprites
}

const CAT_WALK_SPEED = 32 // px/sec (slower than characters)
const CAT_FRAME_DURATION = 0.2
const CAT_IDLE_MIN = 3.0
const CAT_IDLE_MAX = 10.0

export function createCat(
  id: number,
  col: number,
  row: number,
  variant: number,
  sprites: CatSprites,
): Cat {
  return {
    id,
    x: col * TILE_SIZE + TILE_SIZE / 2,
    y: row * TILE_SIZE + TILE_SIZE / 2,
    tileCol: col,
    tileRow: row,
    dir: Direction.DOWN,
    state: 'idle',
    path: [],
    moveProgress: 0,
    frame: 0,
    frameTimer: 0,
    idleTimer: CAT_IDLE_MIN + Math.random() * (CAT_IDLE_MAX - CAT_IDLE_MIN),
    variant,
    sprites,
  }
}

/** Update cat position and animation */
export function updateCat(cat: Cat, dt: number, corridorTiles: Array<{ col: number; row: number }>): void {
  if (cat.state === 'idle') {
    cat.idleTimer -= dt
    if (cat.idleTimer <= 0) {
      // Pick a random corridor tile to walk to
      if (corridorTiles.length > 0) {
        const target = corridorTiles[Math.floor(Math.random() * corridorTiles.length)]
        // Build path by interleaving horizontal and vertical steps
        const steps: Array<{ col: number; row: number }> = []
        let c = cat.tileCol
        let r = cat.tileRow
        while (c !== target.col || r !== target.row) {
          const remainH = Math.abs(target.col - c)
          const remainV = Math.abs(target.row - r)
          // Randomly pick horizontal or vertical, weighted by remaining distance
          if (remainH > 0 && (remainV === 0 || Math.random() < remainH / (remainH + remainV))) {
            c += target.col > c ? 1 : -1
          } else if (remainV > 0) {
            r += target.row > r ? 1 : -1
          }
          steps.push({ col: c, row: r })
        }
        // Limit path length so cats don't walk forever
        cat.path = steps.slice(0, 8)
        if (cat.path.length > 0) {
          cat.state = 'walk'
          cat.moveProgress = 0
        }
      }
      cat.idleTimer = CAT_IDLE_MIN + Math.random() * (CAT_IDLE_MAX - CAT_IDLE_MIN)
    }
    return
  }

  // Walking
  if (cat.path.length === 0) {
    cat.state = 'idle'
    cat.idleTimer = CAT_IDLE_MIN + Math.random() * (CAT_IDLE_MAX - CAT_IDLE_MIN)
    return
  }

  const next = cat.path[0]
  const targetX = next.col * TILE_SIZE + TILE_SIZE / 2
  const targetY = next.row * TILE_SIZE + TILE_SIZE / 2

  // Update direction
  const dx = next.col - cat.tileCol
  const dy = next.row - cat.tileRow
  if (Math.abs(dx) > Math.abs(dy)) {
    cat.dir = dx > 0 ? Direction.RIGHT : Direction.LEFT
  } else {
    cat.dir = dy > 0 ? Direction.DOWN : Direction.UP
  }

  // Move toward target
  const speed = CAT_WALK_SPEED * dt
  const distX = targetX - cat.x
  const distY = targetY - cat.y
  const dist = Math.sqrt(distX * distX + distY * distY)

  if (dist <= speed) {
    cat.x = targetX
    cat.y = targetY
    cat.tileCol = next.col
    cat.tileRow = next.row
    cat.path.shift()
  } else {
    cat.x += (distX / dist) * speed
    cat.y += (distY / dist) * speed
  }

  // Animate walk frames
  cat.frameTimer += dt
  if (cat.frameTimer >= CAT_FRAME_DURATION) {
    cat.frameTimer -= CAT_FRAME_DURATION
    cat.frame = (cat.frame + 1) % 3
  }
}
