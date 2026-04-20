/**
 * WFC room decorator — public API and placement phases.
 *
 * Places required furniture (desks + chairs) in fixed grid rows,
 * then fills remaining space with decorative items using constraint-based placement.
 */

import { FurnitureType, Direction } from '../types.js'
import type { PlacedFurniture, ActivitySpot } from '../types.js'
import type { RoomBounds, PlacedCell, DecorationResult, RequiredFurnitureResult, ChairSide } from './wfcTypes.js'
import { createRng, nameToSeed, weightedPick } from './wfcTypes.js'
import { WALL_MODULES, PLANT_MODULES, LOUNGE_GROUPS, FLOOR_MODULES, SURFACE_MODULES } from './wfcModules.js'
import {
  getInterior, overlapsPlaced, getWallSlots, getCornerSlots, getEdgeSlots,
  isNearEntrance, canPlaceModule, isPathClear, countOccupiedTiles,
} from './wfcPlacement.js'

// Re-export types used by external consumers
export type { RoomBounds } from './wfcTypes.js'

// ── Desk/Chair Constants ─────────────────────────────────────

const DESK_WIDTH = 3
const DESK_HEIGHT = 2
const DESK_BG_TILES = 1
const CHAIR_HEIGHT = 2
const CHAIR_BG_TILES = 1

/** Compute chair row for a given desk row and side */
function getChairRow(deskRow: number, side: ChairSide): number {
  if (side === 'south') {
    // Chair tucked against desk — bg row overlaps desk bottom, body just below
    return deskRow + DESK_HEIGHT - 1
  }
  // North: chair 1 row above desk
  return deskRow - 1
}

// ── Required Furniture ───────────────────────────────────────

/** Place required desks + chairs in evenly spaced rows. */
export function placeRequiredFurniture(
  bounds: RoomBounds,
  seed?: number,
): RequiredFurnitureResult {
  const rng = createRng(seed ?? nameToSeed(bounds.name + ':desks'))
  const furniture: PlacedFurniture[] = []
  const seatUids: string[] = []
  const activitySpots: ActivitySpot[] = []
  const placed: PlacedCell[] = []

  let chairGlobalIdx = 0
  let seatsRemaining = bounds.seatCount

  for (let dr = 0; dr < bounds.deskRows; dr++) {
    const deskBaseRow = bounds.roomRow + 2 + dr * 3

    const desksInThisRow = dr < bounds.deskRows - 1
      ? bounds.desksPerRow
      : bounds.deskCount - dr * bounds.desksPerRow

    const totalDesksWidth = desksInThisRow * 4 - 1
    const interiorWidth = bounds.roomWidth - 2
    const colOffset = Math.max(0, Math.floor((interiorWidth - totalDesksWidth) / 2))

    for (let dp = 0; dp < desksInThisRow; dp++) {
      const deskCol = bounds.roomCol + 1 + colOffset + dp * 4
      const deskIdx = dr * bounds.desksPerRow + dp

      furniture.push({
        uid: `${bounds.name}:desk-${deskIdx}`,
        type: FurnitureType.DESK,
        col: deskCol,
        row: deskBaseRow,
      })
      placed.push({ col: deskCol, row: deskBaseRow, width: DESK_WIDTH, height: DESK_HEIGHT, backgroundTiles: DESK_BG_TILES })

      const hasPC = rng() < 0.6
      if (hasPC) {
        furniture.push({
          uid: `${bounds.name}:pc-${deskIdx}`,
          type: FurnitureType.PC,
          col: deskCol + 1,
          row: deskBaseRow,
        })
      }

      // PC desks always get south chairs; others randomize
      const interior = getInterior(bounds)
      const southChairRow = getChairRow(deskBaseRow, 'south')
      const northChairRow = getChairRow(deskBaseRow, 'north')
      const southFits = southChairRow + CHAIR_BG_TILES <= interior.maxRow
      const northFits = northChairRow + CHAIR_BG_TILES >= interior.minRow
      let chairSide: ChairSide
      if (hasPC && southFits) {
        chairSide = 'south'
      } else if (southFits && northFits) {
        chairSide = rng() < 0.5 ? 'south' : 'north'
      } else if (southFits) {
        chairSide = 'south'
      } else {
        chairSide = 'north'
      }

      const chairRow = getChairRow(deskBaseRow, chairSide)
      const chairType = chairSide === 'south'
        ? FurnitureType.WOODEN_CHAIR_BACK
        : FurnitureType.WOODEN_CHAIR_FRONT

      const chairsForThisDesk = Math.min(2, seatsRemaining)
      for (let ci = 0; ci < chairsForThisDesk; ci++) {
        const chairCol = chairsForThisDesk === 1 ? deskCol + 1 : deskCol + ci
        const chairUid = `${bounds.name}:chair-${chairGlobalIdx}`
        furniture.push({ uid: chairUid, type: chairType, col: chairCol, row: chairRow })
        placed.push({ col: chairCol, row: chairRow, width: 1, height: CHAIR_HEIGHT, backgroundTiles: CHAIR_BG_TILES })
        // South chairs: character sits on the 2nd footprint tile (below desk, not inside it)
        // layoutToSeats creates seat "uid" at tile 0 and "uid:1" at tile 1
        const seatUid = chairSide === 'south' ? `${chairUid}:1` : chairUid
        seatUids.push(seatUid)
        chairGlobalIdx++
        seatsRemaining--
      }
    }
  }

  const interior = getInterior(bounds)
  activitySpots.push({
    uid: `${bounds.name}:pc-spot-0`,
    toolCategory: 'web_research',
    standCol: interior.maxCol,
    standRow: interior.minRow + 1,
    facingDir: Direction.LEFT,
    occupiedBy: null,
  })
  activitySpots.push({
    uid: `${bounds.name}:pc-spot-1`,
    toolCategory: 'web_research',
    standCol: interior.maxCol,
    standRow: interior.minRow + 2,
    facingDir: Direction.LEFT,
    occupiedBy: null,
  })

  return { furniture, seatUids, activitySpots, placed }
}

