/**
 * Wave Function Collapse room decorator.
 *
 * Places required furniture (desks + chairs with correct orientations) first,
 * then fills remaining space with decorative items using a constraint-based
 * WFC-inspired algorithm.
 *
 * Concepts:
 * - Cell: a tile position in the room interior
 * - Module: a furniture item with placement rules (footprint, valid positions, weight)
 * - Superposition: set of modules that could still be placed at a cell
 * - Collapse: choosing a module for the cell with lowest entropy
 * - Propagation: removing invalid modules from neighbors after a collapse
 */

import { FurnitureType, Direction } from '../types.js'
import type { PlacedFurniture, ActivitySpot } from '../types.js'

// ── Types ────────────────────────────────────────────────────

export interface RoomBounds {
  /** Room name (used for furniture uid prefixes) */
  name: string
  /** Top-left col of room (including wall) */
  roomCol: number
  /** Top-left row of room (including wall) */
  roomRow: number
  /** Total width including walls */
  roomWidth: number
  /** Total height including walls */
  roomHeight: number
  /** Which side has the door */
  doorSide: 'top' | 'bottom'
  /** Number of seats needed */
  seatCount: number
  /** Number of desks needed */
  deskCount: number
  /** Desks per row */
  desksPerRow: number
  /** Number of desk rows */
  deskRows: number
}

/** A decoration module that can be placed */
interface DecorationModule {
  /** Unique type id */
  id: string
  /** Furniture type to place */
  type: string
  /** Footprint width in tiles */
  width: number
  /** Footprint height in tiles */
  height: number
  /** Where this module can be placed */
  placement: 'wall' | 'floor-edge' | 'floor-corner' | 'floor-any' | 'surface'
  /** Relative weight (higher = more likely to be chosen) */
  weight: number
  /** Max instances per room */
  maxPerRoom: number
  /** Background tiles (top N rows are walkable) */
  backgroundTiles: number
  /** Whether it's wall-mounted */
  canPlaceOnWalls: boolean
  /** Whether it goes on desk surfaces */
  canPlaceOnSurfaces: boolean
}

interface PlacedCell {
  col: number
  row: number
  width: number
  height: number
  backgroundTiles: number
}

// ── Seeded RNG ───────────────────────────────────────────────

