import { TileType, FurnitureType, Direction } from '../types.js'
import type { TileType as TileTypeVal, PlacedFurniture, FloorColor, ActivitySpot } from '../types.js'
import { decorateProjectRoom } from './wfcRoomDecorator.js'
import type { RoomBounds } from './wfcRoomDecorator.js'
import type { RoomInfo, RoomSpec } from './roomGenerator.js'
import {
  ROOM_HEIGHT,
  DEFAULT_WALL_COLOR,
  CONFERENCE_ROOM_NAME,
  CONFERENCE_ROOM_WIDTH,
  CONFERENCE_ROOM_SPOTS,
  CONFERENCE_FLOOR_COLOR,
  GARAGE_ROOM_NAME,
  GARAGE_WIDTH,
  GARAGE_FLOOR_COLOR,
  GARAGE_CAR_SLOT_HEIGHT,
  FOREMAN_ROOM_NAME,
  FOREMAN_ROOM_WIDTH,
  FOREMAN_FLOOR_COLOR,
  ART_DIRECTOR_ROOM_NAME,
  ART_DIRECTOR_ROOM_WIDTH,
  ART_DIRECTOR_FLOOR_COLOR,
  CORRIDOR_HEIGHT,
  CORRIDOR_FLOOR_COLOR,
  KITCHEN_ROOM_NAME,
  KITCHEN_ROOM_WIDTH,
  KITCHEN_FLOOR_COLOR,
  SERVER_ROOM_NAME,
  SERVER_ROOM_WIDTH,
  SERVER_FLOOR_COLOR,
} from '../../constants.js'

/** Fill wall + floor tiles for a rectangular room with a doorway */
export function fillRoomTiles(
  tiles: TileTypeVal[],
  tileColors: Array<FloorColor | null>,
  totalCols: number,
  roomCol: number,
  roomRow: number,
  roomWidth: number,
  roomHeight: number,
  floorColor: FloorColor,
  doorSide: 'top' | 'bottom',
  doorWidth = 1,
  /** Additional doors on other walls: { side, position (col or row offset) } */
  extraDoors?: Array<{ side: 'left' | 'right'; row: number }>,
): void {
  const doorStart = Math.floor(roomWidth / 2) - Math.floor(doorWidth / 2)
  const doorEnd = doorStart + doorWidth - 1

  for (let r = 0; r < roomHeight; r++) {
    for (let c = 0; c < roomWidth; c++) {
      const tileRow = roomRow + r
      const tileCol = roomCol + c
      const idx = tileRow * totalCols + tileCol

      const isTopWall = r === 0
      const isBottomWall = r === roomHeight - 1
      const isLeftWall = c === 0
      const isRightWall = c === roomWidth - 1

      const isDoorWall = doorSide === 'bottom' ? isBottomWall : isTopWall
      const isOppWall = doorSide === 'bottom' ? isTopWall : isBottomWall

      // Check extra doors on side walls
      let isExtraDoor = false
      if (extraDoors && (isLeftWall || isRightWall)) {
        const side = isLeftWall ? 'left' : 'right'
        isExtraDoor = extraDoors.some(d => d.side === side && d.row === r)
      }

      if (isExtraDoor) {
        tiles[idx] = TileType.FLOOR_1
        tileColors[idx] = floorColor
        continue
      }

      if (isDoorWall) {
        if (c >= doorStart && c <= doorEnd) {
          tiles[idx] = TileType.FLOOR_1
          tileColors[idx] = floorColor
        } else {
          tiles[idx] = TileType.WALL
          tileColors[idx] = DEFAULT_WALL_COLOR
        }
        continue
      }

      if (isOppWall || isLeftWall || isRightWall) {
        tiles[idx] = TileType.WALL
        tileColors[idx] = DEFAULT_WALL_COLOR
        continue
      }

      tiles[idx] = TileType.FLOOR_1
      tileColors[idx] = floorColor
    }
  }
}

/** Place desks, chairs, and decorative items inside a project room using WFC */
export function placeProjectRoomFurniture(
  furniture: PlacedFurniture[],
  spec: RoomSpec,
  roomCol: number,
  roomRow: number,
  doorSide: 'top' | 'bottom',
  layoutSeed: number,
): { seatUids: string[]; activitySpots: ActivitySpot[] } {
  const bounds: RoomBounds = {
    name: spec.name,
    roomCol,
    roomRow,
    roomWidth: spec.roomWidth,
    roomHeight: spec.roomHeight,
    doorSide,
    seatCount: spec.seatCount,
    deskCount: spec.deskCount,
    desksPerRow: spec.desksPerRow,
    deskRows: spec.deskRows,
  }

  const result = decorateProjectRoom(bounds, layoutSeed)
  furniture.push(...result.furniture)
  return { seatUids: result.seatUids, activitySpots: result.activitySpots }
}