// ── Decoration Phases ────────────────────────────────────────

/** Fill remaining room space with decorative items */
export function decorateRoom(
  bounds: RoomBounds,
  placed: PlacedCell[],
  seed?: number,
): DecorationResult {
  const rng = createRng(seed ?? nameToSeed(bounds.name))
  const furniture: PlacedFurniture[] = []
  const activitySpots: ActivitySpot[] = []
  const localPlaced = [...placed]
  const moduleCounts = new Map<string, number>()

  placeWallDecorations(bounds, localPlaced, furniture, activitySpots, moduleCounts, rng)
  placeLoungeFurniture(bounds, localPlaced, furniture, moduleCounts, rng)
  placePlantDecorations(bounds, localPlaced, furniture, moduleCounts, rng)
  placeEdgeDecorations(bounds, localPlaced, furniture, moduleCounts, rng)
  placeSurfaceDecorations(bounds, furniture, moduleCounts, rng)

  return { furniture, activitySpots }
}

function placeWallDecorations(
  bounds: RoomBounds,
  placed: PlacedCell[],
  furniture: PlacedFurniture[],
  activitySpots: ActivitySpot[],
  counts: Map<string, number>,
  rng: () => number,
): void {
  const wallSlots = getWallSlots(bounds)
  if (wallSlots.length === 0) return

  const interior = getInterior(bounds)
  const interiorWidth = interior.maxCol - interior.minCol + 1
  const maxWallItems = Math.min(4, Math.floor(interiorWidth / 3))
  let wallItemsPlaced = 0

  const requiredWall = [
    { mod: WALL_MODULES.find(m => m.id === 'bookshelf')!, side: 'left' as const },
    { mod: WALL_MODULES.find(m => m.id === 'whiteboard')!, side: 'right' as const },
  ]

  for (const { mod, side } of requiredWall) {
    if (!mod) continue
    const col = side === 'left'
      ? interior.minCol
      : interior.maxCol - mod.width + 1
    const row = bounds.roomRow - 1

    if (canPlaceModule(mod, col, row, bounds, placed)) {
      const uid = `${bounds.name}:${mod.id}`
      furniture.push({ uid, type: mod.type, col, row })
      placed.push({ col, row, width: mod.width, height: mod.height, backgroundTiles: mod.backgroundTiles })
      counts.set(mod.id, (counts.get(mod.id) || 0) + 1)
      wallItemsPlaced++

      if (mod.id === 'bookshelf') {
        activitySpots.push(
          { uid: `${bounds.name}:bookshelf-spot-0`, toolCategory: 'file_research', standCol: col, standRow: bounds.roomRow + 1, facingDir: Direction.UP, occupiedBy: null },
          { uid: `${bounds.name}:bookshelf-spot-1`, toolCategory: 'file_research', standCol: col + 1, standRow: bounds.roomRow + 1, facingDir: Direction.UP, occupiedBy: null },
        )
      } else if (mod.id === 'whiteboard') {
        activitySpots.push(
          { uid: `${bounds.name}:whiteboard-spot-0`, toolCategory: 'planning', standCol: col, standRow: bounds.roomRow + 1, facingDir: Direction.UP, occupiedBy: null },
          { uid: `${bounds.name}:whiteboard-spot-1`, toolCategory: 'planning', standCol: col + 1, standRow: bounds.roomRow + 1, facingDir: Direction.UP, occupiedBy: null },
        )
      }
    }
  }

  const optionalWallMods = WALL_MODULES.filter(m => m.id !== 'bookshelf' && m.id !== 'whiteboard')
  while (wallItemsPlaced < maxWallItems) {
    const available = optionalWallMods.filter(m => (counts.get(m.id) || 0) < m.maxPerRoom)
    if (available.length === 0) break
    const mod = weightedPick(available, rng)
    if (!mod) break

    const shuffledSlots = [...wallSlots].sort(() => rng() - 0.5)
    let didPlace = false
    for (const slot of shuffledSlots) {
      if (canPlaceModule(mod, slot.col, slot.row, bounds, placed)) {
        furniture.push({ uid: `${bounds.name}:wall-${mod.id}-${wallItemsPlaced}`, type: mod.type, col: slot.col, row: slot.row })
        placed.push({ col: slot.col, row: slot.row, width: mod.width, height: mod.height, backgroundTiles: mod.backgroundTiles })
        counts.set(mod.id, (counts.get(mod.id) || 0) + 1)
        didPlace = true
        break
      }
    }
    if (!didPlace) break
    wallItemsPlaced++
  }
}

