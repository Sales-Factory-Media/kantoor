/**
 * Core placement helpers for the WFC room decorator:
 * overlap checking, slot finders, entrance detection, path reachability (BFS).
 */

import type { RoomBounds, DecorationModule, PlacedCell } from './wfcTypes.js'

// ── Interior Bounds ──────────────────────────────────────────

/** Get interior bounds (excluding walls) */
export function getInterior(bounds: RoomBounds): { minCol: number; maxCol: number; minRow: number; maxRow: number } {
  return {
    minCol: bounds.roomCol + 1,
    maxCol: bounds.roomCol + bounds.roomWidth - 2,
    minRow: bounds.roomRow + 1,
    maxRow: bounds.roomRow + bounds.roomHeight - 2,
  }
}

// ── Overlap Detection ────────────────────────────────────────

/** Check if a footprint overlaps any already-placed cells */
export function overlapsPlaced(col: number, row: number, width: number, height: number, bgTiles: number, placed: PlacedCell[]): boolean {
  for (const p of placed) {
    const effectiveRow = row + bgTiles
    const effectiveHeight = height - bgTiles
    const pEffectiveRow = p.row + p.backgroundTiles
    const pEffectiveHeight = p.height - p.backgroundTiles

    if (col < p.col + p.width && col + width > p.col &&
        effectiveRow < pEffectiveRow + pEffectiveHeight && effectiveRow + effectiveHeight > pEffectiveRow) {
      return true
    }
  }
  return false
}

// ── Slot Finders ─────────────────────────────────────────────

/** Find valid wall positions (along the top wall, placed at roomRow - 1) */
export function getWallSlots(bounds: RoomBounds): Array<{ col: number; row: number }> {
  const slots: Array<{ col: number; row: number }> = []
  const wallRow = bounds.roomRow - 1
  const interior = getInterior(bounds)

  for (let c = interior.minCol; c <= interior.maxCol; c++) {
    slots.push({ col: c, row: wallRow })
  }
  return slots
}

/** Find valid corner positions (interior corners of the room) */
export function getCornerSlots(bounds: RoomBounds): Array<{ col: number; row: number }> {
  const interior = getInterior(bounds)
  return [
    { col: interior.minCol, row: interior.minRow },
    { col: interior.maxCol, row: interior.minRow },
    { col: interior.minCol, row: interior.maxRow },
    { col: interior.maxCol, row: interior.maxRow },
  ]
}

/** Find valid edge positions (along walls but not corners) */
export function getEdgeSlots(bounds: RoomBounds): Array<{ col: number; row: number }> {
  const interior = getInterior(bounds)
  const slots: Array<{ col: number; row: number }> = []

  for (let c = interior.minCol + 1; c < interior.maxCol; c++) {
    slots.push({ col: c, row: interior.minRow })
    slots.push({ col: c, row: interior.maxRow })
  }
  for (let r = interior.minRow + 1; r < interior.maxRow; r++) {
    slots.push({ col: interior.minCol, row: r })
    slots.push({ col: interior.maxCol, row: r })
  }
  return slots
}

// ── Entrance Detection ───────────────────────────────────────

/** Check if a position is within the entrance zone */
export function isNearEntrance(col: number, row: number, width: number, height: number, bounds: RoomBounds): boolean {
  const doorCol = bounds.roomCol + Math.floor(bounds.roomWidth / 2)
  if (bounds.doorSide === 'bottom') {
    const doorRow = bounds.roomRow + bounds.roomHeight - 2
    if (col <= doorCol && col + width > doorCol && row + height > doorRow - 1) return true
  } else {
    const doorRow = bounds.roomRow + 1
    if (col <= doorCol && col + width > doorCol && row < doorRow + 2) return true
  }
  return false
}

// ── Module Placement Check ───────────────────────────────────

/** Check if a module can be placed at a given position */
export function canPlaceModule(
  mod: DecorationModule,
  col: number,
  row: number,
  bounds: RoomBounds,
  placed: PlacedCell[],
): boolean {
  const interior = getInterior(bounds)

  if (isNearEntrance(col, row, mod.width, mod.height, bounds)) return false

  if (mod.canPlaceOnWalls) {
    if (col < interior.minCol || col + mod.width - 1 > interior.maxCol) return false
    return !overlapsPlaced(col, row, mod.width, mod.height, mod.backgroundTiles, placed)
  }

  const effectiveHeight = mod.height - mod.backgroundTiles
  const effectiveRow = row + mod.backgroundTiles
  if (col < interior.minCol || col + mod.width - 1 > interior.maxCol) return false
  if (effectiveRow < interior.minRow || effectiveRow + effectiveHeight - 1 > interior.maxRow) return false

  return !overlapsPlaced(col, row, mod.width, mod.height, mod.backgroundTiles, placed)
}

// ── Reachability Check (BFS) ─────────────────────────────────

/** Build a set of blocked tiles from placed cells */
function buildBlockedSet(placed: PlacedCell[]): Set<string> {
  const blocked = new Set<string>()
  for (const p of placed) {
    for (let dr = p.backgroundTiles; dr < p.height; dr++) {
      for (let dc = 0; dc < p.width; dc++) {
        blocked.add(`${p.col + dc},${p.row + dr}`)
      }
    }
  }
  return blocked
}

/** BFS: check if the door tile can reach all interior tiles that aren't blocked.
 *  Returns false if any non-blocked interior tile is unreachable from the door. */
export function isPathClear(bounds: RoomBounds, placed: PlacedCell[]): boolean {
  const interior = getInterior(bounds)
  const blocked = buildBlockedSet(placed)
  const doorCol = bounds.roomCol + Math.floor(bounds.roomWidth / 2)
  const doorRow = bounds.doorSide === 'bottom'
    ? bounds.roomRow + bounds.roomHeight - 2
    : bounds.roomRow + 1

  const visited = new Set<string>()
  const queue: Array<[number, number]> = [[doorCol, doorRow]]
  const startKey = `${doorCol},${doorRow}`
  if (blocked.has(startKey)) return false
  visited.add(startKey)

  while (queue.length > 0) {
    const [c, r] = queue.shift()!
    for (const [dc, dr] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
      const nc = c + dc
      const nr = r + dr
      if (nc < interior.minCol || nc > interior.maxCol || nr < interior.minRow || nr > interior.maxRow) continue
      const key = `${nc},${nr}`
      if (visited.has(key) || blocked.has(key)) continue
      visited.add(key)
      queue.push([nc, nr])
    }
  }

  for (let r = interior.minRow; r <= interior.maxRow; r++) {
    for (let c = interior.minCol; c <= interior.maxCol; c++) {
      const key = `${c},${r}`
      if (!blocked.has(key) && !visited.has(key)) return false
    }
  }
  return true
}

// ── Tile Counting ────────────────────────────────────────────

/** Count how many interior tiles are occupied by placed furniture */
export function countOccupiedTiles(placed: PlacedCell[]): number {
  let count = 0
  for (const p of placed) {
    count += (p.width) * (p.height - p.backgroundTiles)
  }
  return count
}
