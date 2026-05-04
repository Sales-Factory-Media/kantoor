import { TileType, TILE_SIZE, CharacterState } from '../types.js'
import type { TileType as TileTypeVal, FurnitureInstance, Character, Seat, FloorColor } from '../types.js'
import type { Cat } from '../cats.js'
import type { OutdoorState } from '../outdoor/outdoorGenerator.js'
import type { RoomInfo } from '../layout/roomGenerator.js'
import { getCachedSprite, getOutlineSprite } from '../sprites/spriteCache.js'
import { getCharacterSprites, BUBBLE_PERMISSION_SPRITE, BUBBLE_WAITING_SPRITE } from '../sprites/spriteData.js'
import { getCharacterSprite } from './characters.js'
import { renderMatrixEffect } from './matrixEffect.js'
import { getAllFloorSprites, getColorizedFloorSprite, getColorizedHerringboneSprite, hasFloorSprites, usesGeneratedFloor, WALL_COLOR } from '../floorTiles.js'
import { hasWallSprites, getWallInstances, wallColorToHex } from '../wallTiles.js'
import {
  CHARACTER_SITTING_OFFSET_PX,
  CHARACTER_Z_SORT_OFFSET,
  OUTLINE_Z_SORT_OFFSET,
  SELECTED_OUTLINE_ALPHA,
  HOVERED_OUTLINE_ALPHA,
  BUBBLE_FADE_DURATION_SEC,
  BUBBLE_SITTING_OFFSET_PX,
  BUBBLE_VERTICAL_OFFSET_PX,
  FALLBACK_FLOOR_COLOR,
  SEAT_OWN_COLOR,
  SEAT_AVAILABLE_COLOR,
  SEAT_BUSY_COLOR,
  ROOM_LABEL_FONT_SIZE_PX,
  ROOM_LABEL_COLOR,
  ROOM_LABEL_SHADOW_COLOR,
  NAME_VERTICAL_OFFSET_PX,
  NAME_FONT_SIZE_PX,
  NAME_COLOR,
  NAME_SHADOW_COLOR,
} from '../../constants.js'

// ── Render functions ────────────────────────────────────────────

/** Sentinel empty array reused when wall sprites aren't loaded — avoids
 *  allocating `[]` on every frame in the hot path. */
const EMPTY_INSTANCES: FurnitureInstance[] = []

/** A tile is "non-floor" for border detection if it's wall, window, void, or out-of-grid. */
function isNonFloor(tileMap: TileTypeVal[][], r: number, c: number, rows: number, cols: number): boolean {
  if (r < 0 || c < 0 || r >= rows || c >= cols) return true
  const t = tileMap[r][c]
  return t === TileType.WALL || t === TileType.WINDOW || t === TileType.VOID
}

/**
 * Bake of the static floor + wall-base layer.
 *
 * The tile grid is otherwise the heaviest single category per frame: every
 * visible tile pays a cache-key string allocation, two map lookups, and a
 * `drawImage`. We pre-render the entire grid into one offscreen canvas and
 * swap the per-frame loop for a single `drawImage`. Reference equality on
 * `tileMap` / `tileColors` (both are replaced on layout change in
 * `OfficeState.rebuildFromLayout`) is enough to invalidate; `floorSpritesRef`
 * also flips when floors.png finishes loading.
 *
 * Falls back to per-tile rendering when the baked canvas would exceed the
 * browser's max canvas size.
 */
const MAX_BAKED_DIM_PX = 8192
let cachedFloorBake: {
  canvas: HTMLCanvasElement
  tileMapRef: TileTypeVal[][]
  tileColorsRef: Array<FloorColor | null> | undefined
  zoom: number
  cols: number
  rows: number
  spritesRef: ReturnType<typeof getAllFloorSprites>
} | null = null

