/**
 * WFC room decorator — public API and required-furniture placement.
 *
 * Places required desks + chairs in fixed grid rows; decoration phases
 * (walls, lounge, plants, edge, surface) live in wfcDecorationPhases.ts.
 */

import { FurnitureType, Direction } from '../types.js'
import type { PlacedFurniture, ActivitySpot } from '../types.js'
import type { RoomBounds, PlacedCell, RequiredFurnitureResult, ChairSide } from './wfcTypes.js'
import { createRng, nameToSeed } from './wfcTypes.js'
import { getInterior } from './wfcPlacement.js'
import { decorateRoom } from './wfcDecorationPhases.js'

// Re-export types used by external consumers
export type { RoomBounds } from './wfcTypes.js'
export { decorateRoom } from './wfcDecorationPhases.js'

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
        // South chairs: character sits on the 2nd footprint tile (below desk, not inside it).
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
