/**
 * Procedural herringbone (hongaars visgraat) floor sprites.
 *
 * Generates a variant sprite set so the renderer can tile real herringbone
 * zigzag — two base variants (A / B) selected by (r + c) % 2, each with
 * 16 adjacency sub-variants for the wall border (N=1, E=2, S=4, W=8).
 *
 * Total: 32 precomputed 16×16 grayscale sprites. Per-tile color is applied
 * downstream via the shared Colorize module.
 *
 * Pattern design
 * --------------
 * True Hungarian-point visgraat has planks cut at 45° so adjacent planks
 * meet at a perfectly perpendicular V. At 16×16 we approximate this with
 * diagonal stripe planks: variant A has bands running NW→SE (\\), variant
 * B has bands running NE→SW (/). When laid out in a (r+c) checker, the
 * direction flips at every tile boundary — exactly where the zigzag
 * "V-point" of the pattern sits — so the final effect reads as herringbone
 * rather than parquet squares.
 */

import type { SpriteData } from './types.js'
import { TILE_SIZE } from '../constants.js'

// Grayscale palette. Only *relative* values matter — the shared Colorize
// module remaps luminance onto whatever wood hue the user painted. Deltas
// from PLANK_FILL are kept small so the pattern reads as subtle wood grain
// rather than high-contrast stripes.
const PLANK_FILL = '#8a8a8a'
const PLANK_GRAIN = '#828282'   // was #7a (−16), now −8 → half the contrast
const PLANK_SEAM = '#636363'    // was #3c (−78), now −39
const BORDER_FILL = '#929292'   // was #9a (+16), now +8
const BORDER_GRAIN = '#878787'  // was #85 (−5), now −3

const NORTH = 1
const EAST = 2
const SOUTH = 4
const WEST = 8

const PLANK_WIDTH = 4   // perpendicular thickness of each diagonal plank
const PLANK_LENGTH = 10 // length of a plank segment (along the diagonal)
const SEG_GAP = 1       // end-seam thickness between plank segments

function blankSprite(color: string): SpriteData {
  return Array.from({ length: TILE_SIZE }, () =>
    Array<string>(TILE_SIZE).fill(color),
  )
}

function drawRect(sprite: SpriteData, x: number, y: number, w: number, h: number, color: string): void {
  for (let dy = 0; dy < h; dy++) {
    const row = y + dy
    if (row < 0 || row >= TILE_SIZE) continue
    for (let dx = 0; dx < w; dx++) {
      const col = x + dx
      if (col < 0 || col >= TILE_SIZE) continue
      sprite[row][col] = color
    }
  }
}

/**
 * Paint a diagonal herringbone field over the whole tile.
 *
 * @param direction "\\" = NW→SE planks (variant A), "/" = NE→SW (variant B)
 */
function paintHerringboneField(sprite: SpriteData, direction: '\\' | '/'): void {
  // u = cross-plank axis (constant along a plank)
  // v = along-plank axis (changes along a plank)
  // Offsets keep the values positive so the modulo math behaves at the edges.
  const period = PLANK_WIDTH * 2   // two planks wide = full cross period
  const segPeriod = PLANK_LENGTH + SEG_GAP

  for (let y = 0; y < TILE_SIZE; y++) {
    for (let x = 0; x < TILE_SIZE; x++) {
      const u = direction === '\\' ? (x - y + 64) : (x + y)
      const v = direction === '\\' ? (x + y) : (x - y + 64)

      const crossIdx = u % period            // 0..7, two planks per period
      const insidePlank = crossIdx % PLANK_WIDTH  // 0..3 within current plank
      const alongIdx = v % segPeriod

      const onSideSeam = insidePlank === 0 || insidePlank === PLANK_WIDTH - 1
      const onEndSeam = alongIdx < SEG_GAP
      const onGrain = insidePlank === Math.floor(PLANK_WIDTH / 2)

      if (onSideSeam || onEndSeam) {
        sprite[y][x] = PLANK_SEAM
      } else if (onGrain) {
        sprite[y][x] = PLANK_GRAIN
      } else {
        sprite[y][x] = PLANK_FILL
      }
    }
  }
}

