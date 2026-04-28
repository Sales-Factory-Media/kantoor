import { TileType, TILE_SIZE, CharacterState } from '../types.js'
import type { TileType as TileTypeVal, FurnitureInstance, Character, Seat, FloorColor } from '../types.js'
import type { Cat } from '../cats.js'
import type { OutdoorState } from '../outdoor/outdoorGenerator.js'
import type { RoomInfo } from '../layout/roomGenerator.js'
import { getCachedSprite, getOutlineSprite } from '../sprites/spriteCache.js'
import { getCharacterSprites, BUBBLE_PERMISSION_SPRITE, BUBBLE_WAITING_SPRITE } from '../sprites/spriteData.js'
import { getCharacterSprite } from './characters.js'
import { renderMatrixEffect } from './matrixEffect.js'
import { getColorizedFloorSprite, getColorizedHerringboneSprite, hasFloorSprites, usesGeneratedFloor, WALL_COLOR } from '../floorTiles.js'
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

/** A tile is "non-floor" for border detection if it's wall, window, void, or out-of-grid. */
function isNonFloor(tileMap: TileTypeVal[][], r: number, c: number, rows: number, cols: number): boolean {
  if (r < 0 || c < 0 || r >= rows || c >= cols) return true
  const t = tileMap[r][c]
  return t === TileType.WALL || t === TileType.WINDOW || t === TileType.VOID
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
  const s = TILE_SIZE * zoom
  const useSpriteFloors = hasFloorSprites()
  const useHerringbone = usesGeneratedFloor()
  const tmRows = tileMap.length
  const tmCols = tmRows > 0 ? tileMap[0].length : 0
  const layoutCols = cols ?? tmCols

  // Viewport culling: only iterate tiles whose bounding box overlaps the canvas.
  // Without this, a 64×64 grid (4096 tiles) is touched every frame even when
  // most tiles sit far off-screen — a large CPU cost on every rAF tick.
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

  // Floor tiles + wall base color
  for (let r = firstRow; r < lastRow; r++) {
    for (let c = firstCol; c < lastCol; c++) {
      const tile = tileMap[r][c]

      // Skip VOID and WINDOW tiles entirely (transparent at the tile pass —
      // WINDOW renders its own sprite later via getWallInstances, on top of
      // the outdoor layer which has already been drawn).
      if (tile === TileType.VOID || tile === TileType.WINDOW) continue

      if (tile === TileType.WALL || !useSpriteFloors) {
        // Wall tiles or fallback: solid color
        if (tile === TileType.WALL) {
          const colorIdx = r * layoutCols + c
          const wallColor = tileColors?.[colorIdx]
          ctx.fillStyle = wallColor ? wallColorToHex(wallColor) : WALL_COLOR
        } else {
          ctx.fillStyle = FALLBACK_FLOOR_COLOR
        }
        ctx.fillRect(offsetX + c * s, offsetY + r * s, s, s)
        continue
      }

      // Floor tile: get colorized sprite
      const colorIdx = r * layoutCols + c
      const color = tileColors?.[colorIdx] ?? { h: 0, s: 0, b: 0, c: 0 }

      let sprite
      if (useHerringbone) {
        // Procedural herringbone: compute adjacency bitmask so tiles adjacent
        // to walls/void get a straight-plank border along that edge.
        let mask = 0
        if (isNonFloor(tileMap, r - 1, c, tmRows, tmCols)) mask |= 1  // N
        if (isNonFloor(tileMap, r, c + 1, tmRows, tmCols)) mask |= 2  // E
        if (isNonFloor(tileMap, r + 1, c, tmRows, tmCols)) mask |= 4  // S
        if (isNonFloor(tileMap, r, c - 1, tmRows, tmCols)) mask |= 8  // W
        sprite = getColorizedHerringboneSprite(r, c, mask, color)
      } else {
        sprite = getColorizedFloorSprite(tile, color)
      }
      const cached = getCachedSprite(sprite, zoom)
      ctx.drawImage(cached, offsetX + c * s, offsetY + r * s)
    }
  }

}

interface ZDrawable {
  zY: number
  draw: (ctx: CanvasRenderingContext2D) => void
}

