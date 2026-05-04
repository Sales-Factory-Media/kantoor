/**
 * SpriteData → PIXI.Texture conversion + caching.
 *
 * The existing pipeline produces sprites as `string[][]` (hex color per pixel,
 * '' = transparent). We convert each one to a backing canvas the first time
 * it's seen, then wrap it in a Pixi texture with nearest-neighbor sampling so
 * pixel art stays crisp at any scale.
 */
import { Texture } from 'pixi.js'
import type { SpriteData } from '../types.js'

const textureCache = new WeakMap<SpriteData, Texture>()

/** Dispose the texture associated with a SpriteData (e.g., on hot-reload). */
export function disposeTexture(sprite: SpriteData): void {
  const t = textureCache.get(sprite)
  if (!t) return
  t.destroy(true)
  textureCache.delete(sprite)
}

export function spriteDataToTexture(sprite: SpriteData): Texture {
  const cached = textureCache.get(sprite)
  if (cached) return cached

  const rows = sprite.length
  const cols = rows > 0 ? sprite[0].length : 0
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, cols)
  canvas.height = Math.max(1, rows)
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    return Texture.EMPTY
  }
  ctx.imageSmoothingEnabled = false

  for (let r = 0; r < rows; r++) {
    const row = sprite[r]
    for (let c = 0; c < cols; c++) {
      const color = row[c]
      if (!color) continue
      ctx.fillStyle = color
      ctx.fillRect(c, r, 1, 1)
    }
  }

  const texture = Texture.from(canvas)
  // Pixel-art friendly: no smoothing when scaled.
  texture.source.scaleMode = 'nearest'
  textureCache.set(sprite, texture)
  return texture
}

/**
 * Wrap an existing HTMLCanvasElement (e.g. the static floor bake) directly
 * as a Pixi texture. Use sparingly — these textures are not cached and the
 * caller is responsible for `texture.destroy(true)` when replacing the
 * underlying canvas.
 */
export function canvasToTexture(canvas: HTMLCanvasElement): Texture {
  const texture = Texture.from(canvas)
  texture.source.scaleMode = 'nearest'
  return texture
}
