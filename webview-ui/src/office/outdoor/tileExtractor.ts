/**
 * Extract tiles from a sprite sheet and compute edge signatures for WFC adjacency matching.
 */

import type { SpriteData } from '../types.js'

export interface OutdoorTile {
  /** Index in the tileset (row * 16 + col) */
  id: number
  /** Grid position in sprite sheet */
  sheetCol: number
  sheetRow: number
  /** Pre-rendered sprite data */
  sprite: SpriteData
  /** Average RGB of each edge (16px strip) for adjacency matching */
  topEdge: [number, number, number]
  rightEdge: [number, number, number]
  bottomEdge: [number, number, number]
  leftEdge: [number, number, number]
  /** Tile classification */
  type: 'grass' | 'dark_green' | 'cliff' | 'stone' | 'water' | 'dark' | 'unknown'
  /** Weight for WFC selection (higher = more likely) */
  weight: number
  /** Percentage of transparent pixels (0-1) */
  transparency: number
}

const CELL = 16
const SHEET_COLS = 16

/** Color distance between two RGB triplets */
export function colorDist(a: [number, number, number], b: [number, number, number]): number {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2)
}

/** Check if two edges are compatible (similar enough colors) */
export function edgesMatch(a: [number, number, number], b: [number, number, number], threshold = 35): boolean {
  return colorDist(a, b) < threshold
}

/** Extract all tiles from a sprite sheet and compute their properties */
export function extractTiles(
  png: { width: number; height: number; data: Uint8Array },
): OutdoorTile[] {
  const tiles: OutdoorTile[] = []
  const sheetRows = Math.floor(png.height / CELL)
  const sheetCols = Math.floor(png.width / CELL)

  for (let row = 0; row < sheetRows; row++) {
    for (let col = 0; col < sheetCols; col++) {
      const tile = extractSingleTile(png, col, row)
      if (tile) tiles.push(tile)
    }
  }

  return tiles
}

function extractSingleTile(
  png: { width: number; height: number; data: Uint8Array },
  col: number, row: number,
): OutdoorTile | null {
  const id = row * SHEET_COLS + col

  // Extract sprite data and count transparent pixels
  const sprite: SpriteData = []
  let transCount = 0
  let rSum = 0, gSum = 0, bSum = 0, opaqueCount = 0

  for (let y = 0; y < CELL; y++) {
    const spriteRow: string[] = []
    for (let x = 0; x < CELL; x++) {
      const px = col * CELL + x
      const py = row * CELL + y
      const idx = (py * png.width + px) * 4
      if (png.data[idx + 3] >= 128) {
        const r = png.data[idx], g = png.data[idx + 1], b = png.data[idx + 2]
        spriteRow.push('#' + r.toString(16).padStart(2, '0') + g.toString(16).padStart(2, '0') + b.toString(16).padStart(2, '0'))
        rSum += r; gSum += g; bSum += b; opaqueCount++
      } else {
        spriteRow.push('')
        transCount++
      }
    }
    sprite.push(spriteRow)
  }

  // Skip mostly-empty tiles
  const transparency = transCount / (CELL * CELL)
  if (transparency > 0.8) return null

  // Compute edge signatures
  const topEdge = computeEdge(png, col, row, 'top')
  const bottomEdge = computeEdge(png, col, row, 'bottom')
  const leftEdge = computeEdge(png, col, row, 'left')
  const rightEdge = computeEdge(png, col, row, 'right')

  // Classify tile type
  const avg = opaqueCount > 0
    ? [Math.round(rSum / opaqueCount), Math.round(gSum / opaqueCount), Math.round(bSum / opaqueCount)] as [number, number, number]
    : [0, 0, 0] as [number, number, number]

  const type = classifyTile(avg)

  // Weight: grass tiles are most common in nature
  const weight = type === 'grass' ? 10
    : type === 'dark_green' ? 6
    : type === 'stone' ? 2
    : type === 'cliff' ? 1
    : type === 'water' ? 1
    : type === 'dark' ? 0.5
    : 1

  return { id, sheetCol: col, sheetRow: row, sprite, topEdge, rightEdge, bottomEdge, leftEdge, type, weight, transparency }
}

function computeEdge(
  png: { width: number; height: number; data: Uint8Array },
  col: number, row: number, side: 'top' | 'right' | 'bottom' | 'left',
): [number, number, number] {
  let rSum = 0, gSum = 0, bSum = 0, n = 0

  for (let i = 0; i < CELL; i++) {
    let px: number, py: number
    switch (side) {
      case 'top': px = col * CELL + i; py = row * CELL; break
      case 'bottom': px = col * CELL + i; py = row * CELL + CELL - 1; break
      case 'left': px = col * CELL; py = row * CELL + i; break
      case 'right': px = col * CELL + CELL - 1; py = row * CELL + i; break
    }
    const idx = (py * png.width + px) * 4
    if (png.data[idx + 3] >= 128) {
      rSum += png.data[idx]; gSum += png.data[idx + 1]; bSum += png.data[idx + 2]; n++
    }
  }

  return n > 0
    ? [Math.round(rSum / n), Math.round(gSum / n), Math.round(bSum / n)]
    : [0, 0, 0]
}

function classifyTile(avg: [number, number, number]): OutdoorTile['type'] {
  const [r, g, b] = avg
  if (g > r * 1.1 && g > b * 1.3 && g > 100) return 'grass'
  if (g > r * 1.1 && g > b * 1.3 && g > 60) return 'dark_green'
  if (r > 100 && g > 80 && b < 80) return 'cliff'
  if (b > r && b > g) return 'water'
  if (r < 50 && g < 50 && b < 80) return 'dark'
  if (r > 100 && g > 100 && b > 80 && Math.abs(r - g) < 30) return 'stone'
  return 'unknown'
}

/** Build adjacency rules: for each tile, which tiles can be on each side */
export function buildAdjacencyRules(
  tiles: OutdoorTile[],
  threshold = 35,
): Map<number, { top: Set<number>; right: Set<number>; bottom: Set<number>; left: Set<number> }> {
  const rules = new Map<number, { top: Set<number>; right: Set<number>; bottom: Set<number>; left: Set<number> }>()

  for (const tile of tiles) {
    rules.set(tile.id, { top: new Set(), right: new Set(), bottom: new Set(), left: new Set() })
  }

  for (const a of tiles) {
    for (const b of tiles) {
      // a's right edge matches b's left edge → b can be to the right of a
      if (edgesMatch(a.rightEdge, b.leftEdge, threshold)) {
        rules.get(a.id)!.right.add(b.id)
        rules.get(b.id)!.left.add(a.id)
      }
      // a's bottom edge matches b's top edge → b can be below a
      if (edgesMatch(a.bottomEdge, b.topEdge, threshold)) {
        rules.get(a.id)!.bottom.add(b.id)
        rules.get(b.id)!.top.add(a.id)
      }
    }
  }

  return rules
}
