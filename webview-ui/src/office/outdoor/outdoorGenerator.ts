/**
 * Generate the outdoor area around the office.
 *
 * Approach: use the hand-drawn multi-tile groups from the sheet (tree, cliff
 * plateau, water pond, cave, bridge) as composed props that are scattered with
 * spacing. Grass underneath is a uniform random pick from two real grass tiles,
 * with sparse flower/detail overlays for variation.
 *
 * Tile positions below were chosen by inspecting summer-forest.png — see
 * scripts/inspect-sheet.mjs for the classifier that helped identify them.
 */

import type { SpriteData } from '../types.js'

export interface OutdoorState {
  /** Base grass tile grid (row-major, index into grassSprites) */
  groundGrid: Uint8Array
  /** Available grass tile sprites */
  grassSprites: SpriteData[]
  /** Placed outdoor objects (props, detail tiles) on top of grass */
  objects: OutdoorObject[]
  /** All object sprites by type key */
  objectSprites: Map<string, SpriteData>
  /** Grid dimensions */
  width: number
  height: number
  /** Offset: where the outdoor grid starts relative to the office grid */
  offsetCol: number
  offsetRow: number
  /**
   * Pre-rendered outdoor layer at 1:1 pixel-to-sheet ratio (width × height tiles).
   * The entire outdoor is static once generated, so the renderer blits this
   * single canvas each frame instead of iterating ~2500+ grass/prop tiles.
   * Scales crisply at any integer zoom when imageSmoothingEnabled=false.
   */
  bakedCanvas: HTMLCanvasElement | null
}

interface OutdoorObject {
  type: string
  /** Top-left in outdoor grid coords */
  col: number
  row: number
  widthTiles: number
  heightTiles: number
}

const OUTDOOR_MARGIN = 30
const CELL = 16

/** Plain-grass tiles with subtle variation. Used as random base layer. */
const GRASS_BASE_TILES: Array<[number, number]> = [
  [0, 4],
  [0, 5],
]

interface ObjectDef {
  type: string
  /** Top-left tile in sprite sheet */
  sheetCol: number
  sheetRow: number
  widthTiles: number
  heightTiles: number
  /** Relative frequency when filling the outdoor area */
  weight: number
  /** Minimum bounding-box gap (in tiles) between centers of props */
  minSpacing: number
  maxCount: number
  /** Visual category — controls placement order (larger/rarer first) */
  tier: 'landmark' | 'prop' | 'detail'
}

const OBJECT_DEFS: ObjectDef[] = [
  // ── Landmarks (rare, large, scenic) ──────────────────────────
  // Tree — 5×4 at col 11 (cols 11-15). Top row is partially transparent due to rounded crown.
  { type: 'tree', sheetCol: 11, sheetRow: 0, widthTiles: 5, heightTiles: 4, weight: 6, minSpacing: 5, maxCount: 22, tier: 'landmark' },
  // Cliff plateau — cols 5-10, rows 0-3. The stone border wraps a transparent
  // cross-shaped hole in the middle — when stamped on grass, the grass shows
  // through, creating a natural "plateau surrounded by stone edges" look.
  { type: 'cliff-plateau', sheetCol: 5, sheetRow: 0, widthTiles: 6, heightTiles: 4, weight: 2, minSpacing: 8, maxCount: 4, tier: 'landmark' },
  // Water pond — 4×2 pure-water block (cols 11-14, rows 13-14). Edges are
  // hard rectangles since the sheet doesn't give us free shoreline tiles in
  // a composable layout; the visual intent is "small pool of water".
  { type: 'water-pond', sheetCol: 11, sheetRow: 13, widthTiles: 4, heightTiles: 2, weight: 2, minSpacing: 6, maxCount: 4, tier: 'landmark' },
  // Stone bridge — 4×2 arched bridge (cols 1-4, rows 10-11)
  { type: 'bridge', sheetCol: 1, sheetRow: 10, widthTiles: 4, heightTiles: 2, weight: 1, minSpacing: 6, maxCount: 2, tier: 'landmark' },

  // ── Props (medium, frequent) ─────────────────────────────────
  // Bushes — 1×1 each. Several variants.
  { type: 'bush-a', sheetCol: 0, sheetRow: 8, widthTiles: 1, heightTiles: 1, weight: 3, minSpacing: 3, maxCount: 35, tier: 'prop' },
  { type: 'bush-b', sheetCol: 1, sheetRow: 8, widthTiles: 1, heightTiles: 1, weight: 3, minSpacing: 3, maxCount: 35, tier: 'prop' },
  // Large bush — 2×2
  { type: 'bush-big', sheetCol: 2, sheetRow: 8, widthTiles: 2, heightTiles: 2, weight: 2, minSpacing: 4, maxCount: 15, tier: 'prop' },
  // Rock — 1×1
  { type: 'rock', sheetCol: 3, sheetRow: 7, widthTiles: 1, heightTiles: 1, weight: 2, minSpacing: 3, maxCount: 20, tier: 'prop' },

  // ── Details (small, common, purely decorative) ───────────────
  // Flower & grass detail tiles — placed as 1-tile overlays
  { type: 'flowers-a', sheetCol: 0, sheetRow: 6, widthTiles: 1, heightTiles: 1, weight: 2, minSpacing: 2, maxCount: 80, tier: 'detail' },
  { type: 'flowers-b', sheetCol: 1, sheetRow: 6, widthTiles: 1, heightTiles: 1, weight: 2, minSpacing: 2, maxCount: 60, tier: 'detail' },
  { type: 'flowers-c', sheetCol: 2, sheetRow: 6, widthTiles: 1, heightTiles: 1, weight: 2, minSpacing: 2, maxCount: 60, tier: 'detail' },
]