export function renderScene(
  ctx: CanvasRenderingContext2D,
  furniture: FurnitureInstance[],
  characters: Character[],
  offsetX: number,
  offsetY: number,
  zoom: number,
  selectedAgentId: number | null,
  hoveredAgentId: number | null,
  cats?: Cat[],
): void {
  const drawables: ZDrawable[] = []

  // Furniture
  for (const f of furniture) {
    const cached = getCachedSprite(f.sprite, zoom)
    const fx = offsetX + f.x * zoom
    const fy = offsetY + f.y * zoom
    drawables.push({
      zY: f.zY,
      draw: (c) => {
        c.drawImage(cached, fx, fy)
      },
    })
  }

  // Characters
  for (const ch of characters) {
    const sprites = getCharacterSprites(ch.palette, ch.hueShift)
    const spriteData = getCharacterSprite(ch, sprites)
    const cached = getCachedSprite(spriteData, zoom)
    // Sitting offset: shift character down when seated (not at activity spots)
    const sittingOffset = ch.state === CharacterState.TYPE && !ch.atActivitySpot ? CHARACTER_SITTING_OFFSET_PX : 0
    // Anchor at bottom-center of character — round to integer device pixels
    const drawX = Math.round(offsetX + ch.x * zoom - cached.width / 2)
    const drawY = Math.round(offsetY + (ch.y + sittingOffset) * zoom - cached.height)

    // Sort characters by bottom of their tile (not center) so they render
    // in front of same-row furniture (e.g. chairs) but behind furniture
    // at lower rows (e.g. desks, bookshelves that occlude from below).
    const charZY = ch.y + TILE_SIZE / 2 + CHARACTER_Z_SORT_OFFSET

    // Matrix spawn/despawn effect — skip outline, use per-pixel rendering
    if (ch.matrixEffect) {
      const mDrawX = drawX
      const mDrawY = drawY
      const mSpriteData = spriteData
      const mCh = ch
      drawables.push({
        zY: charZY,
        draw: (c) => {
          renderMatrixEffect(c, mCh, mSpriteData, mDrawX, mDrawY, zoom)
        },
      })
      continue
    }

    // White outline: full opacity for selected, 50% for hover
    const isSelected = selectedAgentId !== null && ch.id === selectedAgentId
    const isHovered = hoveredAgentId !== null && ch.id === hoveredAgentId
    if (isSelected || isHovered) {
      const outlineAlpha = isSelected ? SELECTED_OUTLINE_ALPHA : HOVERED_OUTLINE_ALPHA
      const outlineData = getOutlineSprite(spriteData)
      const outlineCached = getCachedSprite(outlineData, zoom)
      const olDrawX = drawX - zoom  // 1 sprite-pixel offset, scaled
      const olDrawY = drawY - zoom  // outline follows sitting offset via drawY
      drawables.push({
        zY: charZY - OUTLINE_Z_SORT_OFFSET, // sort just before character
        draw: (c) => {
          c.save()
          c.globalAlpha = outlineAlpha
          c.drawImage(outlineCached, olDrawX, olDrawY)
          c.restore()
        },
      })
    }

    drawables.push({
      zY: charZY,
      draw: (c) => {
        c.drawImage(cached, drawX, drawY)
      },
    })
  }

  // Cats
  if (cats) {
    for (const cat of cats) {
      const dirIdx = cat.dir as number // DOWN=0, LEFT=1, RIGHT=2, UP=3
      const frameIdx = cat.state === 'walk' ? cat.frame % 3 : 1 // idle uses middle frame
      const spriteData = cat.sprites.walk[dirIdx]?.[frameIdx]
      if (!spriteData) continue

      // Flip left sprites from right sprites if needed (LEFT=1 uses same data)
      const cached = getCachedSprite(spriteData, zoom)
      const drawX = Math.round(offsetX + cat.x * zoom - cached.width / 2)
      const drawY = Math.round(offsetY + cat.y * zoom - cached.height)
      const catZY = cat.y + TILE_SIZE / 2

      drawables.push({
        zY: catZY,
        draw: (c) => {
          c.drawImage(cached, drawX, drawY)
        },
      })
    }
  }

  // Sort by Y (lower = in front = drawn later)
  drawables.sort((a, b) => a.zY - b.zY)

  for (const d of drawables) {
    d.draw(ctx)
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

  // Build wall instances for z-sorting with furniture and characters
  const wallInstances = hasWallSprites()
    ? getWallInstances(tileMap, tileColors, layoutCols)
    : []
  const allFurniture = wallInstances.length > 0
    ? [...wallInstances, ...furniture]
    : furniture

  // Draw walls + furniture + characters (z-sorted)
  const selectedId = selection?.selectedAgentId ?? null
  const hoveredId = selection?.hoveredAgentId ?? null
  renderScene(ctx, allFurniture, characters, offsetX, offsetY, zoom, selectedId, hoveredId, cats)

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