/**
 * Draw one straight border plank along one edge (on top of the herringbone
 * field). Border planks use a slightly lighter fill so the frame stands apart.
 */
function paintBorderEdge(sprite: SpriteData, side: number): void {
  const depth = 4
  const grainOffset = Math.floor(depth / 2)

  if (side === NORTH) {
    drawRect(sprite, 0, 0, TILE_SIZE, depth, BORDER_FILL)
    drawRect(sprite, 0, 0, TILE_SIZE, 1, PLANK_SEAM)            // top edge
    drawRect(sprite, 0, depth - 1, TILE_SIZE, 1, PLANK_SEAM)    // inner edge
    drawRect(sprite, 1, grainOffset, TILE_SIZE - 2, 1, BORDER_GRAIN) // grain
  } else if (side === SOUTH) {
    drawRect(sprite, 0, TILE_SIZE - depth, TILE_SIZE, depth, BORDER_FILL)
    drawRect(sprite, 0, TILE_SIZE - depth, TILE_SIZE, 1, PLANK_SEAM)
    drawRect(sprite, 0, TILE_SIZE - 1, TILE_SIZE, 1, PLANK_SEAM)
    drawRect(sprite, 1, TILE_SIZE - depth + grainOffset, TILE_SIZE - 2, 1, BORDER_GRAIN)
  } else if (side === EAST) {
    drawRect(sprite, TILE_SIZE - depth, 0, depth, TILE_SIZE, BORDER_FILL)
    drawRect(sprite, TILE_SIZE - depth, 0, 1, TILE_SIZE, PLANK_SEAM)
    drawRect(sprite, TILE_SIZE - 1, 0, 1, TILE_SIZE, PLANK_SEAM)
    drawRect(sprite, TILE_SIZE - depth + grainOffset, 1, 1, TILE_SIZE - 2, BORDER_GRAIN)
  } else if (side === WEST) {
    drawRect(sprite, 0, 0, depth, TILE_SIZE, BORDER_FILL)
    drawRect(sprite, 0, 0, 1, TILE_SIZE, PLANK_SEAM)
    drawRect(sprite, depth - 1, 0, 1, TILE_SIZE, PLANK_SEAM)
    drawRect(sprite, grainOffset, 1, 1, TILE_SIZE - 2, BORDER_GRAIN)
  }
}

function buildSprite(bitmask: number, direction: '\\' | '/'): SpriteData {
  const sprite = blankSprite(PLANK_FILL)
  paintHerringboneField(sprite, direction)
  // Border passes go last so they overpaint the herringbone along wall edges.
  // Order: N, W, S, E — later passes overpaint earlier ones at the corners
  // (which is fine since both are straight planks).
  if (bitmask & NORTH) paintBorderEdge(sprite, NORTH)
  if (bitmask & WEST) paintBorderEdge(sprite, WEST)
  if (bitmask & SOUTH) paintBorderEdge(sprite, SOUTH)
  if (bitmask & EAST) paintBorderEdge(sprite, EAST)
  return sprite
}

// Precompute 16 bitmask variants × 2 directions = 32 sprites. ~8 KB total.
const SPRITES_A: SpriteData[] = Array.from({ length: 16 }, (_, i) => buildSprite(i, '\\'))
const SPRITES_B: SpriteData[] = Array.from({ length: 16 }, (_, i) => buildSprite(i, '/'))

/**
 * Return the herringbone sprite for a given tile.
 * @param row grid row of the tile (for A/B checker alternation)
 * @param col grid col of the tile
 * @param bitmask wall/void adjacency (N=1, E=2, S=4, W=8, 0 = interior)
 */
export function getHerringboneSprite(row: number, col: number, bitmask: number): SpriteData {
  const mask = bitmask & 0b1111
  const variant = ((row + col) & 1) === 0 ? SPRITES_A : SPRITES_B
  return variant[mask]
}