function placeLoungeFurniture(
  bounds: RoomBounds,
  placed: PlacedCell[],
  furniture: PlacedFurniture[],
  counts: Map<string, number>,
  rng: () => number,
): void {
  const interior = getInterior(bounds)
  const interiorWidth = interior.maxCol - interior.minCol + 1
  const interiorHeight = interior.maxRow - interior.minRow + 1
  const totalInteriorTiles = interiorWidth * interiorHeight
  const openTiles = totalInteriorTiles - countOccupiedTiles(placed)

  if (openTiles < totalInteriorTiles * 0.4) return

  const availableGroups = LOUNGE_GROUPS.filter(g => (counts.get(g.id) || 0) === 0)
  if (availableGroups.length === 0) return

  const totalWeight = availableGroups.reduce((sum, g) => sum + g.weight, 0)
  let pick = rng() * totalWeight
  let chosenGroup = availableGroups[0]
  for (const g of availableGroups) {
    pick -= g.weight
    if (pick <= 0) { chosenGroup = g; break }
  }

  // Lounge groups need 1 tile clearance from all walls and existing furniture
  const margin = 1
  const slots: Array<{ col: number; row: number }> = []
  const startC = interior.minCol + margin
  const startR = interior.minRow + margin
  const endC = interior.maxCol - chosenGroup.totalWidth + 1 - margin
  const endR = interior.maxRow - chosenGroup.totalHeight + 1 - margin
  for (let r = startR; r <= endR; r++) {
    for (let c = startC; c <= endC; c++) {
      slots.push({ col: c, row: r })
    }
  }
  slots.sort(() => rng() - 0.5)

  for (const slot of slots) {
    let allFit = true
    const testPieces: PlacedCell[] = []
    for (const piece of chosenGroup.pieces) {
      const pc = slot.col + piece.offsetCol
      const pr = slot.row + piece.offsetRow
      if (pc < interior.minCol || pc + piece.width - 1 > interior.maxCol) { allFit = false; break }
      if (pr < interior.minRow || pr + piece.height - 1 > interior.maxRow) { allFit = false; break }
      // Check overlap with 1-tile margin around each piece (prevents touching desks/walls)
      if (overlapsPlaced(pc - 1, pr - 1, piece.width + 2, piece.height + 2, 0, placed)) { allFit = false; break }
      if (isNearEntrance(pc, pr, piece.width, piece.height, bounds)) { allFit = false; break }
      testPieces.push({ col: pc, row: pr, width: piece.width, height: piece.height, backgroundTiles: 0 })
    }
    if (!allFit) continue
    if (!isPathClear(bounds, [...placed, ...testPieces])) continue

    for (let i = 0; i < chosenGroup.pieces.length; i++) {
      const piece = chosenGroup.pieces[i]
      const pc = slot.col + piece.offsetCol
      const pr = slot.row + piece.offsetRow
      furniture.push({ uid: `${bounds.name}:lounge-${chosenGroup.id}-${i}`, type: piece.type, col: pc, row: pr })
      placed.push({ col: pc, row: pr, width: piece.width, height: piece.height, backgroundTiles: 0 })
    }
    counts.set(chosenGroup.id, 1)
    break
  }
}