export interface BuildContext {
  tiles: TileTypeVal[]
  tileColors: Array<FloorColor | null>
  furniture: PlacedFurniture[]
  rooms: RoomInfo[]
  totalCols: number
}

/** Garage spans the full office height. One car slot per agent car type. */
export function buildGarage(
  ctx: BuildContext,
  garageTopRow: number,
  garageHeight: number,
  corridorRow: number,
  carTypes: string[],
): void {
  // Door on right wall at corridor level so agents can walk between garage and hallway
  const corridorDoorRows: Array<{ side: 'left' | 'right'; row: number }> = []
  for (let r = 0; r < CORRIDOR_HEIGHT; r++) {
    corridorDoorRows.push({ side: 'right', row: corridorRow - garageTopRow + r })
  }
  fillRoomTiles(ctx.tiles, ctx.tileColors, ctx.totalCols, 0, garageTopRow, GARAGE_WIDTH, garageHeight, GARAGE_FLOOR_COLOR, 'bottom', 3, corridorDoorRows)

  for (let i = 0; i < carTypes.length; i++) {
    ctx.furniture.push({
      uid: `garage:car-${i}`,
      type: carTypes[i],
      col: 1,
      row: garageTopRow + 2 + i * GARAGE_CAR_SLOT_HEIGHT,
    })
  }

  ctx.rooms.push({
    projectName: GARAGE_ROOM_NAME,
    col: 0,
    row: garageTopRow,
    width: GARAGE_WIDTH,
    height: garageHeight,
    seatUids: [],
    activitySpots: [],
    isGarage: true,
  })
}

export function buildConferenceRoom(ctx: BuildContext, confCol: number, bottomRowStart: number): void {
  const confHeight = ROOM_HEIGHT
  fillRoomTiles(ctx.tiles, ctx.tileColors, ctx.totalCols, confCol, bottomRowStart, CONFERENCE_ROOM_WIDTH, confHeight, CONFERENCE_FLOOR_COLOR, 'top')

  // Whiteboard on top wall (wall-mounted at row-1 for correct z-sort)
  const confWbCol = confCol + Math.floor(CONFERENCE_ROOM_WIDTH / 2) - 1
  ctx.furniture.push({ uid: 'conference:whiteboard', type: FurnitureType.WHITEBOARD, col: confWbCol, row: bottomRowStart - 1 })

  // Conference table (centered, row 3-4)
  const tableCol = confCol + 2
  const tableRow = bottomRowStart + 3
  ctx.furniture.push({ uid: 'conference:desk-0', type: FurnitureType.DESK, col: tableCol, row: tableRow })

  // Chairs around the table: 2 north-facing above, 2 south-facing below
  ctx.furniture.push({ uid: 'conference:chair-n0', type: FurnitureType.WOODEN_CHAIR_FRONT, col: tableCol, row: tableRow - 1 })
  ctx.furniture.push({ uid: 'conference:chair-n1', type: FurnitureType.WOODEN_CHAIR_FRONT, col: tableCol + 1, row: tableRow - 1 })
  ctx.furniture.push({ uid: 'conference:chair-s0', type: FurnitureType.WOODEN_CHAIR_BACK, col: tableCol, row: tableRow + 1 })
  ctx.furniture.push({ uid: 'conference:chair-s1', type: FurnitureType.WOODEN_CHAIR_BACK, col: tableCol + 1, row: tableRow + 1 })

  // Plants in corners
  ctx.furniture.push({ uid: 'conference:plant-0', type: FurnitureType.PLANT, col: confCol + 1, row: bottomRowStart })
  ctx.furniture.push({ uid: 'conference:plant-1', type: FurnitureType.PLANT_2, col: confCol + CONFERENCE_ROOM_WIDTH - 2, row: bottomRowStart })

  const confSpots: ActivitySpot[] = []
  const spotPositions = [
    { col: tableCol, row: tableRow - 1, dir: Direction.DOWN },
    { col: tableCol + 2, row: tableRow - 1, dir: Direction.DOWN },
    { col: tableCol, row: tableRow + 2, dir: Direction.UP },
    { col: tableCol + 2, row: tableRow + 2, dir: Direction.UP },
  ]
  for (let i = 0; i < Math.min(CONFERENCE_ROOM_SPOTS, spotPositions.length); i++) {
    confSpots.push({
      uid: `conference:spot-${i}`,
      toolCategory: 'conference',
      standCol: spotPositions[i].col,
      standRow: spotPositions[i].row,
      facingDir: spotPositions[i].dir,
      occupiedBy: null,
    })
  }

  ctx.rooms.push({
    projectName: CONFERENCE_ROOM_NAME,
    col: confCol,
    row: bottomRowStart,
    width: CONFERENCE_ROOM_WIDTH,
    height: confHeight,
    seatUids: [],
    activitySpots: confSpots,
    isConferenceRoom: true,
  })
}