function drawTileToContext(
  ctx: CanvasRenderingContext2D,
  tileMap: TileTypeVal[][],
  r: number,
  c: number,
  layoutCols: number,
  tmRows: number,
  tmCols: number,
  tileColors: Array<FloorColor | null> | undefined,
  zoom: number,
  destX: number,
  destY: number,
  useSpriteFloors: boolean,
  useHerringbone: boolean,
  s: number,
): void {
  const tile = tileMap[r][c]
  if (tile === TileType.VOID || tile === TileType.WINDOW) return

  if (tile === TileType.WALL || !useSpriteFloors) {
    if (tile === TileType.WALL) {
      const colorIdx = r * layoutCols + c
      const wallColor = tileColors?.[colorIdx]
      ctx.fillStyle = wallColor ? wallColorToHex(wallColor) : WALL_COLOR
    } else {
      ctx.fillStyle = FALLBACK_FLOOR_COLOR
    }
    ctx.fillRect(destX, destY, s, s)
    return
  }

  const colorIdx = r * layoutCols + c
  const color = tileColors?.[colorIdx] ?? { h: 0, s: 0, b: 0, c: 0 }

  let sprite
  if (useHerringbone) {
    let mask = 0
    if (isNonFloor(tileMap, r - 1, c, tmRows, tmCols)) mask |= 1
    if (isNonFloor(tileMap, r, c + 1, tmRows, tmCols)) mask |= 2
    if (isNonFloor(tileMap, r + 1, c, tmRows, tmCols)) mask |= 4
    if (isNonFloor(tileMap, r, c - 1, tmRows, tmCols)) mask |= 8
    sprite = getColorizedHerringboneSprite(r, c, mask, color)
  } else {
    sprite = getColorizedFloorSprite(tile, color)
  }
  const cached = getCachedSprite(sprite, zoom)
  ctx.drawImage(cached, destX, destY)
}

function getBakedFloor(
  tileMap: TileTypeVal[][],
  tileColors: Array<FloorColor | null> | undefined,
  layoutCols: number,
  layoutRows: number,
  zoom: number,
): HTMLCanvasElement | null {
  const w = layoutCols * TILE_SIZE * zoom
  const h = layoutRows * TILE_SIZE * zoom
  if (w <= 0 || h <= 0) return null
  if (w > MAX_BAKED_DIM_PX || h > MAX_BAKED_DIM_PX) return null

  const sprites = getAllFloorSprites()
  if (
    cachedFloorBake !== null &&
    cachedFloorBake.tileMapRef === tileMap &&
    cachedFloorBake.tileColorsRef === tileColors &&
    cachedFloorBake.zoom === zoom &&
    cachedFloorBake.cols === layoutCols &&
    cachedFloorBake.rows === layoutRows &&
    cachedFloorBake.spritesRef === sprites
  ) {
    return cachedFloorBake.canvas
  }

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const bakeCtx = canvas.getContext('2d')
  if (!bakeCtx) return null
  bakeCtx.imageSmoothingEnabled = false

  const tmRows = tileMap.length
  const tmCols = tmRows > 0 ? tileMap[0].length : 0
  const useSpriteFloors = hasFloorSprites()
  const useHerringbone = usesGeneratedFloor()
  const s = TILE_SIZE * zoom

  for (let r = 0; r < tmRows; r++) {
    for (let c = 0; c < tmCols; c++) {
      drawTileToContext(
        bakeCtx, tileMap, r, c, layoutCols, tmRows, tmCols, tileColors, zoom,
        c * s, r * s, useSpriteFloors, useHerringbone, s,
      )
    }
  }

  cachedFloorBake = {
    canvas,
    tileMapRef: tileMap,
    tileColorsRef: tileColors,
    zoom,
    cols: layoutCols,
    rows: layoutRows,
    spritesRef: sprites,
  }
  return canvas
}

export function renderTileGrid(
  ctx: CanvasRenderingContext2D,
  tileMap: TileTypeVal[][],
  offsetX: number,
  offsetY: number,
  zoom: number,
  tileColors?: Array<FloorColor | null>,
  cols?: number,
  canvasWidth?: number,
  canvasHeight?: number,
): void {
  const tmRows = tileMap.length
  const tmCols = tmRows > 0 ? tileMap[0].length : 0
  const layoutCols = cols ?? tmCols
  const layoutRows = tmRows

  // Fast path: blit the cached bake of the whole tile grid.
  const baked = getBakedFloor(tileMap, tileColors, layoutCols, layoutRows, zoom)
  if (baked) {
    ctx.drawImage(baked, offsetX, offsetY)
    return
  }

  // Fallback (very large grids): per-tile rendering with viewport culling.
  const s = TILE_SIZE * zoom
  const useSpriteFloors = hasFloorSprites()
  const useHerringbone = usesGeneratedFloor()

  let firstRow = 0
  let lastRow = tmRows
  let firstCol = 0
  let lastCol = tmCols
  if (canvasWidth !== undefined && canvasHeight !== undefined && s > 0) {
    firstCol = Math.max(0, Math.floor(-offsetX / s))
    lastCol = Math.min(tmCols, Math.ceil((canvasWidth - offsetX) / s))
    firstRow = Math.max(0, Math.floor(-offsetY / s))
    lastRow = Math.min(tmRows, Math.ceil((canvasHeight - offsetY) / s))
  }

  for (let r = firstRow; r < lastRow; r++) {
    for (let c = firstCol; c < lastCol; c++) {
      drawTileToContext(
        ctx, tileMap, r, c, layoutCols, tmRows, tmCols, tileColors, zoom,
        offsetX + c * s, offsetY + r * s, useSpriteFloors, useHerringbone, s,
      )
    }
  }
}