/** Simple mulberry32 PRNG for deterministic decoration given a seed */
function createRng(seed: number): () => number {
  let s = seed | 0
  return () => {
    s = (s + 0x6D2B79F5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Generate a seed from room name for deterministic decoration */
function nameToSeed(name: string): number {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0
  }
  return hash
}

// ── Decoration Modules ───────────────────────────────────────

const WALL_MODULES: DecorationModule[] = [
  { id: 'bookshelf', type: FurnitureType.BOOKSHELF, width: 2, height: 1, placement: 'wall', weight: 3, maxPerRoom: 1, backgroundTiles: 0, canPlaceOnWalls: true, canPlaceOnSurfaces: false },
  { id: 'double-bookshelf', type: FurnitureType.DOUBLE_BOOKSHELF, width: 2, height: 2, placement: 'wall', weight: 2, maxPerRoom: 1, backgroundTiles: 0, canPlaceOnWalls: true, canPlaceOnSurfaces: false },
  { id: 'whiteboard', type: FurnitureType.WHITEBOARD, width: 2, height: 2, placement: 'wall', weight: 3, maxPerRoom: 1, backgroundTiles: 0, canPlaceOnWalls: true, canPlaceOnSurfaces: false },
  { id: 'large-painting', type: FurnitureType.LARGE_PAINTING, width: 2, height: 2, placement: 'wall', weight: 2, maxPerRoom: 1, backgroundTiles: 0, canPlaceOnWalls: true, canPlaceOnSurfaces: false },
  { id: 'small-painting', type: FurnitureType.SMALL_PAINTING, width: 1, height: 2, placement: 'wall', weight: 2, maxPerRoom: 2, backgroundTiles: 0, canPlaceOnWalls: true, canPlaceOnSurfaces: false },
  { id: 'small-painting-2', type: FurnitureType.SMALL_PAINTING_2, width: 1, height: 2, placement: 'wall', weight: 2, maxPerRoom: 2, backgroundTiles: 0, canPlaceOnWalls: true, canPlaceOnSurfaces: false },
  { id: 'clock', type: FurnitureType.CLOCK, width: 1, height: 2, placement: 'wall', weight: 1, maxPerRoom: 1, backgroundTiles: 0, canPlaceOnWalls: true, canPlaceOnSurfaces: false },
  { id: 'hanging-plant', type: FurnitureType.HANGING_PLANT, width: 1, height: 2, placement: 'wall', weight: 2, maxPerRoom: 2, backgroundTiles: 0, canPlaceOnWalls: true, canPlaceOnSurfaces: false },
]

const FLOOR_MODULES: DecorationModule[] = [
  { id: 'plant', type: FurnitureType.PLANT, width: 1, height: 2, placement: 'floor-corner', weight: 3, maxPerRoom: 2, backgroundTiles: 1, canPlaceOnWalls: false, canPlaceOnSurfaces: false },
  { id: 'plant-2', type: FurnitureType.PLANT_2, width: 1, height: 2, placement: 'floor-corner', weight: 3, maxPerRoom: 2, backgroundTiles: 1, canPlaceOnWalls: false, canPlaceOnSurfaces: false },
  { id: 'cactus', type: FurnitureType.CACTUS, width: 1, height: 2, placement: 'floor-corner', weight: 2, maxPerRoom: 1, backgroundTiles: 1, canPlaceOnWalls: false, canPlaceOnSurfaces: false },
  { id: 'large-plant', type: FurnitureType.LARGE_PLANT, width: 2, height: 3, placement: 'floor-corner', weight: 1, maxPerRoom: 1, backgroundTiles: 2, canPlaceOnWalls: false, canPlaceOnSurfaces: false },
  { id: 'bin', type: FurnitureType.BIN, width: 1, height: 1, placement: 'floor-edge', weight: 2, maxPerRoom: 2, backgroundTiles: 0, canPlaceOnWalls: false, canPlaceOnSurfaces: false },
  { id: 'pot', type: FurnitureType.POT, width: 1, height: 1, placement: 'floor-edge', weight: 1, maxPerRoom: 1, backgroundTiles: 0, canPlaceOnWalls: false, canPlaceOnSurfaces: false },
]

const SURFACE_MODULES: DecorationModule[] = [
  { id: 'coffee', type: FurnitureType.COFFEE, width: 1, height: 1, placement: 'surface', weight: 2, maxPerRoom: 2, backgroundTiles: 0, canPlaceOnWalls: false, canPlaceOnSurfaces: true },
]

// ── Core WFC Logic ───────────────────────────────────────────

/** Get interior bounds (excluding walls) */
function getInterior(bounds: RoomBounds): { minCol: number; maxCol: number; minRow: number; maxRow: number } {
  return {
    minCol: bounds.roomCol + 1,
    maxCol: bounds.roomCol + bounds.roomWidth - 2,
    minRow: bounds.roomRow + 1,
    maxRow: bounds.roomRow + bounds.roomHeight - 2,
  }
}

/** Check if a footprint overlaps any already-placed cells */
function overlapsPlaced(col: number, row: number, width: number, height: number, bgTiles: number, placed: PlacedCell[]): boolean {
  for (const p of placed) {
    // Check overlap accounting for background tiles (which are walkable/non-blocking)
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

/** Find valid wall positions (along the top wall, placed at roomRow - 1) */
function getWallSlots(bounds: RoomBounds): Array<{ col: number; row: number }> {
  const slots: Array<{ col: number; row: number }> = []
  const wallRow = bounds.roomRow - 1  // Wall-mounted items go 1 row above top wall
  const interior = getInterior(bounds)

  for (let c = interior.minCol; c <= interior.maxCol; c++) {
    slots.push({ col: c, row: wallRow })
  }
  return slots
}

/** Find valid corner positions (interior corners of the room) */
function getCornerSlots(bounds: RoomBounds): Array<{ col: number; row: number }> {
  const interior = getInterior(bounds)
  return [
    { col: interior.minCol, row: interior.minRow },
    { col: interior.maxCol, row: interior.minRow },
    { col: interior.minCol, row: interior.maxRow },
    { col: interior.maxCol, row: interior.maxRow },
  ]
}

/** Find valid edge positions (along walls but not corners) */
function getEdgeSlots(bounds: RoomBounds): Array<{ col: number; row: number }> {
  const interior = getInterior(bounds)
  const slots: Array<{ col: number; row: number }> = []

  // Top and bottom edges (excluding corners)
  for (let c = interior.minCol + 1; c < interior.maxCol; c++) {
    slots.push({ col: c, row: interior.minRow })
    slots.push({ col: c, row: interior.maxRow })
  }
  // Left and right edges (excluding corners)
  for (let r = interior.minRow + 1; r < interior.maxRow; r++) {
    slots.push({ col: interior.minCol, row: r })
    slots.push({ col: interior.maxCol, row: r })
  }
  return slots
}

/** Check if a position is within the entrance zone */
function isNearEntrance(col: number, row: number, width: number, height: number, bounds: RoomBounds): boolean {
  const doorCol = bounds.roomCol + Math.floor(bounds.roomWidth / 2)
  if (bounds.doorSide === 'bottom') {
    const doorRow = bounds.roomRow + bounds.roomHeight - 2
    // Check if footprint overlaps the 2 tiles in front of the door
    if (col <= doorCol && col + width > doorCol && row + height > doorRow - 1) return true
  } else {
    const doorRow = bounds.roomRow + 1
    if (col <= doorCol && col + width > doorCol && row < doorRow + 2) return true
  }
  return false
}

/** Check if a module can be placed at a given position */
function canPlaceModule(
  mod: DecorationModule,
  col: number,
  row: number,
  bounds: RoomBounds,
  placed: PlacedCell[],
): boolean {
  const interior = getInterior(bounds)

  // Never place anything blocking the entrance
  if (isNearEntrance(col, row, mod.width, mod.height, bounds)) return false

  if (mod.canPlaceOnWalls) {
    // Wall items: check they fit horizontally within interior
    if (col < interior.minCol || col + mod.width - 1 > interior.maxCol) return false
    // Wall items can have negative row (above the grid) — that's fine
    return !overlapsPlaced(col, row, mod.width, mod.height, mod.backgroundTiles, placed)
  }

  // Floor items: must fit within interior
  const effectiveHeight = mod.height - mod.backgroundTiles
  const effectiveRow = row + mod.backgroundTiles
  if (col < interior.minCol || col + mod.width - 1 > interior.maxCol) return false
  if (effectiveRow < interior.minRow || effectiveRow + effectiveHeight - 1 > interior.maxRow) return false

  return !overlapsPlaced(col, row, mod.width, mod.height, mod.backgroundTiles, placed)
}

/** Weighted random selection from an array of modules */
function weightedPick(modules: DecorationModule[], rng: () => number): DecorationModule | null {
  const totalWeight = modules.reduce((sum, m) => sum + m.weight, 0)
  if (totalWeight === 0) return null
  let r = rng() * totalWeight
  for (const m of modules) {
    r -= m.weight
    if (r <= 0) return m
  }
  return modules[modules.length - 1]
}

// ── Required Furniture Placement (WFC-style) ─────────────────

const DESK_WIDTH = 3
const DESK_HEIGHT = 2
const DESK_BG_TILES = 1
const CHAIR_HEIGHT = 2
const CHAIR_BG_TILES = 1

/**
 * Find all valid positions where a desk could be placed.
 * Each desk reserves a "cluster zone" — the desk itself plus the chair row —
 * so clusters never stack against each other.
 */
function getDeskCandidates(bounds: RoomBounds, placed: PlacedCell[]): Array<{ col: number; row: number }> {
  const interior = getInterior(bounds)
  const candidates: Array<{ col: number; row: number }> = []

  for (let r = interior.minRow; r <= interior.maxRow - DESK_HEIGHT + DESK_BG_TILES; r++) {
    // Ensure there's room for chairs (1 row adjacent to the desk on the door side)
    let chairRow: number
    if (bounds.doorSide === 'bottom') {
      chairRow = r + DESK_HEIGHT
    } else {
      chairRow = r - 1
    }
    const chairEffRow = chairRow + CHAIR_BG_TILES
    if (chairEffRow < interior.minRow || chairEffRow > interior.maxRow) continue

    for (let c = interior.minCol; c <= interior.maxCol - DESK_WIDTH + 1; c++) {
      // Check the full cluster zone (desk + chair row) doesn't overlap anything
      const clusterTop = Math.min(r, chairRow)
      const clusterBottom = Math.max(r + DESK_HEIGHT, chairRow + CHAIR_HEIGHT)
      const clusterHeight = clusterBottom - clusterTop
      if (!overlapsPlaced(c, clusterTop, DESK_WIDTH, clusterHeight, 0, placed)) {
        candidates.push({ col: c, row: r })
      }
    }
  }
  return candidates
}

/** Score a desk candidate — prefer spacing from other desks, avoid entrance */
function scoreDeskPosition(col: number, row: number, bounds: RoomBounds, placed: PlacedCell[]): number {
  const interior = getInterior(bounds)
  let score = 1

  // Heavily penalize positions near the entrance
  if (isNearEntrance(col, row, DESK_WIDTH, DESK_HEIGHT, bounds)) return 0.01

  // Prefer positions away from edges (more "natural")
  const distFromLeft = col - interior.minCol
  const distFromRight = interior.maxCol - (col + DESK_WIDTH - 1)
  const edgeDist = Math.min(distFromLeft, distFromRight)
  score += edgeDist * 0.5

  // Prefer spacing from other placed items (especially other desks)
  let minDist = Infinity
  for (const p of placed) {
    const dx = Math.abs((col + DESK_WIDTH / 2) - (p.col + p.width / 2))
    const dy = Math.abs((row + DESK_HEIGHT / 2) - (p.row + p.height / 2))
    const dist = dx + dy
    if (dist < minDist) minDist = dist
  }
  if (minDist < Infinity) {
    // Prefer moderate spacing (not too close, not too far)
    score += Math.min(minDist, 6) * 0.3
  }

  return score
}

/** Place required desks + chairs using WFC-style placement. */
export function placeRequiredFurniture(
  bounds: RoomBounds,
  seed?: number,
): { furniture: PlacedFurniture[]; seatUids: string[]; activitySpots: ActivitySpot[]; placed: PlacedCell[] } {
  const rng = createRng(seed ?? nameToSeed(bounds.name + ':desks'))
  const furniture: PlacedFurniture[] = []
  const seatUids: string[] = []
  const activitySpots: ActivitySpot[] = []
  const placed: PlacedCell[] = []

  // Desk clusters are tracked separately — they reserve the full desk+chair zone
  // to prevent desks from stacking, but don't block chairs within the same cluster.
  const deskClusters: PlacedCell[] = []

  let chairGlobalIdx = 0
  let seatsRemaining = bounds.seatCount

  for (let deskIdx = 0; deskIdx < bounds.deskCount; deskIdx++) {
    const candidates = getDeskCandidates(bounds, deskClusters)
    if (candidates.length === 0) break

    // Score candidates and pick using weighted random
    const scored = candidates.map(c => ({
      ...c,
      score: scoreDeskPosition(c.col, c.row, bounds, deskClusters),
    }))
    const totalScore = scored.reduce((sum, s) => sum + s.score, 0)

    let pick = rng() * totalScore
    let chosen = scored[0]
    for (const s of scored) {
      pick -= s.score
      if (pick <= 0) { chosen = s; break }
    }

    const deskCol = chosen.col
    const deskBaseRow = chosen.row
    const chairRow = bounds.doorSide === 'bottom'
      ? deskBaseRow + DESK_HEIGHT
      : deskBaseRow - 1
    const clusterTop = Math.min(deskBaseRow, chairRow)
    const clusterBottom = Math.max(deskBaseRow + DESK_HEIGHT, chairRow + CHAIR_HEIGHT)

    // Place desk
    furniture.push({
      uid: `${bounds.name}:desk-${deskIdx}`,
      type: FurnitureType.DESK,
      col: deskCol,
      row: deskBaseRow,
    })
    // Record actual desk footprint for decoration collision
    placed.push({ col: deskCol, row: deskBaseRow, width: DESK_WIDTH, height: DESK_HEIGHT, backgroundTiles: DESK_BG_TILES })
    // Record full cluster zone so next desk stays away
    deskClusters.push({ col: deskCol, row: clusterTop, width: DESK_WIDTH, height: clusterBottom - clusterTop, backgroundTiles: 0 })

    // Place PC on desk (surface item — no collision)
    furniture.push({
      uid: `${bounds.name}:pc-${deskIdx}`,
      type: FurnitureType.PC,
      col: deskCol + 1,
      row: deskBaseRow,
    })

    // Place chairs facing the desk
    const chairType = bounds.doorSide === 'bottom'
      ? FurnitureType.WOODEN_CHAIR_BACK   // faces up toward desk
      : FurnitureType.WOODEN_CHAIR_FRONT  // faces down toward desk

    const chairsForThisDesk = Math.min(2, seatsRemaining)
    for (let ci = 0; ci < chairsForThisDesk; ci++) {
      const chairCol = deskCol + ci

      const chairUid = `${bounds.name}:chair-${chairGlobalIdx}`
      furniture.push({
        uid: chairUid,
        type: chairType,
        col: chairCol,
        row: chairRow,
      })
      placed.push({ col: chairCol, row: chairRow, width: 1, height: CHAIR_HEIGHT, backgroundTiles: CHAIR_BG_TILES })
      seatUids.push(chairUid)
      chairGlobalIdx++
      seatsRemaining--
    }
  }

  // Activity spots for PCs (stand next to rightmost desk area)
  const interior = getInterior(bounds)
  const pcSpotCol = interior.maxCol
  const pcSpotRow = interior.minRow + 1
  activitySpots.push({
    uid: `${bounds.name}:pc-spot-0`,
    toolCategory: 'web_research',
    standCol: pcSpotCol,
    standRow: pcSpotRow,
    facingDir: Direction.LEFT,
    occupiedBy: null,
  })
  activitySpots.push({
    uid: `${bounds.name}:pc-spot-1`,
    toolCategory: 'web_research',
    standCol: pcSpotCol,
    standRow: pcSpotRow + 1,
    facingDir: Direction.LEFT,
    occupiedBy: null,
  })

  return { furniture, seatUids, activitySpots, placed }
}

// ── WFC Decoration ───────────────────────────────────────────

/** Fill remaining room space with decorative items using WFC-inspired placement */
export function decorateRoom(
  bounds: RoomBounds,
  placed: PlacedCell[],
  seed?: number,
): { furniture: PlacedFurniture[]; activitySpots: ActivitySpot[] } {
  const rng = createRng(seed ?? nameToSeed(bounds.name))
  const furniture: PlacedFurniture[] = []
  const activitySpots: ActivitySpot[] = []
  const localPlaced = [...placed]
  const moduleCounts = new Map<string, number>()

  // Phase 1: Wall decorations (lowest entropy — limited wall slots)
  placeWallDecorations(bounds, localPlaced, furniture, activitySpots, moduleCounts, rng)

  // Phase 2: Corner decorations (next lowest entropy — only 4 corners)
  placeCornerDecorations(bounds, localPlaced, furniture, moduleCounts, rng)

  // Phase 3: Edge decorations (medium entropy — along walls)
  placeEdgeDecorations(bounds, localPlaced, furniture, moduleCounts, rng)

  // Phase 4: Surface decorations (coffee on desks)
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

  // Determine how many wall items to place (2-4 based on room width)
  const interior = getInterior(bounds)
  const interiorWidth = interior.maxCol - interior.minCol + 1
  const maxWallItems = Math.min(4, Math.floor(interiorWidth / 3))
  let wallItemsPlaced = 0

  // Always place a bookshelf and whiteboard first (required activity props)
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

      // Activity spots for bookshelf and whiteboard
      if (mod.id === 'bookshelf') {
        activitySpots.push({
          uid: `${bounds.name}:bookshelf-spot-0`,
          toolCategory: 'file_research',
          standCol: col,
          standRow: bounds.roomRow + 1,
          facingDir: Direction.UP,
          occupiedBy: null,
        })
        activitySpots.push({
          uid: `${bounds.name}:bookshelf-spot-1`,
          toolCategory: 'file_research',
          standCol: col + 1,
          standRow: bounds.roomRow + 1,
          facingDir: Direction.UP,
          occupiedBy: null,
        })
      } else if (mod.id === 'whiteboard') {
        activitySpots.push({
          uid: `${bounds.name}:whiteboard-spot-0`,
          toolCategory: 'planning',
          standCol: col,
          standRow: bounds.roomRow + 1,
          facingDir: Direction.UP,
          occupiedBy: null,
        })
        activitySpots.push({
          uid: `${bounds.name}:whiteboard-spot-1`,
          toolCategory: 'planning',
          standCol: col + 1,
          standRow: bounds.roomRow + 1,
          facingDir: Direction.UP,
          occupiedBy: null,
        })
      }
    }
  }

  // Fill remaining wall slots with random decorations
  const optionalWallMods = WALL_MODULES.filter(m => m.id !== 'bookshelf' && m.id !== 'whiteboard')

  while (wallItemsPlaced < maxWallItems) {
    // Filter to modules that haven't exceeded their max
    const available = optionalWallMods.filter(m => (counts.get(m.id) || 0) < m.maxPerRoom)
    if (available.length === 0) break

    const mod = weightedPick(available, rng)
    if (!mod) break

    // Try random wall positions
    const shuffledSlots = [...wallSlots].sort(() => rng() - 0.5)
    let didPlace = false
    for (const slot of shuffledSlots) {
      if (canPlaceModule(mod, slot.col, slot.row, bounds, placed)) {
        const uid = `${bounds.name}:wall-${mod.id}-${wallItemsPlaced}`
        furniture.push({ uid, type: mod.type, col: slot.col, row: slot.row })
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

function placeCornerDecorations(
  bounds: RoomBounds,
  placed: PlacedCell[],
  furniture: PlacedFurniture[],
  counts: Map<string, number>,
  rng: () => number,
): void {
  const corners = getCornerSlots(bounds)
  // Shuffle corners for variety
  corners.sort(() => rng() - 0.5)

  // Place 1-2 corner items (plants, cactus)
  const cornerModules = FLOOR_MODULES.filter(m => m.placement === 'floor-corner')
  let placed_count = 0
  const maxCornerItems = Math.min(2, Math.floor(corners.length * 0.6))

  for (const corner of corners) {
    if (placed_count >= maxCornerItems) break

    const available = cornerModules.filter(m => (counts.get(m.id) || 0) < m.maxPerRoom)
    if (available.length === 0) break

    const mod = weightedPick(available, rng)
    if (!mod) break

    // For tall items (height > 1), adjust row so the blocking part is at the corner
    const placeRow = corner.row - mod.backgroundTiles
    if (canPlaceModule(mod, corner.col, placeRow, bounds, placed)) {
      const uid = `${bounds.name}:corner-${mod.id}-${placed_count}`
      furniture.push({ uid, type: mod.type, col: corner.col, row: placeRow })
      placed.push({ col: corner.col, row: placeRow, width: mod.width, height: mod.height, backgroundTiles: mod.backgroundTiles })
      counts.set(mod.id, (counts.get(mod.id) || 0) + 1)
      placed_count++
    }
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
  let placed_count = 0
  // Place 1-3 edge items depending on room size
  const interior = getInterior(bounds)
  const interiorArea = (interior.maxCol - interior.minCol + 1) * (interior.maxRow - interior.minRow + 1)
  const maxEdgeItems = Math.min(3, Math.floor(interiorArea / 15))

  // Track positions of placed edge items for spacing enforcement
  const edgePlacedPositions: Array<{ col: number; row: number }> = []

  for (const edge of edges) {
    if (placed_count >= maxEdgeItems) break

    const available = edgeModules.filter(m => (counts.get(m.id) || 0) < m.maxPerRoom)
    if (available.length === 0) break

    const mod = weightedPick(available, rng)
    if (!mod) break

    // Enforce minimum 2-tile spacing between edge items (prevents pots/bins clustering)
    const tooClose = edgePlacedPositions.some(p =>
      Math.abs(edge.col - p.col) + Math.abs(edge.row - p.row) < 3
    )
    if (tooClose) continue

    if (canPlaceModule(mod, edge.col, edge.row, bounds, placed)) {
      const uid = `${bounds.name}:edge-${mod.id}-${placed_count}`
      furniture.push({ uid, type: mod.type, col: edge.col, row: edge.row })
      placed.push({ col: edge.col, row: edge.row, width: mod.width, height: mod.height, backgroundTiles: mod.backgroundTiles })
      edgePlacedPositions.push({ col: edge.col, row: edge.row })
      counts.set(mod.id, (counts.get(mod.id) || 0) + 1)
      placed_count++
    }
  }
}

/** Place surface items (coffee) on desks */
function placeSurfaceDecorations(
  bounds: RoomBounds,
  furniture: PlacedFurniture[],
  counts: Map<string, number>,
  rng: () => number,
): void {
  // Find all placed desks to put surface items on
  const desks = furniture.filter(f => f.type === FurnitureType.DESK)
  if (desks.length === 0) return

  let surfaceCount = 0
  const maxSurface = Math.min(2, desks.length)

  // Shuffle desks so surface items go on random ones
  const shuffledDesks = [...desks].sort(() => rng() - 0.5)

  for (const desk of shuffledDesks) {
    if (surfaceCount >= maxSurface) break

    const available = SURFACE_MODULES.filter(m => (counts.get(m.id) || 0) < m.maxPerRoom)
    if (available.length === 0) break

    const mod = weightedPick(available, rng)
    if (!mod) break

    // Place on desk surface (col 0 or 2 of the 3-wide desk, avoiding the PC at col+1)
    const surfaceCol = rng() < 0.5 ? desk.col : desk.col + 2
    const uid = `${bounds.name}:surface-${mod.id}-${surfaceCount}`
    furniture.push({ uid, type: mod.type, col: surfaceCol, row: desk.row })
    counts.set(mod.id, (counts.get(mod.id) || 0) + 1)
    surfaceCount++
  }
}

// ── Public API ───────────────────────────────────────────────

/**
 * Full room decoration: place required furniture + WFC decorations.
 * Returns all furniture, seat UIDs, and activity spots for the room.
 */
export function decorateProjectRoom(
  bounds: RoomBounds,
  seed?: number,
): { furniture: PlacedFurniture[]; seatUids: string[]; activitySpots: ActivitySpot[] } {
  // Phase 1: Place required desks + chairs (WFC-style varied placement)
  const required = placeRequiredFurniture(bounds, seed)

  // Phase 2: WFC decoration fills remaining space
  const decoration = decorateRoom(bounds, required.placed, seed)

  return {
    furniture: [...required.furniture, ...decoration.furniture],
    seatUids: required.seatUids,
    activitySpots: [...required.activitySpots, ...decoration.activitySpots],
  }
}