export function buildForemanOffice(ctx: BuildContext, fmCol: number, bottomRowStart: number): void {
  fillRoomTiles(ctx.tiles, ctx.tileColors, ctx.totalCols, fmCol, bottomRowStart, FOREMAN_ROOM_WIDTH, ROOM_HEIGHT, FOREMAN_FLOOR_COLOR, 'top')

  ctx.furniture.push({ uid: 'foreman:desk-0', type: FurnitureType.DESK, col: fmCol + 3, row: bottomRowStart + 1 })
  ctx.furniture.push({ uid: 'foreman:chair-0', type: FurnitureType.CHAIR, col: fmCol + 3, row: bottomRowStart + 3 })
  ctx.furniture.push({ uid: 'foreman:bookshelf', type: FurnitureType.BOOKSHELF, col: fmCol + 1, row: bottomRowStart + 1 })
  ctx.furniture.push({ uid: 'foreman:plant', type: FurnitureType.PLANT, col: fmCol + 6, row: bottomRowStart + 1 })
  ctx.furniture.push({ uid: 'foreman:bin', type: FurnitureType.BIN, col: fmCol + 1, row: bottomRowStart + 4 })

  ctx.rooms.push({
    projectName: FOREMAN_ROOM_NAME,
    col: fmCol,
    row: bottomRowStart,
    width: FOREMAN_ROOM_WIDTH,
    height: ROOM_HEIGHT,
    seatUids: [],
    activitySpots: [],
    isForeman: true,
  })
}

export function buildArtDirectorOffice(ctx: BuildContext, adCol: number, bottomRowStart: number): void {
  fillRoomTiles(ctx.tiles, ctx.tileColors, ctx.totalCols, adCol, bottomRowStart, ART_DIRECTOR_ROOM_WIDTH, ROOM_HEIGHT, ART_DIRECTOR_FLOOR_COLOR, 'top')

  ctx.furniture.push({ uid: 'artdirector:desk-0', type: FurnitureType.DESK, col: adCol + 3, row: bottomRowStart + 1 })
  ctx.furniture.push({ uid: 'artdirector:chair-0', type: FurnitureType.CHAIR, col: adCol + 3, row: bottomRowStart + 3 })
  ctx.furniture.push({ uid: 'artdirector:chair-1', type: FurnitureType.CHAIR, col: adCol + 4, row: bottomRowStart + 3 })
  ctx.furniture.push({ uid: 'artdirector:bookshelf', type: FurnitureType.BOOKSHELF, col: adCol + 1, row: bottomRowStart + 1 })
  ctx.furniture.push({ uid: 'artdirector:cactus', type: FurnitureType.CACTUS, col: adCol + 6, row: bottomRowStart + 1 })
  ctx.furniture.push({ uid: 'artdirector:coffee', type: FurnitureType.COFFEE, col: adCol + 1, row: bottomRowStart + 4 })

  ctx.rooms.push({
    projectName: ART_DIRECTOR_ROOM_NAME,
    col: adCol,
    row: bottomRowStart,
    width: ART_DIRECTOR_ROOM_WIDTH,
    height: ROOM_HEIGHT,
    seatUids: [],
    activitySpots: [],
    isArtDirector: true,
  })
}

/**
 * Build the central corridor (floor tiles, east wall with door, sparse decorative plants).
 * Also encloses any exposed void tiles between the last top-side room and the east wall.
 */
