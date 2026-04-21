import { TileType, FurnitureType, Direction } from '../types.js'
import type { TileType as TileTypeVal, OfficeLayout, PlacedFurniture, FloorColor, ActivitySpot } from '../types.js'
import { decorateProjectRoom } from './wfcRoomDecorator.js'
import type { RoomBounds } from './wfcRoomDecorator.js'
import {
  ROOM_HEIGHT,
  ROOM_LABEL_ROWS,
  ROOM_MIN_SEATS,
  ROOM_EXTRA_SEATS,
  ROOM_MIN_INTERIOR_WIDTH,
  ROOM_MAX_DESKS_PER_ROW,
  ROOM_FLOOR_COLOR,
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

export interface RoomInfo {
  projectName: string
  col: number
  row: number
  width: number
  height: number
  seatUids: string[]
  activitySpots: ActivitySpot[]
  /** Whether this is the shared conference room */
  isConferenceRoom?: boolean
  /** Whether this is the garage */
  isGarage?: boolean
  /** Whether this is the foreman's office */
  isForeman?: boolean
  /** Whether this is the art director's office */
  isArtDirector?: boolean
  /** Whether this is a decorative filler room (kitchen, server room, etc.) */
  isFiller?: boolean
}

export interface GeneratedLayout {
  layout: OfficeLayout
  rooms: RoomInfo[]
}

// ── Helpers ──────────────────────────────────────────────────

interface RoomSpec {
  name: string
  seatCount: number
  deskCount: number
  deskRows: number
  desksPerRow: number
  interiorWidth: number
  roomWidth: number
  roomHeight: number
}

/** Fill wall + floor tiles for a rectangular room with a doorway */
function fillRoomTiles(
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
function placeProjectRoomFurniture(
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

// ── Layout seed cache ────────────────────────────────────────
// The decoration seed is randomized once and reused until the room config changes.
let cachedLayoutSeed = Math.floor(Math.random() * 2147483647)
let cachedConfigKey = ''

/** Build a string key that changes when room config changes (projects, sizes) */
function buildConfigKey(projects: Array<{ name: string; agentCount: number }>): string {
  return projects.map(p => `${p.name}:${p.agentCount}`).join(',')
}

// ── Main generator ───────────────────────────────────────────

export function generateRoomLayout(
  projects: Array<{ name: string; agentCount: number }>,
  agentCarTypes?: string[],
): GeneratedLayout {
  // Only regenerate seed when room config actually changes
  const configKey = buildConfigKey(projects)
  if (configKey !== cachedConfigKey) {
    cachedLayoutSeed = Math.floor(Math.random() * 2147483647)
    cachedConfigKey = configKey
  }
  const layoutSeed = cachedLayoutSeed

  if (projects.length === 0) {
    return {
      layout: {
        version: 1,
        cols: 1,
        rows: ROOM_LABEL_ROWS + ROOM_HEIGHT,
        tiles: new Array(ROOM_LABEL_ROWS + ROOM_HEIGHT).fill(TileType.VOID),
        furniture: [],
        tileColors: new Array(ROOM_LABEL_ROWS + ROOM_HEIGHT).fill(null),
      },
      rooms: [],
    }
  }

  // ── Compute room specs ──────────────────────────────────────
  const roomSpecs: RoomSpec[] = projects.map((p) => {
    const seatCount = Math.max(p.agentCount + ROOM_EXTRA_SEATS, ROOM_MIN_SEATS)
    const deskCount = Math.ceil(seatCount / 2)
    const deskRows = Math.ceil(deskCount / ROOM_MAX_DESKS_PER_ROW)
    const desksPerRow = Math.ceil(deskCount / deskRows)
    // DESK_FRONT = 3 wide; each desk slot = 4 cols (3 desk + 1 gap)
    const interiorWidth = Math.max(ROOM_MIN_INTERIOR_WIDTH, 2 + desksPerRow * 4)
    const roomWidth = interiorWidth + 2
    // Each desk row = 3 tiles: 2 desk + 1 chair
    const interiorHeight = 1 + deskRows * 3
    const roomHeight = Math.max(ROOM_HEIGHT, interiorHeight + 2)
    return { name: p.name, seatCount, deskCount, deskRows, desksPerRow, interiorWidth, roomWidth, roomHeight }
  })

  // ── Assign rooms to top/bottom sides ────────────────────────
  // Project rooms alternate top/bottom, sorted alphabetically
  const topSpecs: RoomSpec[] = []
  const bottomSpecs: RoomSpec[] = []
  for (let i = 0; i < roomSpecs.length; i++) {
    if (i % 2 === 0) topSpecs.push(roomSpecs[i])
    else bottomSpecs.push(roomSpecs[i])
  }

  // Special rooms go at end of bottom row
  const specialWidths = [CONFERENCE_ROOM_WIDTH, FOREMAN_ROOM_WIDTH, ART_DIRECTOR_ROOM_WIDTH]

  // ── Extend rooms to align with corridor ─────────────────────
  const maxTopHeight = topSpecs.length > 0 ? Math.max(...topSpecs.map(r => r.roomHeight)) : ROOM_HEIGHT
  const maxBottomHeight = bottomSpecs.length > 0
    ? Math.max(...bottomSpecs.map(r => r.roomHeight), ROOM_HEIGHT)
    : ROOM_HEIGHT

  // ── Layout dimensions (compute first so garage can match full height) ──
  const topRowStart = ROOM_LABEL_ROWS
  const corridorRow = topRowStart + maxTopHeight
  const bottomRowStart = corridorRow + CORRIDOR_HEIGHT

  // Adjacent rooms share walls: each additional room adds (width - 1) columns
  const sharedWallTotal = (specs: { roomWidth?: number; width?: number }[]) =>
    specs.length === 0 ? 0 : specs.reduce((sum, r) => sum + ((r.roomWidth ?? r.width ?? 0) - 1), 0) + 1

  const topColsTotal = sharedWallTotal(topSpecs)
  const bottomProjectCols = sharedWallTotal(bottomSpecs)
  const specialColsTotal = sharedWallTotal(specialWidths.map(w => ({ width: w })))
  const bottomColsTotal = bottomProjectCols > 0
    ? bottomProjectCols + specialColsTotal - 1
    : specialColsTotal

  const rightSideCols = Math.max(topColsTotal, bottomColsTotal)

  // ── Garage dimensions ───────────────────────────────────────
  const garageTopRow = topRowStart
  const carTypes = agentCarTypes ?? []
  const carCount = carTypes.length
  // Garage spans the full office height (top rooms + corridor + bottom rooms)
  const fullOfficeHeight = bottomRowStart + maxBottomHeight - topRowStart
  const garageHeight = Math.max(fullOfficeHeight, ROOM_HEIGHT)
  const garageColOffset = GARAGE_WIDTH - 1

  const totalCols = garageColOffset + rightSideCols
  const totalRows = topRowStart + garageHeight

  // ── Initialize tiles ────────────────────────────────────────
  const tiles: TileTypeVal[] = new Array(totalRows * totalCols).fill(TileType.VOID)
  const tileColors: Array<FloorColor | null> = new Array(totalRows * totalCols).fill(null)
  const furniture: PlacedFurniture[] = []
  const rooms: RoomInfo[] = []

  // ── Garage ──────────────────────────────────────────────────
  // Door on right wall at corridor level so agents can walk between garage and hallway
  const corridorDoorRows: Array<{ side: 'left' | 'right'; row: number }> = []
  for (let r = 0; r < CORRIDOR_HEIGHT; r++) {
    corridorDoorRows.push({ side: 'right', row: corridorRow - garageTopRow + r })
  }
  fillRoomTiles(tiles, tileColors, totalCols, 0, garageTopRow, GARAGE_WIDTH, garageHeight, GARAGE_FLOOR_COLOR, 'bottom', 3, corridorDoorRows)

  for (let i = 0; i < carCount; i++) {
    furniture.push({
      uid: `garage:car-${i}`,
      type: carTypes[i],
      col: 1,
      row: garageTopRow + 2 + i * GARAGE_CAR_SLOT_HEIGHT,
    })
  }

  rooms.push({
    projectName: GARAGE_ROOM_NAME,
    col: 0,
    row: garageTopRow,
    width: GARAGE_WIDTH,
    height: garageHeight,
    seatUids: [],
    activitySpots: [],
    isGarage: true,
  })

  // ── Top-side project rooms ──────────────────────────────────
  let topColOffset = garageColOffset
  for (const spec of topSpecs) {
    const roomCol = topColOffset
    const extendedHeight = maxTopHeight
    fillRoomTiles(tiles, tileColors, totalCols, roomCol, topRowStart, spec.roomWidth, extendedHeight, ROOM_FLOOR_COLOR, 'bottom')

    const extendedSpec = { ...spec, roomHeight: extendedHeight }
    const { seatUids, activitySpots } = placeProjectRoomFurniture(furniture, extendedSpec, roomCol, topRowStart, 'bottom', layoutSeed)

    rooms.push({
      projectName: spec.name,
      col: roomCol,
      row: topRowStart,
      width: spec.roomWidth,
      height: extendedHeight,
      seatUids,
      activitySpots,
    })

    topColOffset += spec.roomWidth - 1 // share right wall with next room
  }

  // ── Bottom-side project rooms ───────────────────────────────
  let bottomColOffset = garageColOffset
  for (const spec of bottomSpecs) {
    const roomCol = bottomColOffset
    const extendedHeight = maxBottomHeight
    fillRoomTiles(tiles, tileColors, totalCols, roomCol, bottomRowStart, spec.roomWidth, extendedHeight, ROOM_FLOOR_COLOR, 'top')

    const extendedSpec = { ...spec, roomHeight: extendedHeight }
    const { seatUids, activitySpots } = placeProjectRoomFurniture(furniture, extendedSpec, roomCol, bottomRowStart, 'top', layoutSeed)

    rooms.push({
      projectName: spec.name,
      col: roomCol,
      row: bottomRowStart,
      width: spec.roomWidth,
      height: extendedHeight,
      seatUids,
      activitySpots,
    })

    bottomColOffset += spec.roomWidth - 1 // share right wall with next room
  }

  // ── Special rooms (bottom side, after project rooms) ────────
  // Conference Room — shares wall with last bottom project room
  const confCol = bottomColOffset
  const confHeight = ROOM_HEIGHT
  fillRoomTiles(tiles, tileColors, totalCols, confCol, bottomRowStart, CONFERENCE_ROOM_WIDTH, confHeight, CONFERENCE_FLOOR_COLOR, 'top')

  // Whiteboard on top wall (wall-mounted at row-1 for correct z-sort)
  const confWbCol = confCol + Math.floor(CONFERENCE_ROOM_WIDTH / 2) - 1
  furniture.push({ uid: 'conference:whiteboard', type: FurnitureType.WHITEBOARD, col: confWbCol, row: bottomRowStart - 1 })

  // Conference table (centered, row 3-4)
  const tableCol = confCol + 2
  const tableRow = bottomRowStart + 3
  furniture.push({ uid: 'conference:desk-0', type: FurnitureType.DESK, col: tableCol, row: tableRow })

  // Chairs around the table: 2 north-facing above, 2 south-facing below
  furniture.push({ uid: 'conference:chair-n0', type: FurnitureType.WOODEN_CHAIR_FRONT, col: tableCol, row: tableRow - 1 })
  furniture.push({ uid: 'conference:chair-n1', type: FurnitureType.WOODEN_CHAIR_FRONT, col: tableCol + 1, row: tableRow - 1 })
  furniture.push({ uid: 'conference:chair-s0', type: FurnitureType.WOODEN_CHAIR_BACK, col: tableCol, row: tableRow + 1 })
  furniture.push({ uid: 'conference:chair-s1', type: FurnitureType.WOODEN_CHAIR_BACK, col: tableCol + 1, row: tableRow + 1 })

  // Plants in corners
  furniture.push({ uid: 'conference:plant-0', type: FurnitureType.PLANT, col: confCol + 1, row: bottomRowStart })
  furniture.push({ uid: 'conference:plant-1', type: FurnitureType.PLANT_2, col: confCol + CONFERENCE_ROOM_WIDTH - 2, row: bottomRowStart })

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

  rooms.push({
    projectName: CONFERENCE_ROOM_NAME,
    col: confCol,
    row: bottomRowStart,
    width: CONFERENCE_ROOM_WIDTH,
    height: confHeight,
    seatUids: [],
    activitySpots: confSpots,
    isConferenceRoom: true,
  })

  bottomColOffset = confCol + CONFERENCE_ROOM_WIDTH - 1

  // Foreman's Office (Darryl)
  const fmCol = bottomColOffset
  fillRoomTiles(tiles, tileColors, totalCols, fmCol, bottomRowStart, FOREMAN_ROOM_WIDTH, ROOM_HEIGHT, FOREMAN_FLOOR_COLOR, 'top')

  furniture.push({ uid: 'foreman:desk-0', type: FurnitureType.DESK, col: fmCol + 3, row: bottomRowStart + 1 })
  furniture.push({ uid: 'foreman:chair-0', type: FurnitureType.CHAIR, col: fmCol + 3, row: bottomRowStart + 3 })
  furniture.push({ uid: 'foreman:bookshelf', type: FurnitureType.BOOKSHELF, col: fmCol + 1, row: bottomRowStart + 1 })
  furniture.push({ uid: 'foreman:plant', type: FurnitureType.PLANT, col: fmCol + 6, row: bottomRowStart + 1 })
  furniture.push({ uid: 'foreman:bin', type: FurnitureType.BIN, col: fmCol + 1, row: bottomRowStart + 4 })

  rooms.push({
    projectName: FOREMAN_ROOM_NAME,
    col: fmCol,
    row: bottomRowStart,
    width: FOREMAN_ROOM_WIDTH,
    height: ROOM_HEIGHT,
    seatUids: [],
    activitySpots: [],
    isForeman: true,
  })

  bottomColOffset = fmCol + FOREMAN_ROOM_WIDTH - 1

  // Art Director's Office (Jan)
  const adCol = bottomColOffset
  fillRoomTiles(tiles, tileColors, totalCols, adCol, bottomRowStart, ART_DIRECTOR_ROOM_WIDTH, ROOM_HEIGHT, ART_DIRECTOR_FLOOR_COLOR, 'top')

  furniture.push({ uid: 'artdirector:desk-0', type: FurnitureType.DESK, col: adCol + 3, row: bottomRowStart + 1 })
  furniture.push({ uid: 'artdirector:chair-0', type: FurnitureType.CHAIR, col: adCol + 3, row: bottomRowStart + 3 })
  furniture.push({ uid: 'artdirector:chair-1', type: FurnitureType.CHAIR, col: adCol + 4, row: bottomRowStart + 3 })
  furniture.push({ uid: 'artdirector:bookshelf', type: FurnitureType.BOOKSHELF, col: adCol + 1, row: bottomRowStart + 1 })
  furniture.push({ uid: 'artdirector:cactus', type: FurnitureType.CACTUS, col: adCol + 6, row: bottomRowStart + 1 })
  furniture.push({ uid: 'artdirector:coffee', type: FurnitureType.COFFEE, col: adCol + 1, row: bottomRowStart + 4 })

  rooms.push({
    projectName: ART_DIRECTOR_ROOM_NAME,
    col: adCol,
    row: bottomRowStart,
    width: ART_DIRECTOR_ROOM_WIDTH,
    height: ROOM_HEIGHT,
    seatUids: [],
    activitySpots: [],
    isArtDirector: true,
  })

  bottomColOffset = adCol + ART_DIRECTOR_ROOM_WIDTH - 1

  // ── Central corridor ────────────────────────────────────────
  // Runs from garage edge to the rightmost room edge
  const corridorStart = garageColOffset
  const corridorEnd = totalCols
  for (let r = 0; r < CORRIDOR_HEIGHT; r++) {
    for (let c = corridorStart; c < corridorEnd; c++) {
      const idx = (corridorRow + r) * totalCols + c
      if (idx >= 0 && idx < tiles.length) {
        tiles[idx] = TileType.FLOOR_1
        tileColors[idx] = CORRIDOR_FLOOR_COLOR
      }
    }
  }

  // ── East wall at end of corridor (with door) ────────────────
  const eastWallCol = totalCols - 1
  for (let r = 0; r < CORRIDOR_HEIGHT; r++) {
    const idx = (corridorRow + r) * totalCols + eastWallCol
    if (idx >= 0 && idx < tiles.length) {
      // Middle tile(s) are a door
      if (r === Math.floor(CORRIDOR_HEIGHT / 2)) {
        tiles[idx] = TileType.FLOOR_1
        tileColors[idx] = CORRIDOR_FLOOR_COLOR
      } else {
        tiles[idx] = TileType.WALL
        tileColors[idx] = DEFAULT_WALL_COLOR
      }
    }
  }

  // ── Top-right rest space enclosure ─────────────────────────
  // Right wall from top row down to corridor
  for (let r = topRowStart; r < corridorRow; r++) {
    const idx = r * totalCols + (totalCols - 1)
    if (idx >= 0 && idx < tiles.length && tiles[idx] === TileType.VOID) {
      tiles[idx] = TileType.WALL
      tileColors[idx] = DEFAULT_WALL_COLOR
    }
  }

  // ── Corridor plants (rare, never blocking entrances) ────────
  // Collect all door columns so we know what to avoid
  const doorCols = new Set<number>()
  for (const room of rooms) {
    doorCols.add(room.col + Math.floor(room.width / 2))
  }
  // Also block columns adjacent to doors so characters can walk in/out comfortably
  const blockedCols = new Set<number>()
  for (const dc of doorCols) {
    blockedCols.add(dc - 1)
    blockedCols.add(dc)
    blockedCols.add(dc + 1)
  }

  const corridorPlantTypes = [FurnitureType.PLANT, FurnitureType.PLANT_2, FurnitureType.CACTUS]
  // Place roughly 1 plant per 10 corridor tiles, minimum spacing of 6 apart
  const corridorLength = corridorEnd - corridorStart
  const maxCorridorPlants = Math.max(1, Math.floor(corridorLength / 10))
  let corridorPlantsPlaced = 0
  let lastPlantCol = -Infinity
  // Simple deterministic hash per column for pseudo-random placement
  for (let c = corridorStart + 1; c < corridorEnd - 1; c++) {
    if (corridorPlantsPlaced >= maxCorridorPlants) break
    if (blockedCols.has(c)) continue
    if (c - lastPlantCol < 6) continue
    // Deterministic pseudo-random: hash the column index
    const hash = ((c * 2654435761) >>> 0) % 100
    if (hash > 20) continue // ~20% chance per eligible tile

    const plantType = corridorPlantTypes[hash % corridorPlantTypes.length]
    furniture.push({
      uid: `corridor:plant-${corridorPlantsPlaced}`,
      type: plantType,
      col: c,
      row: corridorRow - 1, // bg row in wall area, blocking row in top corridor row
    })
    lastPlantCol = c
    corridorPlantsPlaced++
  }

  // ── Filler rooms (fill gaps up to the east wall) ────────────
  // topColOffset / bottomColOffset point to the next free column (shared wall col)
  // Extend both sides to the full width so there's no empty space
  const topEnd = topColOffset
  const bottomEnd = bottomColOffset
  const maxEnd = totalCols

  const fillerDefs = [
    { name: KITCHEN_ROOM_NAME, width: KITCHEN_ROOM_WIDTH, color: KITCHEN_FLOOR_COLOR, items: [FurnitureType.COFFEE, FurnitureType.PLANT_2] },
    { name: SERVER_ROOM_NAME, width: SERVER_ROOM_WIDTH, color: SERVER_FLOOR_COLOR, items: [FurnitureType.PC, FurnitureType.CACTUS] },
  ]

  // Place filler rooms on the shorter side, sharing walls
  function placeFillers(col: number, targetEnd: number, rowStart: number, height: number, doorSide: 'top' | 'bottom'): void {
    let fillerIdx = 0
    while (col < targetEnd && fillerIdx < fillerDefs.length) {
      const filler = fillerDefs[fillerIdx]
      // Use available space, capped by filler width
      const available = targetEnd - col + 1 // +1 because we share the wall at targetEnd
      if (available < 4) break // too small for a room (min 3 interior + 1 wall)
      const w = Math.min(filler.width, available)
      fillRoomTiles(tiles, tileColors, totalCols, col, rowStart, w, height, filler.color, doorSide)
      for (let fi = 0; fi < filler.items.length && fi < w - 2; fi++) {
        furniture.push({
          uid: `filler-${filler.name}:item-${fi}`,
          type: filler.items[fi],
          col: col + 1 + fi,
          row: doorSide === 'bottom' ? rowStart + 1 : rowStart + height - 2,
        })
      }
      rooms.push({
        projectName: filler.name,
        col,
        row: rowStart,
        width: w,
        height,
        seatUids: [],
        activitySpots: [],
        isFiller: true,
      })
      col += w - 1 // share wall
      fillerIdx++
    }
  }

  if (topEnd < maxEnd) {
    placeFillers(topEnd, maxEnd, topRowStart, maxTopHeight, 'bottom')
  }
  if (bottomEnd < maxEnd) {
    placeFillers(bottomEnd, maxEnd, bottomRowStart, maxBottomHeight, 'top')
  }

  return {
    layout: {
      version: 1,
      cols: totalCols,
      rows: totalRows,
      tiles,
      furniture,
      tileColors,
    },
    rooms,
  }
}
