/**
 * Floor-to-ceiling window tile — a wall variant that renders as a
 * semi-transparent window sprite instead of an auto-tiled wall piece.
 *
 * The sprite is the same dimensions as a wall auto-tile piece (16×32) so it
 * drops straight into getWallInstances with the same offsetY. The glass
 * pixels are painted with alpha < 255 so the outdoor render pass (which
 * runs before walls) shows through: you can see the grass/trees outside.
 *
 * No PNG asset — generated procedurally so we don't need a new loader.
 */

import type { SpriteData } from './types.js'

const WIDTH = 16
const HEIGHT = 32

// Opaque wood frame tones (rgba hex). Frame sits on the outside — fully opaque.
const FRAME_DARK = '#3c2c1ecc'
const FRAME_LIGHT = '#62482f80'
const SILL = '#2a1e12'
const MULLION = '#342619cc'

// Glass pixels — short RGBA hex with alpha ~60-120 so you can see through.
// Two tones to suggest a subtle blue tint on the glass without obscuring what's
// behind it.
const GLASS_CLEAR = '#b8dfed4d'   // alpha 0x4d (~77, ~30%)
const GLASS_TINT = '#95cfe266'    // alpha 0x66 (~40%)
const GLASS_HI = '#ecf5f8a0'      // highlight streak (~63% opacity)

// 7-char hex like '#rrggbb' or 9-char '#rrggbbaa'. Blank string = transparent.
function blank(): SpriteData {
  return Array.from({ length: HEIGHT }, () => Array<string>(WIDTH).fill(''))
}

function setPx(sprite: SpriteData, x: number, y: number, color: string): void {
  if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) return
  sprite[y][x] = color
}

function fillRect(sprite: SpriteData, x: number, y: number, w: number, h: number, color: string): void {
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      setPx(sprite, x + dx, y + dy, color)
    }
  }
}

function buildSprite(): SpriteData {
  const sprite = blank()

  // Glass area occupies the middle — inset 2px on sides/top, 3px for sill.
  const insetX = 2
  const insetTop = 2
  const insetBot = 3
  const glassTop = insetTop
  const glassBot = HEIGHT - insetBot - 1
  const glassLeft = insetX
  const glassRight = WIDTH - insetX - 1

  // 1. Paint the glass with a subtle vertical tint gradient (clear up top,
  //    slightly tinted lower — like daylight reflecting differently).
  for (let y = glassTop; y <= glassBot; y++) {
    const lower = y > glassTop + Math.floor((glassBot - glassTop) * 0.6)
    const color = lower ? GLASS_TINT : GLASS_CLEAR
    for (let x = glassLeft; x <= glassRight; x++) {
      setPx(sprite, x, y, color)
    }
  }

  // 2. Glass highlight: a diagonal streak in the upper-left pane.
  setPx(sprite, glassLeft + 1, glassTop + 1, GLASS_HI)
  setPx(sprite, glassLeft + 2, glassTop + 2, GLASS_HI)
  setPx(sprite, glassLeft + 2, glassTop + 3, GLASS_HI)

  // 3. Wooden frame — top, sides, sill.
  fillRect(sprite, 0, 0, WIDTH, insetTop, FRAME_DARK)            // top bar
  fillRect(sprite, 0, 0, insetX, HEIGHT, FRAME_DARK)             // left bar
  fillRect(sprite, WIDTH - insetX, 0, insetX, HEIGHT, FRAME_DARK) // right bar
  // Inner highlight on top + left gives a subtle bevel effect.
  for (let x = 1; x < WIDTH - 1; x++) setPx(sprite, x, 1, FRAME_LIGHT)
  for (let y = 1; y < HEIGHT - insetBot; y++) setPx(sprite, 1, y, FRAME_LIGHT)

  // 4. Dark sill at the bottom (a bit beefier, anchors the window on the floor).
  fillRect(sprite, 0, HEIGHT - insetBot, WIDTH, insetBot, SILL)
  // Top edge of the sill gets a frame-dark line for definition.
  for (let x = 0; x < WIDTH; x++) setPx(sprite, x, HEIGHT - insetBot, FRAME_DARK)

  // 5. Mullions (glass dividers). One horizontal at ~middle of the glass,
  //    one vertical centered. These partially break up the glass, which
  //    looks more believable at this resolution.
  const midY = Math.floor((glassTop + glassBot) / 2)
  for (let x = glassLeft; x <= glassRight; x++) setPx(sprite, x, midY, MULLION)
  const midX = Math.floor(WIDTH / 2) - 1
  for (let y = glassTop; y <= glassBot; y++) setPx(sprite, midX, y, MULLION)

  return sprite
}

let cached: SpriteData | null = null

/** Returns the window sprite (16×32). Built once, cached. */
export function getWindowSprite(): SpriteData {
  if (!cached) cached = buildSprite()
  return cached
}