export function buildCorridor(
  ctx: BuildContext,
  corridorRow: number,
  corridorStart: number,
  corridorEnd: number,
  topRowStart: number,
): void {
  for (let r = 0; r < CORRIDOR_HEIGHT; r++) {
    for (let c = corridorStart; c < corridorEnd; c++) {
      const idx = (corridorRow + r) * ctx.totalCols + c
      if (idx >= 0 && idx < ctx.tiles.length) {
        ctx.tiles[idx] = TileType.FLOOR_1
        ctx.tileColors[idx] = CORRIDOR_FLOOR_COLOR
      }
    }
  }

  // ── East wall at end of corridor (with door) ────────────────
  const eastWallCol = ctx.totalCols - 1
  for (let r = 0; r < CORRIDOR_HEIGHT; r++) {
    const idx = (corridorRow + r) * ctx.totalCols + eastWallCol
    if (idx >= 0 && idx < ctx.tiles.length) {
      if (r === Math.floor(CORRIDOR_HEIGHT / 2)) {
        ctx.tiles[idx] = TileType.FLOOR_1
        ctx.tileColors[idx] = CORRIDOR_FLOOR_COLOR
      } else {
        ctx.tiles[idx] = TileType.WALL
        ctx.tileColors[idx] = DEFAULT_WALL_COLOR
      }
    }
  }

  // ── Top-right rest space enclosure ─────────────────────────
  for (let r = topRowStart; r < corridorRow; r++) {
    const idx = r * ctx.totalCols + (ctx.totalCols - 1)
    if (idx >= 0 && idx < ctx.tiles.length && ctx.tiles[idx] === TileType.VOID) {
      ctx.tiles[idx] = TileType.WALL
      ctx.tileColors[idx] = DEFAULT_WALL_COLOR
    }
  }

  // ── Corridor plants (rare, never blocking entrances) ────────
  const doorCols = new Set<number>()
  for (const room of ctx.rooms) {
    doorCols.add(room.col + Math.floor(room.width / 2))
  }
  const blockedCols = new Set<number>()
  for (const dc of doorCols) {
    blockedCols.add(dc - 1)
    blockedCols.add(dc)
    blockedCols.add(dc + 1)
  }

  const corridorPlantTypes = [FurnitureType.PLANT, FurnitureType.PLANT_2, FurnitureType.CACTUS]
  const corridorLength = corridorEnd - corridorStart
  const maxCorridorPlants = Math.max(1, Math.floor(corridorLength / 10))
  let corridorPlantsPlaced = 0
  let lastPlantCol = -Infinity
  for (let c = corridorStart + 1; c < corridorEnd - 1; c++) {
    if (corridorPlantsPlaced >= maxCorridorPlants) break
    if (blockedCols.has(c)) continue
    if (c - lastPlantCol < 6) continue
    // Deterministic pseudo-random: hash the column index
    const hash = ((c * 2654435761) >>> 0) % 100
    if (hash > 20) continue

    const plantType = corridorPlantTypes[hash % corridorPlantTypes.length]
    ctx.furniture.push({
      uid: `corridor:plant-${corridorPlantsPlaced}`,
      type: plantType,
      col: c,
      row: corridorRow - 1,
    })
    lastPlantCol = c
    corridorPlantsPlaced++
  }
}

const FILLER_DEFS = [
  { name: KITCHEN_ROOM_NAME, width: KITCHEN_ROOM_WIDTH, color: KITCHEN_FLOOR_COLOR, items: [FurnitureType.COFFEE, FurnitureType.PLANT_2] },
  { name: SERVER_ROOM_NAME, width: SERVER_ROOM_WIDTH, color: SERVER_FLOOR_COLOR, items: [FurnitureType.PC, FurnitureType.CACTUS] },
]

/** Fill any remaining corridor-adjacent gap on a given side with decorative rooms. */
export function placeFillers(
  ctx: BuildContext,
  col: number,
  targetEnd: number,
  rowStart: number,
  height: number,
  doorSide: 'top' | 'bottom',
): void {
  let fillerIdx = 0
  while (col < targetEnd && fillerIdx < FILLER_DEFS.length) {
    const filler = FILLER_DEFS[fillerIdx]
    const available = targetEnd - col + 1
    if (available < 4) break
    const w = Math.min(filler.width, available)
    fillRoomTiles(ctx.tiles, ctx.tileColors, ctx.totalCols, col, rowStart, w, height, filler.color, doorSide)
    for (let fi = 0; fi < filler.items.length && fi < w - 2; fi++) {
      ctx.furniture.push({
        uid: `filler-${filler.name}:item-${fi}`,
        type: filler.items[fi],
        col: col + 1 + fi,
        row: doorSide === 'bottom' ? rowStart + 1 : rowStart + height - 2,
      })
    }
    ctx.rooms.push({
      projectName: filler.name,
      col,
      row: rowStart,
      width: w,
      height,
      seatUids: [],
      activitySpots: [],
      isFiller: true,
    })
    col += w - 1
    fillerIdx++
  }
}