// ── Seeded RNG ───────────────────────────────────────────────

function createRng(seed: number): () => number {
  let s = seed | 0
  return () => {
    s = (s + 0x6D2B79F5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ── Sprite extraction ────────────────────────────────────────

function extractSprite(
  png: { width: number; height: number; data: Uint8Array },
  sheetCol: number, sheetRow: number, widthTiles: number, heightTiles: number,
): SpriteData {
  const w = widthTiles * CELL
  const h = heightTiles * CELL
  const sprite: SpriteData = []

  for (let y = 0; y < h; y++) {
    const row: string[] = []
    for (let x = 0; x < w; x++) {
      const px = sheetCol * CELL + x
      const py = sheetRow * CELL + y
      const idx = (py * png.width + px) * 4
      if (png.data[idx + 3] >= 128) {
        row.push('#' +
          png.data[idx].toString(16).padStart(2, '0') +
          png.data[idx + 1].toString(16).padStart(2, '0') +
          png.data[idx + 2].toString(16).padStart(2, '0'))
      } else {
        row.push('')
      }
    }
    sprite.push(row)
  }
  return sprite
}

// ── Generation ───────────────────────────────────────────────

export function generateOutdoor(
  officeCols: number,
  officeRows: number,
  pngData: { width: number; height: number; data: Uint8Array },
): OutdoorState {
  const width = officeCols + OUTDOOR_MARGIN * 2
  const height = officeRows + OUTDOOR_MARGIN * 2
  const rng = createRng(42) // fixed seed for stable outdoor across reloads

  // Extract grass base sprites
  const grassSprites: SpriteData[] = GRASS_BASE_TILES.map(([c, r]) =>
    extractSprite(pngData, c, r, 1, 1)
  )

  // Extract object sprites
  const objectSprites = new Map<string, SpriteData>()
  for (const def of OBJECT_DEFS) {
    objectSprites.set(def.type, extractSprite(pngData, def.sheetCol, def.sheetRow, def.widthTiles, def.heightTiles))
  }

  // Base grass: random variant per cell
  const groundGrid = new Uint8Array(width * height)
  for (let i = 0; i < groundGrid.length; i++) {
    groundGrid[i] = Math.floor(rng() * grassSprites.length)
  }

  // Reserve the office footprint + 2-tile buffer — no props placed on/near it
  const occupiedCells = new Set<string>()
  for (let r = -2; r < officeRows + 2; r++) {
    for (let c = -2; c < officeCols + 2; c++) {
      occupiedCells.add(`${c + OUTDOOR_MARGIN},${r + OUTDOOR_MARGIN}`)
    }
  }

  // Place objects tier by tier: landmarks first (they claim prime real estate),
  // then props, then details. Within the landmark tier, sort by *rarity* (low
  // maxCount first) so scarce features like caves and bridges get room before
  // trees fill the map. Within props/details, sort by area so large items
  // don't get fragmented out by small ones.
  const objects: OutdoorObject[] = []
  const tierOrder: Array<ObjectDef['tier']> = ['landmark', 'prop', 'detail']

  for (const tier of tierOrder) {
    const defs = OBJECT_DEFS
      .filter((d) => d.tier === tier)
      .sort((a, b) => {
        if (tier === 'landmark') return a.maxCount - b.maxCount
        return (b.widthTiles * b.heightTiles) - (a.widthTiles * a.heightTiles)
      })

    for (const def of defs) {
      let count = 0
      // Rare landmarks deserve many more tries — there are only a handful of them
      const maxAttempts = tier === 'landmark' ? def.maxCount * 40 : def.maxCount * 6

      for (let attempt = 0; attempt < maxAttempts && count < def.maxCount; attempt++) {
        const col = Math.floor(rng() * (width - def.widthTiles))
        const row = Math.floor(rng() * (height - def.heightTiles))

        // Tile overlap check: every cell this prop would cover must be free
        let canPlace = true
        for (let dr = 0; dr < def.heightTiles && canPlace; dr++) {
          for (let dc = 0; dc < def.widthTiles && canPlace; dc++) {
            if (occupiedCells.has(`${col + dc},${row + dr}`)) canPlace = false
          }
        }
        if (!canPlace) continue

        // Spacing check against existing objects (bounding-box gap)
        const tooClose = objects.some((obj) => {
          const dx = Math.abs((col + def.widthTiles / 2) - (obj.col + obj.widthTiles / 2))
          const dy = Math.abs((row + def.heightTiles / 2) - (obj.row + obj.heightTiles / 2))
          const requiredX = def.minSpacing + (obj.widthTiles + def.widthTiles) / 2
          const requiredY = def.minSpacing + (obj.heightTiles + def.heightTiles) / 2
          return dx < requiredX && dy < requiredY
        })
        if (tooClose) continue

        objects.push({ type: def.type, col, row, widthTiles: def.widthTiles, heightTiles: def.heightTiles })

        for (let dr = 0; dr < def.heightTiles; dr++) {
          for (let dc = 0; dc < def.widthTiles; dc++) {
            occupiedCells.add(`${col + dc},${row + dr}`)
          }
        }
        count++
      }
    }
  }

  return {
    groundGrid,
    grassSprites,
    objects,
    objectSprites,
    width,
    height,
    offsetCol: -OUTDOOR_MARGIN,
    offsetRow: -OUTDOOR_MARGIN,
    bakedCanvas: null,
  }
}

/**
 * Render every grass cell + every prop into a single offscreen canvas at 1:1
 * sheet-pixel scale. The renderer can then blit this one canvas each frame
 * instead of drawing thousands of tile sprites individually.
 */
export function bakeOutdoorCanvas(outdoor: OutdoorState): HTMLCanvasElement {
  const { groundGrid, grassSprites, objects, objectSprites, width, height } = outdoor
  const canvas = document.createElement('canvas')
  canvas.width = width * CELL
  canvas.height = height * CELL
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingEnabled = false

  // Draw grass base
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const sprite = grassSprites[groundGrid[r * width + c]]
      if (!sprite) continue
      drawSpriteDataTo(ctx, sprite, c * CELL, r * CELL)
    }
  }

  // Draw props on top
  for (const obj of objects) {
    const sprite = objectSprites.get(obj.type)
    if (!sprite) continue
    drawSpriteDataTo(ctx, sprite, obj.col * CELL, obj.row * CELL)
  }

  return canvas
}

/** Rasterize SpriteData (2D color-string array) to ctx at pixel (dx, dy). */
function drawSpriteDataTo(
  ctx: CanvasRenderingContext2D,
  sprite: SpriteData,
  dx: number,
  dy: number,
): void {
  const rows = sprite.length
  const cols = sprite[0].length
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const color = sprite[y][x]
      if (color === '') continue
      ctx.fillStyle = color
      ctx.fillRect(dx + x, dy + y, 1, 1)
    }
  }
}

/** Load the tileset image and generate outdoor state */
export async function loadAndGenerateOutdoor(
  imageUrl: string,
  officeCols: number,
  officeRows: number,
): Promise<OutdoorState | null> {
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
      const state = generateOutdoor(officeCols, officeRows, pngData)
      state.bakedCanvas = bakeOutdoorCanvas(state)
      resolve(state)
    }
    img.onerror = () => resolve(null)
    img.src = imageUrl
  })
}