/**
 * Z-sorted draw entry. Stored in a module-level pool so renderScene allocates
 * zero closures and zero entry objects per frame — only the references in
 * `activeDrawables` grow with the working set, which is amortized O(1).
 */
type SpriteData = ReturnType<typeof getCharacterSprite>

const DRAW_IMAGE = 0
const DRAW_IMAGE_ALPHA = 1
const DRAW_MATRIX = 2

interface Drawable {
  zY: number
  kind: 0 | 1 | 2
  cached: HTMLCanvasElement | null
  drawX: number
  drawY: number
  alpha: number
  ch: Character | null
  spriteData: SpriteData | null
}

const drawablePool: Drawable[] = []
const activeDrawables: Drawable[] = []
let poolCursor = 0

function acquireDrawable(): Drawable {
  let item = drawablePool[poolCursor]
  if (!item) {
    item = {
      zY: 0,
      kind: DRAW_IMAGE,
      cached: null,
      drawX: 0,
      drawY: 0,
      alpha: 1,
      ch: null,
      spriteData: null,
    }
    drawablePool[poolCursor] = item
  }
  poolCursor++
  activeDrawables.push(item)
  return item
}

function compareDrawables(a: Drawable, b: Drawable): number {
  return a.zY - b.zY
}

export function renderScene(
  ctx: CanvasRenderingContext2D,
  walls: FurnitureInstance[],
  furniture: FurnitureInstance[],
  characters: Character[],
  offsetX: number,
  offsetY: number,
  zoom: number,
  selectedAgentId: number | null,
  hoveredAgentId: number | null,
  cats?: Cat[],
): void {
  // Reset frame state — references are released, but pool entries are reused
  // so the next acquireDrawable() finds an existing struct to overwrite.
  activeDrawables.length = 0
  poolCursor = 0

  // Walls + furniture share the same draw shape. Iterate them in two passes
  // instead of concatenating into a fresh array each frame.
  for (let i = 0; i < walls.length; i++) {
    const f = walls[i]
    const cached = getCachedSprite(f.sprite, zoom)
    const d = acquireDrawable()
    d.zY = f.zY
    d.kind = DRAW_IMAGE
    d.cached = cached
    d.drawX = offsetX + f.x * zoom
    d.drawY = offsetY + f.y * zoom
    d.alpha = 1
  }
  for (let i = 0; i < furniture.length; i++) {
    const f = furniture[i]
    const cached = getCachedSprite(f.sprite, zoom)
    const d = acquireDrawable()
    d.zY = f.zY
    d.kind = DRAW_IMAGE
    d.cached = cached
    d.drawX = offsetX + f.x * zoom
    d.drawY = offsetY + f.y * zoom
    d.alpha = 1
  }

  // Characters
  for (let i = 0; i < characters.length; i++) {
    const ch = characters[i]
    const sprites = getCharacterSprites(ch.palette, ch.hueShift)
    const spriteData = getCharacterSprite(ch, sprites)
    const cached = getCachedSprite(spriteData, zoom)
    const sittingOffset = ch.state === CharacterState.TYPE && !ch.atActivitySpot ? CHARACTER_SITTING_OFFSET_PX : 0
    const drawX = Math.round(offsetX + ch.x * zoom - cached.width / 2)
    const drawY = Math.round(offsetY + (ch.y + sittingOffset) * zoom - cached.height)
    const charZY = ch.y + TILE_SIZE / 2 + CHARACTER_Z_SORT_OFFSET

    if (ch.matrixEffect) {
      const d = acquireDrawable()
      d.zY = charZY
      d.kind = DRAW_MATRIX
      d.cached = null
      d.drawX = drawX
      d.drawY = drawY
      d.alpha = 1
      d.ch = ch
      d.spriteData = spriteData
      continue
    }

    const isSelected = selectedAgentId !== null && ch.id === selectedAgentId
    const isHovered = hoveredAgentId !== null && ch.id === hoveredAgentId
    if (isSelected || isHovered) {
      const outlineData = getOutlineSprite(spriteData)
      const outlineCached = getCachedSprite(outlineData, zoom)
      const d = acquireDrawable()
      d.zY = charZY - OUTLINE_Z_SORT_OFFSET
      d.kind = DRAW_IMAGE_ALPHA
      d.cached = outlineCached
      d.drawX = drawX - zoom
      d.drawY = drawY - zoom
      d.alpha = isSelected ? SELECTED_OUTLINE_ALPHA : HOVERED_OUTLINE_ALPHA
    }

    const d = acquireDrawable()
    d.zY = charZY
    d.kind = DRAW_IMAGE
    d.cached = cached
    d.drawX = drawX
    d.drawY = drawY
    d.alpha = 1
  }

  // Cats
  if (cats) {
    for (let i = 0; i < cats.length; i++) {
      const cat = cats[i]
      const dirIdx = cat.dir as number
      const frameIdx = cat.state === 'walk' ? cat.frame % 3 : 1
      const spriteData = cat.sprites.walk[dirIdx]?.[frameIdx]
      if (!spriteData) continue

      const cached = getCachedSprite(spriteData, zoom)
      const d = acquireDrawable()
      d.zY = cat.y + TILE_SIZE / 2
      d.kind = DRAW_IMAGE
      d.cached = cached
      d.drawX = Math.round(offsetX + cat.x * zoom - cached.width / 2)
      d.drawY = Math.round(offsetY + cat.y * zoom - cached.height)
      d.alpha = 1
    }
  }

  activeDrawables.sort(compareDrawables)

  for (let i = 0; i < activeDrawables.length; i++) {
    const d = activeDrawables[i]
    if (d.kind === DRAW_IMAGE) {
      if (d.cached) ctx.drawImage(d.cached, d.drawX, d.drawY)
    } else if (d.kind === DRAW_IMAGE_ALPHA) {
      if (d.cached) {
        ctx.globalAlpha = d.alpha
        ctx.drawImage(d.cached, d.drawX, d.drawY)
        ctx.globalAlpha = 1
      }
    } else {
      // DRAW_MATRIX
      if (d.ch && d.spriteData) {
        renderMatrixEffect(ctx, d.ch, d.spriteData, d.drawX, d.drawY, zoom)
      }
    }
  }
}

