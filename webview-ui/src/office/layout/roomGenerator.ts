import { TileType, FurnitureType, Direction } from '../types.js'
import type { TileType as TileTypeVal, OfficeLayout, PlacedFurniture, FloorColor, ActivitySpot } from '../types.js'
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
): void {
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

      if (isDoorWall) {
        const doorCol = Math.floor(roomWidth / 2)
        if (c === doorCol) {
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

/** Place desks, chairs, and activity props inside a project room */
function placeProjectRoomFurniture(
  furniture: PlacedFurniture[],
  spec: RoomSpec,
  roomCol: number,
  roomRow: number,
  doorSide: 'top' | 'bottom',
): { seatUids: string[]; activitySpots: ActivitySpot[] } {
  const seatUids: string[] = []
  const activitySpots: ActivitySpot[] = []

  // Props row is just inside the door-side wall (near entrance)
  const propsRow = doorSide === 'bottom' ? roomRow + 1 : roomRow + 1

  // Desks and chairs fill from the far end (opposite door) inward
  const startCol = roomCol + 2 // skip wall + 1 padding
  let chairGlobalIdx = 0
  for (let dr = 0; dr < spec.deskRows; dr++) {
    let deskBaseRow: number
    let chairRow: number
    if (doorSide === 'bottom') {
      // Door on bottom → props at top, desks below props, chairs below desks
      deskBaseRow = roomRow + 2 + dr * 3
      chairRow = deskBaseRow + 2
    } else {
      // Door on top → props at top, desks from bottom upward, chairs above desks
      // -4 leaves 1 row for chair + 1 row for bottom wall
      deskBaseRow = roomRow + spec.roomHeight - 4 - dr * 3
      chairRow = deskBaseRow - 1
    }

    const desksInThisRow = dr < spec.deskRows - 1
      ? spec.desksPerRow
      : spec.deskCount - dr * spec.desksPerRow

    for (let dp = 0; dp < desksInThisRow; dp++) {
      const deskCol = startCol + dp * 3
      const deskIdx = dr * spec.desksPerRow + dp

      furniture.push({
        uid: `${spec.name}:desk-${deskIdx}`,
        type: FurnitureType.DESK,
        col: deskCol,
        row: deskBaseRow,
      })

      const chairsForThisDesk = Math.min(2, spec.seatCount - chairGlobalIdx)
      for (let ci = 0; ci < chairsForThisDesk; ci++) {
        const chairUid = `${spec.name}:chair-${chairGlobalIdx}`
        furniture.push({
          uid: chairUid,
          type: FurnitureType.CHAIR,
          col: deskCol + ci,
          row: chairRow,
        })
        seatUids.push(chairUid)
        chairGlobalIdx++
      }
    }
  }

  // Bookshelf at left wall interior (on props row)
  furniture.push({
    uid: `${spec.name}:bookshelf`,
    type: FurnitureType.BOOKSHELF,
    col: roomCol + 1,
    row: propsRow,
  })
  activitySpots.push({
    uid: `${spec.name}:bookshelf-spot-0`,
    toolCategory: 'file_research',
    standCol: roomCol + 1,
    standRow: propsRow + 2,
    facingDir: Direction.UP,
    occupiedBy: null,
  })
  activitySpots.push({
    uid: `${spec.name}:bookshelf-spot-1`,
    toolCategory: 'file_research',
    standCol: roomCol + 2,
    standRow: propsRow,
    facingDir: Direction.LEFT,
    occupiedBy: null,
  })

  // PC at right wall interior (on props row)
  furniture.push({
    uid: `${spec.name}:pc`,
    type: FurnitureType.PC,
    col: roomCol + spec.roomWidth - 2,
    row: propsRow,
  })
  activitySpots.push({
    uid: `${spec.name}:pc-spot-0`,
    toolCategory: 'web_research',
    standCol: roomCol + spec.roomWidth - 3,
    standRow: propsRow,
    facingDir: Direction.RIGHT,
    occupiedBy: null,
  })
  activitySpots.push({
    uid: `${spec.name}:pc-spot-1`,
    toolCategory: 'web_research',
    standCol: roomCol + spec.roomWidth - 2,
    standRow: propsRow + 1,
    facingDir: Direction.UP,
    occupiedBy: null,
  })

  // Whiteboard on the wall opposite the door (mounted on wall, or 1 inside for bottom)
  const wallRow = doorSide === 'bottom' ? roomRow : roomRow + spec.roomHeight - 2
  const wbCol = roomCol + Math.floor(spec.roomWidth / 2) - 1
  furniture.push({
    uid: `${spec.name}:whiteboard`,
    type: FurnitureType.WHITEBOARD,
    col: wbCol,
    row: wallRow,
  })
  const wbStandRow = doorSide === 'bottom' ? wallRow + 1 : wallRow - 1
  const wbFacingDir = doorSide === 'bottom' ? Direction.UP : Direction.DOWN
  activitySpots.push({
    uid: `${spec.name}:whiteboard-spot-0`,
    toolCategory: 'planning',
    standCol: wbCol,
    standRow: wbStandRow,
    facingDir: wbFacingDir,
    occupiedBy: null,
  })
  activitySpots.push({
    uid: `${spec.name}:whiteboard-spot-1`,
    toolCategory: 'planning',
    standCol: wbCol + 1,
    standRow: wbStandRow,
    facingDir: wbFacingDir,
    occupiedBy: null,
  })

  return { seatUids, activitySpots }
}

// ── Main generator ───────────────────────────────────────────

export function generateRoomLayout(
  projects: Array<{ name: string; agentCount: number }>,
  liveAgentCount?: number,
): GeneratedLayout {
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
    const interiorWidth = Math.max(ROOM_MIN_INTERIOR_WIDTH, 2 + desksPerRow * 3)
    const roomWidth = interiorWidth + 2
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

  // ── Garage dimensions ───────────────────────────────────────
  const carCount = liveAgentCount ?? projects.reduce((sum, p) => sum + p.agentCount, 0)
  const garageInteriorHeight = 1 + carCount * GARAGE_CAR_SLOT_HEIGHT
  const garageHeight = Math.max(ROOM_HEIGHT, garageInteriorHeight + 2)
  // Garage shares wall with first room: offset = GARAGE_WIDTH - 1
  const garageColOffset = GARAGE_WIDTH - 1

  // ── Layout dimensions ───────────────────────────────────────
  // Adjacent rooms share walls: each additional room adds (width - 1) columns
  const sharedWallTotal = (specs: { roomWidth?: number; width?: number }[]) =>
    specs.length === 0 ? 0 : specs.reduce((sum, r) => sum + ((r.roomWidth ?? r.width ?? 0) - 1), 0) + 1

  const topRowStart = ROOM_LABEL_ROWS
  const corridorRow = topRowStart + maxTopHeight
  const bottomRowStart = corridorRow + CORRIDOR_HEIGHT

  const topColsTotal = sharedWallTotal(topSpecs)
  const bottomProjectCols = sharedWallTotal(bottomSpecs)
  const specialColsTotal = sharedWallTotal(specialWidths.map(w => ({ width: w })))
  // Bottom project rooms share wall with first special room
  const bottomColsTotal = bottomProjectCols > 0
    ? bottomProjectCols + specialColsTotal - 1
    : specialColsTotal

  const rightSideCols = Math.max(topColsTotal, bottomColsTotal)
  const totalCols = garageColOffset + rightSideCols

  const totalRowsBase = bottomRowStart + maxBottomHeight
  const garageTopRow = ROOM_LABEL_ROWS
  const garageTotalHeight = ROOM_LABEL_ROWS + garageHeight
  const totalRows = Math.max(totalRowsBase, garageTotalHeight)

  // ── Initialize tiles ────────────────────────────────────────
  const tiles: TileTypeVal[] = new Array(totalRows * totalCols).fill(TileType.VOID)
  const tileColors: Array<FloorColor | null> = new Array(totalRows * totalCols).fill(null)
  const furniture: PlacedFurniture[] = []
  const rooms: RoomInfo[] = []

  // ── Garage ──────────────────────────────────────────────────
  fillRoomTiles(tiles, tileColors, totalCols, 0, garageTopRow, GARAGE_WIDTH, garageHeight, GARAGE_FLOOR_COLOR, 'bottom')

  const carTypes = [
    FurnitureType.PORSCHE, FurnitureType.LAMBO, FurnitureType.FERRARI,
    FurnitureType.MULTIPLA, FurnitureType.MASSERATI, FurnitureType.RANGE_ROVER,
  ]
  for (let i = 0; i < carCount; i++) {
    const carType = carTypes[Math.floor(Math.random() * carTypes.length)]
    furniture.push({
      uid: `garage:car-${i}`,
      type: carType,
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
    const { seatUids, activitySpots } = placeProjectRoomFurniture(furniture, extendedSpec, roomCol, topRowStart, 'bottom')

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
    const { seatUids, activitySpots } = placeProjectRoomFurniture(furniture, extendedSpec, roomCol, bottomRowStart, 'top')

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

  // Conference table
  const tableCol = confCol + 2
  const tableRow = bottomRowStart + 2
  furniture.push({ uid: 'conference:desk-0', type: FurnitureType.DESK, col: tableCol, row: tableRow })
  furniture.push({ uid: 'conference:desk-1', type: FurnitureType.DESK, col: tableCol + 2, row: tableRow })

  const confSpots: ActivitySpot[] = []
  const spotPositions = [
    { col: tableCol, row: bottomRowStart + 1, dir: Direction.DOWN },
    { col: tableCol + 3, row: bottomRowStart + 1, dir: Direction.DOWN },
    { col: tableCol, row: bottomRowStart + 4, dir: Direction.UP },
    { col: tableCol + 3, row: bottomRowStart + 4, dir: Direction.UP },
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

  // Whiteboard on bottom wall (opposite door which is on top)
  const confWbCol = confCol + Math.floor(CONFERENCE_ROOM_WIDTH / 2) - 1
  furniture.push({ uid: 'conference:whiteboard', type: FurnitureType.WHITEBOARD, col: confWbCol, row: bottomRowStart + confHeight - 1 })

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

  // ── Filler rooms (fill shorter side gaps) ───────────────────
  // topColOffset / bottomColOffset point to the next free column (shared wall col)
  // We want to extend the shorter side to match the longer side
  const topEnd = topColOffset
  const bottomEnd = bottomColOffset
  const maxEnd = Math.max(topEnd, bottomEnd)

  const fillerDefs = [
    { name: KITCHEN_ROOM_NAME, width: KITCHEN_ROOM_WIDTH, color: KITCHEN_FLOOR_COLOR, items: [FurnitureType.COOLER, FurnitureType.PLANT] },
    { name: SERVER_ROOM_NAME, width: SERVER_ROOM_WIDTH, color: SERVER_FLOOR_COLOR, items: [FurnitureType.PC, FurnitureType.CRATE] },
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