function placePlantDecorations(
  bounds: RoomBounds,
  placed: PlacedCell[],
  furniture: PlacedFurniture[],
  counts: Map<string, number>,
  rng: () => number,
): void {
  const interior = getInterior(bounds)
  const interiorWidth = interior.maxCol - interior.minCol + 1
  const interiorHeight = interior.maxRow - interior.minRow + 1
  const totalInteriorTiles = interiorWidth * interiorHeight
  const openTiles = totalInteriorTiles - countOccupiedTiles(placed)
  const maxPlants = Math.max(2, Math.floor(openTiles / 8))

  const slots: Array<{ col: number; row: number }> = []
  slots.push(...getCornerSlots(bounds))
  slots.push(...getEdgeSlots(bounds))
  if (openTiles > 15) {
    for (let r = interior.minRow + 1; r < interior.maxRow; r++) {
      for (let c = interior.minCol + 1; c < interior.maxCol; c++) {
        slots.push({ col: c, row: r })
      }
    }
  }
  slots.sort(() => rng() - 0.5)

  const plantPositions: Array<{ col: number; row: number }> = []
  let plantCount = 0

  for (const slot of slots) {
    if (plantCount >= maxPlants) break
    const available = PLANT_MODULES.filter(m => (counts.get(m.id) || 0) < m.maxPerRoom)
    if (available.length === 0) break
    const mod = weightedPick(available, rng)
    if (!mod) break

    const placeRow = slot.row - mod.backgroundTiles
    if (!canPlaceModule(mod, slot.col, placeRow, bounds, placed)) continue

    const tooClose = plantPositions.some(p =>
      Math.abs(slot.col - p.col) + Math.abs(slot.row - p.row) < 3
    )
    if (tooClose) continue

    const testPlaced = [...placed, { col: slot.col, row: placeRow, width: mod.width, height: mod.height, backgroundTiles: mod.backgroundTiles }]
    if (!isPathClear(bounds, testPlaced)) continue

    furniture.push({ uid: `${bounds.name}:plant-${mod.id}-${plantCount}`, type: mod.type, col: slot.col, row: placeRow })
    placed.push({ col: slot.col, row: placeRow, width: mod.width, height: mod.height, backgroundTiles: mod.backgroundTiles })
    plantPositions.push({ col: slot.col, row: slot.row })
    counts.set(mod.id, (counts.get(mod.id) || 0) + 1)
    plantCount++
  }
}