// ── Seat indicators ─────────────────────────────────────────────

export function renderSeatIndicators(
  ctx: CanvasRenderingContext2D,
  seats: Map<string, Seat>,
  characters: Map<number, Character>,
  selectedAgentId: number | null,
  hoveredTile: { col: number; row: number } | null,
  offsetX: number,
  offsetY: number,
  zoom: number,
): void {
  if (selectedAgentId === null || !hoveredTile) return
  const selectedChar = characters.get(selectedAgentId)
  if (!selectedChar) return

  // Only show indicator for the hovered seat tile
  for (const [uid, seat] of seats) {
    if (seat.seatCol !== hoveredTile.col || seat.seatRow !== hoveredTile.row) continue

    const s = TILE_SIZE * zoom
    const x = offsetX + seat.seatCol * s
    const y = offsetY + seat.seatRow * s

    if (selectedChar.seatId === uid) {
      // Selected agent's own seat — blue
      ctx.fillStyle = SEAT_OWN_COLOR
    } else if (!seat.assigned) {
      // Available seat — green
      ctx.fillStyle = SEAT_AVAILABLE_COLOR
    } else {
      // Busy (assigned to another agent) — red
      ctx.fillStyle = SEAT_BUSY_COLOR
    }
    ctx.fillRect(x, y, s, s)
    break
  }
}

// ── Speech bubbles ──────────────────────────────────────────────

