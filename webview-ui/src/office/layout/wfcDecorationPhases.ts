/**
 * WFC decoration phases — fill remaining room space with decorative items
 * after the required desks/chairs are placed. Runs in phases: wall → lounge →
 * plants → edge items → surface items on desks.
 */

import { FurnitureType, Direction } from '../types.js'
import type { PlacedFurniture, ActivitySpot } from '../types.js'
import type { RoomBounds, PlacedCell, DecorationResult } from './wfcTypes.js'
import { createRng, nameToSeed, weightedPick } from './wfcTypes.js'
import { WALL_MODULES, PLANT_MODULES, LOUNGE_GROUPS, FLOOR_MODULES, SURFACE_MODULES } from './wfcModules.js'
import {
  getInterior, overlapsPlaced, getWallSlots, getCornerSlots, getEdgeSlots,
  isNearEntrance, canPlaceModule, isPathClear, countOccupiedTiles,
} from './wfcPlacement.js'

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
      // 1-tile margin around each piece prevents touching desks/walls
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