function placeEdgeDecorations(
  bounds: RoomBounds,
  placed: PlacedCell[],
  furniture: PlacedFurniture[],
  counts: Map<string, number>,
  rng: () => number,
): void {
  const edges = getEdgeSlots(bounds)
  edges.sort(() => rng() - 0.5)

  const edgeModules = FLOOR_MODULES.filter(m => m.placement === 'floor-edge')
  const interior = getInterior(bounds)
  const interiorArea = (interior.maxCol - interior.minCol + 1) * (interior.maxRow - interior.minRow + 1)
  const maxEdgeItems = Math.min(3, Math.floor(interiorArea / 15))
  const edgePlacedPositions: Array<{ col: number; row: number }> = []
  let placedCount = 0

  for (const edge of edges) {
    if (placedCount >= maxEdgeItems) break
    const available = edgeModules.filter(m => (counts.get(m.id) || 0) < m.maxPerRoom)
    if (available.length === 0) break
    const mod = weightedPick(available, rng)
    if (!mod) break

    const tooClose = edgePlacedPositions.some(p =>
      Math.abs(edge.col - p.col) + Math.abs(edge.row - p.row) < 3
    )
    if (tooClose) continue
    if (!canPlaceModule(mod, edge.col, edge.row, bounds, placed)) continue

    furniture.push({ uid: `${bounds.name}:edge-${mod.id}-${placedCount}`, type: mod.type, col: edge.col, row: edge.row })
    placed.push({ col: edge.col, row: edge.row, width: mod.width, height: mod.height, backgroundTiles: mod.backgroundTiles })
    edgePlacedPositions.push({ col: edge.col, row: edge.row })
    counts.set(mod.id, (counts.get(mod.id) || 0) + 1)
    placedCount++
  }
}

function placeSurfaceDecorations(
  bounds: RoomBounds,
  furniture: PlacedFurniture[],
  counts: Map<string, number>,
  rng: () => number,
): void {
  const desks = furniture.filter(f => f.type === FurnitureType.DESK)
  if (desks.length === 0) return

  const maxSurface = Math.min(2, desks.length)
  const shuffledDesks = [...desks].sort(() => rng() - 0.5)
  let surfaceCount = 0

  for (const desk of shuffledDesks) {
    if (surfaceCount >= maxSurface) break
    const available = SURFACE_MODULES.filter(m => (counts.get(m.id) || 0) < m.maxPerRoom)
    if (available.length === 0) break
    const mod = weightedPick(available, rng)
    if (!mod) break

    const surfaceCol = rng() < 0.5 ? desk.col : desk.col + 2
    furniture.push({ uid: `${bounds.name}:surface-${mod.id}-${surfaceCount}`, type: mod.type, col: surfaceCol, row: desk.row })
    counts.set(mod.id, (counts.get(mod.id) || 0) + 1)
    surfaceCount++
  }
}

// ── Public API ───────────────────────────────────────────────

/** Full room decoration: place required furniture + WFC decorations. */
export function decorateProjectRoom(
  bounds: RoomBounds,
  seed?: number,
): { furniture: PlacedFurniture[]; seatUids: string[]; activitySpots: ActivitySpot[] } {
  // Mix the provided seed with room identity so each room in the same layout is unique
  const actualSeed = (seed ?? Math.floor(Math.random() * 2147483647)) ^ nameToSeed(bounds.name)
  const required = placeRequiredFurniture(bounds, actualSeed)
  const decoration = decorateRoom(bounds, required.placed, actualSeed)

  return {
    furniture: [...required.furniture, ...decoration.furniture],
    seatUids: required.seatUids,
    activitySpots: [...required.activitySpots, ...decoration.activitySpots],
  }
}