export function renderBubbles(
  ctx: CanvasRenderingContext2D,
  characters: Character[],
  offsetX: number,
  offsetY: number,
  zoom: number,
): void {
  for (const ch of characters) {
    if (!ch.bubbleType) continue

    const sprite = ch.bubbleType === 'permission'
      ? BUBBLE_PERMISSION_SPRITE
      : BUBBLE_WAITING_SPRITE

    // Compute opacity: permission = full, waiting = fade in last 0.5s
    let alpha = 1.0
    if (ch.bubbleType === 'waiting' && ch.bubbleTimer < BUBBLE_FADE_DURATION_SEC) {
      alpha = ch.bubbleTimer / BUBBLE_FADE_DURATION_SEC
    }

    const cached = getCachedSprite(sprite, zoom)
    // Position: centered above the character's head
    // Character is anchored bottom-center at (ch.x, ch.y), sprite is 16x24
    // Place bubble above head with a small gap; follow sitting offset
    const sittingOff = ch.state === CharacterState.TYPE && !ch.atActivitySpot ? BUBBLE_SITTING_OFFSET_PX : 0
    const bubbleX = Math.round(offsetX + ch.x * zoom - cached.width / 2)
    const bubbleY = Math.round(offsetY + (ch.y + sittingOff - BUBBLE_VERTICAL_OFFSET_PX) * zoom - cached.height - 1 * zoom)

    ctx.save()
    if (alpha < 1.0) ctx.globalAlpha = alpha
    ctx.drawImage(cached, bubbleX, bubbleY)
    ctx.restore()
  }
}

// ── Character names ──────────────────────────────────────────────

export function renderNames(
  ctx: CanvasRenderingContext2D,
  characters: Character[],
  offsetX: number,
  offsetY: number,
  zoom: number,
): void {
  const fontSize = NAME_FONT_SIZE_PX * zoom
  ctx.save()
  ctx.font = `${fontSize}px "Open Sans", sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'bottom'

  for (const ch of characters) {
    if (!ch.name) continue
    // Skip characters during despawn
    if (ch.matrixEffect === 'despawn') continue

    const sittingOff = ch.state === CharacterState.TYPE && !ch.atActivitySpot ? BUBBLE_SITTING_OFFSET_PX : 0
    const nameX = Math.round(offsetX + ch.x * zoom)
    const nameY = Math.round(offsetY + (ch.y + sittingOff - NAME_VERTICAL_OFFSET_PX) * zoom)

    // Shadow for readability
    ctx.fillStyle = NAME_SHADOW_COLOR
    ctx.fillText(ch.name, nameX + zoom, nameY + zoom)
    // Name text
    ctx.fillStyle = NAME_COLOR
    ctx.fillText(ch.name, nameX, nameY)
  }
  ctx.restore()
}

// ── Project labels ───────────────────────────────────────────────

export function renderProjectLabels(
  ctx: CanvasRenderingContext2D,
  rooms: RoomInfo[],
  offsetX: number,
  offsetY: number,
  zoom: number,
): void {
  if (rooms.length === 0) return
  ctx.save()
  const fontSize = ROOM_LABEL_FONT_SIZE_PX * zoom
  ctx.font = `${fontSize}px "Open Sans", sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'bottom'

  for (const room of rooms) {
    // Skip labels for filler rooms (Kitchen, Server Room, etc.)
    if (room.isFiller) continue

    const centerX = offsetX + (room.col + room.width / 2) * TILE_SIZE * zoom
    // Position above the wall's 3D face (walls extend TILE_SIZE above their tile)
    const labelY = offsetY + (room.row - 1) * TILE_SIZE * zoom - 2 * zoom

    // Shadow for contrast
    ctx.fillStyle = ROOM_LABEL_SHADOW_COLOR
    ctx.fillText(room.projectName, centerX + zoom, labelY + zoom)

    ctx.fillStyle = ROOM_LABEL_COLOR
    ctx.fillText(room.projectName, centerX, labelY)
  }
  ctx.restore()
}

export interface SelectionRenderState {
  selectedAgentId: number | null
  hoveredAgentId: number | null
  hoveredTile: { col: number; row: number } | null
  seats: Map<string, Seat>
  characters: Map<number, Character>
}

export function renderFrame(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number,
  tileMap: TileTypeVal[][],
  furniture: FurnitureInstance[],
  characters: Character[],
  zoom: number,
  panX: number,
  panY: number,
  selection?: SelectionRenderState,
  tileColors?: Array<FloorColor | null>,
  layoutCols?: number,
  layoutRows?: number,
  rooms?: RoomInfo[],
  cats?: Cat[],
  outdoor?: OutdoorState | null,
): { offsetX: number; offsetY: number } {
  // Clear
  ctx.clearRect(0, 0, canvasWidth, canvasHeight)

  // Use layout dimensions (fallback to tileMap size)
  const cols = layoutCols ?? (tileMap.length > 0 ? tileMap[0].length : 0)
  const rows = layoutRows ?? tileMap.length

  // Center map in viewport + pan offset (integer device pixels)
  const mapW = cols * TILE_SIZE * zoom
  const mapH = rows * TILE_SIZE * zoom
  const offsetX = Math.floor((canvasWidth - mapW) / 2) + Math.round(panX)
  const offsetY = Math.floor((canvasHeight - mapH) / 2) + Math.round(panY)

  // Draw outdoor nature tiles behind the office
  if (outdoor) {
    renderOutdoorTiles(ctx, outdoor, offsetX, offsetY, zoom, canvasWidth, canvasHeight)
  }

  // Draw tiles (floor + wall base color)
  renderTileGrid(ctx, tileMap, offsetX, offsetY, zoom, tileColors, layoutCols, canvasWidth, canvasHeight)

  // Seat indicators (below furniture/characters, on top of floor)
  if (selection) {
    renderSeatIndicators(ctx, selection.seats, selection.characters, selection.selectedAgentId, selection.hoveredTile, offsetX, offsetY, zoom)
  }

  // Build wall instances for z-sorting with furniture and characters.
  // getWallInstances caches by tile-map / tile-colors / sprite-set identity,
  // so this is effectively free unless the layout actually changed.
  const wallInstances = hasWallSprites()
    ? getWallInstances(tileMap, tileColors, layoutCols)
    : EMPTY_INSTANCES

  // Draw walls + furniture + characters (z-sorted)
  const selectedId = selection?.selectedAgentId ?? null
  const hoveredId = selection?.hoveredAgentId ?? null
  renderScene(ctx, wallInstances, furniture, characters, offsetX, offsetY, zoom, selectedId, hoveredId, cats)

  // Project labels above rooms (after scene so walls don't cover them)
  if (rooms) {
    renderProjectLabels(ctx, rooms, offsetX, offsetY, zoom)
  }

  // Speech bubbles (always on top of characters)
  renderBubbles(ctx, characters, offsetX, offsetY, zoom)

  // Character names (always visible, above bubbles)
  renderNames(ctx, characters, offsetX, offsetY, zoom)

  return { offsetX, offsetY }
}

// ── Outdoor rendering ─────────────────────────────────────────

function renderOutdoorTiles(
  ctx: CanvasRenderingContext2D,
  outdoor: OutdoorState,
  officeOffsetX: number,
  officeOffsetY: number,
  zoom: number,
  canvasWidth: number,
  canvasHeight: number,
): void {
  const { bakedCanvas, width, height, offsetCol, offsetRow } = outdoor
  if (!bakedCanvas) return

  // Compute the destination rect in canvas space.
  const baseX = officeOffsetX + offsetCol * TILE_SIZE * zoom
  const baseY = officeOffsetY + offsetRow * TILE_SIZE * zoom
  const dwFull = width * TILE_SIZE * zoom
  const dhFull = height * TILE_SIZE * zoom

  // Clip destination to visible canvas.
  const dxClipped = Math.max(0, baseX)
  const dyClipped = Math.max(0, baseY)
  const dxEnd = Math.min(canvasWidth, baseX + dwFull)
  const dyEnd = Math.min(canvasHeight, baseY + dhFull)
  if (dxEnd <= dxClipped || dyEnd <= dyClipped) return

  // Map clipped destination back into source-canvas coordinates so the GPU
  // only scales the visible portion. Without this, drawImage hands the
  // browser a destination rect many times the canvas size at high zoom and
  // the implementation has to reason about all of it before clipping.
  const baseSrcW = bakedCanvas.width
  const baseSrcH = bakedCanvas.height
  const srcX = (dxClipped - baseX) * baseSrcW / dwFull
  const srcY = (dyClipped - baseY) * baseSrcH / dhFull
  const srcW = (dxEnd - dxClipped) * baseSrcW / dwFull
  const srcH = (dyEnd - dyClipped) * baseSrcH / dhFull

  ctx.drawImage(
    bakedCanvas,
    srcX, srcY, srcW, srcH,
    Math.round(dxClipped), Math.round(dyClipped),
    Math.round(dxEnd) - Math.round(dxClipped),
    Math.round(dyEnd) - Math.round(dyClipped),
  )
}
