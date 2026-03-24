import { TileType, FurnitureType, Direction } from '../types.js'
import type { TileType as TileTypeVal, OfficeLayout, PlacedFurniture, FloorColor, ActivitySpot } from '../types.js'
import {
  ROOM_HEIGHT,
  ROOM_LABEL_ROWS,
  ROOM_GAP_COLS,
  ROOM_GAP_ROWS,
  ROOM_MIN_SEATS,
  ROOM_EXTRA_SEATS,
  ROOM_MIN_INTERIOR_WIDTH,
  ROOM_FLOOR_COLOR,
  DEFAULT_WALL_COLOR,
  CONFERENCE_ROOM_NAME,
  CONFERENCE_ROOM_WIDTH,
  CONFERENCE_ROOM_SPOTS,
  CONFERENCE_FLOOR_COLOR,
  WAREHOUSE_ROOM_NAME,
  WAREHOUSE_MIN_WIDTH,
  WAREHOUSE_FLOOR_COLOR,
  WAREHOUSE_MIN_CRATES,
  GARAGE_ROOM_NAME,
  GARAGE_WIDTH,
  GARAGE_FLOOR_COLOR,
  GARAGE_CAR_SLOT_HEIGHT,
  FOREMAN_ROOM_NAME,
  FOREMAN_ROOM_WIDTH,
  FOREMAN_FLOOR_COLOR,
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
  /** Whether this is the warehouse */
  isWarehouse?: boolean
  /** Whether this is the garage */
  isGarage?: boolean
  /** Whether this is the foreman's office */
  isForeman?: boolean
}

export interface GeneratedLayout {
  layout: OfficeLayout
  rooms: RoomInfo[]
}

export function generateRoomLayout(
  projects: Array<{ name: string; agentCount: number }>,
): GeneratedLayout {
  if (projects.length === 0) {
    // Empty layout — no rooms
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

  // Calculate room dimensions
  const roomSpecs = projects.map((p) => {
    const seatCount = Math.max(p.agentCount + ROOM_EXTRA_SEATS, ROOM_MIN_SEATS)
    const deskPairs = Math.ceil(seatCount / 2)
    const interiorWidth = Math.max(ROOM_MIN_INTERIOR_WIDTH, 2 + deskPairs * 3)
    const roomWidth = interiorWidth + 2 // add walls
    return { name: p.name, seatCount, deskPairs, interiorWidth, roomWidth }
  })

  // Calculate warehouse dimensions based on total agents
  const totalAgents = projects.reduce((sum, p) => sum + p.agentCount, 0)
  const crateCount = Math.max(totalAgents, WAREHOUSE_MIN_CRATES)
  // Crates in 2 rows, with 1-tile padding on each side + walls
  const crateCols = Math.ceil(crateCount / 2)
  const warehouseInteriorWidth = Math.max(WAREHOUSE_MIN_WIDTH - 2, 2 + crateCols)
  const warehouseWidth = warehouseInteriorWidth + 2

  // ── Garage dimensions ──────────────────────────────────────────
  // One car per online agent, stacked vertically
  const carCount = totalAgents
  // Interior height: each car slot = GARAGE_CAR_SLOT_HEIGHT tiles, + 1 top padding
  const garageInteriorHeight = 1 + carCount * GARAGE_CAR_SLOT_HEIGHT
  const garageHeight = Math.max(ROOM_HEIGHT, garageInteriorHeight + 2) // +2 for top/bottom walls
  const garageColOffset = GARAGE_WIDTH + ROOM_GAP_COLS // shift other rooms right

  // Layout dimensions: project rooms on row 1, special rooms on row 2
  const row1Height = ROOM_LABEL_ROWS + ROOM_HEIGHT
  const row2Height = ROOM_LABEL_ROWS + ROOM_HEIGHT
  const baseRows = row1Height + ROOM_GAP_ROWS + row2Height
  // Garage may extend beyond the two-row layout
  const garageTopRow = ROOM_LABEL_ROWS
  const garageTotalHeight = ROOM_LABEL_ROWS + garageHeight
  const totalRows = Math.max(baseRows, garageTotalHeight)

  const projectColsTotal = roomSpecs.reduce((sum, r) => sum + r.roomWidth, 0) + ROOM_GAP_COLS * (roomSpecs.length - 1)
  const specialColsTotal = CONFERENCE_ROOM_WIDTH + ROOM_GAP_COLS + warehouseWidth + ROOM_GAP_COLS + FOREMAN_ROOM_WIDTH
  const rightSideCols = Math.max(projectColsTotal, specialColsTotal)
  const totalCols = garageColOffset + rightSideCols

  // Initialize tiles with VOID
  const tiles: TileTypeVal[] = new Array(totalRows * totalCols).fill(TileType.VOID)
  const tileColors: Array<FloorColor | null> = new Array(totalRows * totalCols).fill(null)
  const furniture: PlacedFurniture[] = []
  const rooms: RoomInfo[] = []

  // ── Garage ──────────────────────────────────────────────────────
  // Tall room on the left with one Porsche per online agent
  const garageCol = 0
  const garageRow = garageTopRow

  // Fill garage tiles
  for (let r = 0; r < garageHeight; r++) {
    for (let c = 0; c < GARAGE_WIDTH; c++) {
      const tileRow = garageRow + r
      const tileCol = garageCol + c
      if (tileRow >= totalRows || tileCol >= totalCols) continue
      const idx = tileRow * totalCols + tileCol

      const isTopWall = r === 0
      const isBottomWall = r === garageHeight - 1
      const isLeftWall = c === 0
      const isRightWall = c === GARAGE_WIDTH - 1

      // Bottom wall with wide door
      if (isBottomWall) {
        const doorCenter = Math.floor(GARAGE_WIDTH / 2)
        if (c === doorCenter || c === doorCenter - 1) {
          tiles[idx] = TileType.FLOOR_1
          tileColors[idx] = GARAGE_FLOOR_COLOR
        } else {
          tiles[idx] = TileType.WALL
          tileColors[idx] = DEFAULT_WALL_COLOR
        }
        continue
      }

      if (isTopWall || isLeftWall || isRightWall) {
        tiles[idx] = TileType.WALL
        tileColors[idx] = DEFAULT_WALL_COLOR
        continue
      }

      // Interior floor
      tiles[idx] = TileType.FLOOR_1
      tileColors[idx] = GARAGE_FLOOR_COLOR
    }
  }

  // Place one random car per agent, stacked vertically
  // All cars fit within the 5-tile interior (GARAGE_WIDTH - 2 walls)
  const carTypes = [
    FurnitureType.PORSCHE,
    FurnitureType.LAMBO,
    FurnitureType.FERRARI,
    FurnitureType.MULTIPLA,
    FurnitureType.MASSERATI,
    FurnitureType.RANGE_ROVER,
  ]
  for (let i = 0; i < carCount; i++) {
    const carType = carTypes[Math.floor(Math.random() * carTypes.length)]
    const carRow = garageRow + 1 + 1 + i * GARAGE_CAR_SLOT_HEIGHT // +1 wall, +1 top padding
    const carCol = garageCol + 1 // skip left wall
    furniture.push({
      uid: `garage:car-${i}`,
      type: carType,
      col: carCol,
      row: carRow,
    })
  }

  rooms.push({
    projectName: GARAGE_ROOM_NAME,
    col: garageCol,
    row: garageRow,
    width: GARAGE_WIDTH,
    height: garageHeight,
    seatUids: [],
    activitySpots: [],
    isGarage: true,
  })

  // ── Project Rooms ───────────────────────────────────────────────
  let colOffset = garageColOffset
  for (const spec of roomSpecs) {
    const roomCol = colOffset
    const roomRow = ROOM_LABEL_ROWS
    const seatUids: string[] = []

    // Fill room tiles
    for (let r = 0; r < ROOM_HEIGHT; r++) {
      for (let c = 0; c < spec.roomWidth; c++) {
        const tileRow = roomRow + r
        const tileCol = roomCol + c
        const idx = tileRow * totalCols + tileCol

        const isTopWall = r === 0
        const isBottomWall = r === ROOM_HEIGHT - 1
        const isLeftWall = c === 0
        const isRightWall = c === spec.roomWidth - 1

        // Bottom wall with doorway in the center
        if (isBottomWall) {
          const doorCol = Math.floor(spec.roomWidth / 2)
          if (c === doorCol) {
            tiles[idx] = TileType.FLOOR_1
            tileColors[idx] = ROOM_FLOOR_COLOR
          } else {
            tiles[idx] = TileType.WALL
            tileColors[idx] = DEFAULT_WALL_COLOR
          }
          continue
        }

        if (isTopWall || isLeftWall || isRightWall) {
          tiles[idx] = TileType.WALL
          tileColors[idx] = DEFAULT_WALL_COLOR
          continue
        }

        // Interior floor
        tiles[idx] = TileType.FLOOR_1
        tileColors[idx] = ROOM_FLOOR_COLOR
      }
    }

    // Place desks and chairs
    // Desks go in rows 2-3 (interior rows 1-2), chairs in row 4 (interior row 3)
    // Layout: wall | pad | desk desk gap desk desk gap ... | pad | wall
    const startCol = roomCol + 2 // skip wall + 1 padding
    for (let dp = 0; dp < spec.deskPairs; dp++) {
      const deskCol = startCol + dp * 3
      const deskRow = roomRow + 2 // rows 2-3 relative to room

      // Place 2x2 desk
      furniture.push({
        uid: `${spec.name}:desk-${dp}`,
        type: FurnitureType.DESK,
        col: deskCol,
        row: deskRow,
      })

      // Place 2 chairs below the desk (row 4 relative to room)
      const chairRow = roomRow + 4
      for (let ci = 0; ci < 2; ci++) {
        const chairCol = deskCol + ci
        const chairIdx = dp * 2 + ci
        if (chairIdx >= spec.seatCount) break
        const chairUid = `${spec.name}:chair-${chairIdx}`
        furniture.push({
          uid: chairUid,
          type: FurnitureType.CHAIR,
          col: chairCol,
          row: chairRow,
        })
        seatUids.push(chairUid)
      }
    }

    // Place activity props
    const activitySpots: ActivitySpot[] = []

    // BOOKSHELF (1x2) at left wall interior — replaces left plant
    furniture.push({
      uid: `${spec.name}:bookshelf`,
      type: FurnitureType.BOOKSHELF,
      col: roomCol + 1,
      row: roomRow + 1,
    })
    // Bookshelf activity spots: below it and to its right
    activitySpots.push({
      uid: `${spec.name}:bookshelf-spot-0`,
      toolCategory: 'file_research',
      standCol: roomCol + 1,
      standRow: roomRow + 3,
      facingDir: Direction.UP,
      occupiedBy: null,
    })
    activitySpots.push({
      uid: `${spec.name}:bookshelf-spot-1`,
      toolCategory: 'file_research',
      standCol: roomCol + 2,
      standRow: roomRow + 1,
      facingDir: Direction.LEFT,
      occupiedBy: null,
    })

    // PC (1x1) at right wall interior — replaces right plant
    furniture.push({
      uid: `${spec.name}:pc`,
      type: FurnitureType.PC,
      col: roomCol + spec.roomWidth - 2,
      row: roomRow + 1,
    })
    // PC activity spots: to its left and below it
    activitySpots.push({
      uid: `${spec.name}:pc-spot-0`,
      toolCategory: 'web_research',
      standCol: roomCol + spec.roomWidth - 3,
      standRow: roomRow + 1,
      facingDir: Direction.RIGHT,
      occupiedBy: null,
    })
    activitySpots.push({
      uid: `${spec.name}:pc-spot-1`,
      toolCategory: 'web_research',
      standCol: roomCol + spec.roomWidth - 2,
      standRow: roomRow + 2,
      facingDir: Direction.UP,
      occupiedBy: null,
    })

    // WHITEBOARD (2x1) centered on top wall
    const wbCol = roomCol + Math.floor(spec.roomWidth / 2) - 1
    furniture.push({
      uid: `${spec.name}:whiteboard`,
      type: FurnitureType.WHITEBOARD,
      col: wbCol,
      row: roomRow,
    })
    // Whiteboard activity spots: two tiles below it
    activitySpots.push({
      uid: `${spec.name}:whiteboard-spot-0`,
      toolCategory: 'planning',
      standCol: wbCol,
      standRow: roomRow + 1,
      facingDir: Direction.UP,
      occupiedBy: null,
    })
    activitySpots.push({
      uid: `${spec.name}:whiteboard-spot-1`,
      toolCategory: 'planning',
      standCol: wbCol + 1,
      standRow: roomRow + 1,
      facingDir: Direction.UP,
      occupiedBy: null,
    })

    rooms.push({
      projectName: spec.name,
      col: roomCol,
      row: roomRow,
      width: spec.roomWidth,
      height: ROOM_HEIGHT,
      seatUids,
      activitySpots,
    })

    colOffset += spec.roomWidth + ROOM_GAP_COLS
  }

  // ── Conference Room ──────────────────────────────────────────
  // Shared room on second row, below project rooms
  const confCol = garageColOffset
  const confRow = row1Height + ROOM_GAP_ROWS + ROOM_LABEL_ROWS
  const confWidth = CONFERENCE_ROOM_WIDTH

  // Fill conference room tiles
  for (let r = 0; r < ROOM_HEIGHT; r++) {
    for (let c = 0; c < confWidth; c++) {
      const tileRow = confRow + r
      const tileCol = confCol + c
      const idx = tileRow * totalCols + tileCol

      const isTopWall = r === 0
      const isBottomWall = r === ROOM_HEIGHT - 1
      const isLeftWall = c === 0
      const isRightWall = c === confWidth - 1

      if (isBottomWall) {
        const doorCol = Math.floor(confWidth / 2)
        if (c === doorCol) {
          tiles[idx] = TileType.FLOOR_1
          tileColors[idx] = CONFERENCE_FLOOR_COLOR
        } else {
          tiles[idx] = TileType.WALL
          tileColors[idx] = DEFAULT_WALL_COLOR
        }
        continue
      }

      if (isTopWall || isLeftWall || isRightWall) {
        tiles[idx] = TileType.WALL
        tileColors[idx] = DEFAULT_WALL_COLOR
        continue
      }

      tiles[idx] = TileType.FLOOR_1
      tileColors[idx] = CONFERENCE_FLOOR_COLOR
    }
  }

  // Conference table: 2 desks (2x2 each) forming a 4x2 table in the center
  const tableCol = confCol + 2
  const tableRow = confRow + 2
  furniture.push({
    uid: 'conference:desk-0',
    type: FurnitureType.DESK,
    col: tableCol,
    row: tableRow,
  })
  furniture.push({
    uid: 'conference:desk-1',
    type: FurnitureType.DESK,
    col: tableCol + 2,
    row: tableRow,
  })

  // Conference activity spots: positions around the table
  // Agents stand around the table facing inward
  const confSpots: ActivitySpot[] = []
  const spotPositions = [
    // Above table (row 1), facing down
    { col: tableCol, row: confRow + 1, dir: Direction.DOWN },
    { col: tableCol + 3, row: confRow + 1, dir: Direction.DOWN },
    // Below table (row 4), facing up
    { col: tableCol, row: confRow + 4, dir: Direction.UP },
    { col: tableCol + 3, row: confRow + 4, dir: Direction.UP },
  ]

  for (let i = 0; i < Math.min(CONFERENCE_ROOM_SPOTS, spotPositions.length); i++) {
    const pos = spotPositions[i]
    confSpots.push({
      uid: `conference:spot-${i}`,
      toolCategory: 'conference',
      standCol: pos.col,
      standRow: pos.row,
      facingDir: pos.dir,
      occupiedBy: null,
    })
  }

  // Whiteboard on top wall of conference room
  const confWbCol = confCol + Math.floor(confWidth / 2) - 1
  furniture.push({
    uid: 'conference:whiteboard',
    type: FurnitureType.WHITEBOARD,
    col: confWbCol,
    row: confRow,
  })

  rooms.push({
    projectName: CONFERENCE_ROOM_NAME,
    col: confCol,
    row: confRow,
    width: confWidth,
    height: ROOM_HEIGHT,
    seatUids: [],
    activitySpots: confSpots,
    isConferenceRoom: true,
  })

  // ── Warehouse ─────────────────────────────────────────────────
  // One crate per agent — The Office-style storage for agent memory
  const whCol = confCol + confWidth + ROOM_GAP_COLS
  const whRow = row1Height + ROOM_GAP_ROWS + ROOM_LABEL_ROWS

  // Fill warehouse tiles
  for (let r = 0; r < ROOM_HEIGHT; r++) {
    for (let c = 0; c < warehouseWidth; c++) {
      const tileRow = whRow + r
      const tileCol = whCol + c
      const idx = tileRow * totalCols + tileCol

      const isTopWall = r === 0
      const isBottomWall = r === ROOM_HEIGHT - 1
      const isLeftWall = c === 0
      const isRightWall = c === warehouseWidth - 1

      if (isBottomWall) {
        // Wide double door in the center
        const doorCenter = Math.floor(warehouseWidth / 2)
        if (c === doorCenter || c === doorCenter - 1) {
          tiles[idx] = TileType.FLOOR_1
          tileColors[idx] = WAREHOUSE_FLOOR_COLOR
        } else {
          tiles[idx] = TileType.WALL
          tileColors[idx] = DEFAULT_WALL_COLOR
        }
        continue
      }

      if (isTopWall || isLeftWall || isRightWall) {
        tiles[idx] = TileType.WALL
        tileColors[idx] = DEFAULT_WALL_COLOR
        continue
      }

      tiles[idx] = TileType.FLOOR_1
      tileColors[idx] = WAREHOUSE_FLOOR_COLOR
    }
  }

  // Place crates in 2 rows (rows 2 and 4 interior, relative to room)
  let cratesPlaced = 0
  for (let row = 0; row < 2 && cratesPlaced < crateCount; row++) {
    const crateRow = whRow + 2 + row * 2 // rows 2 and 4 relative to room
    for (let col = 0; col < crateCols && cratesPlaced < crateCount; col++) {
      const crateCol = whCol + 1 + col // skip left wall
      furniture.push({
        uid: `warehouse:crate-${cratesPlaced}`,
        type: FurnitureType.CRATE,
        col: crateCol,
        row: crateRow,
      })
      cratesPlaced++
    }
  }

  rooms.push({
    projectName: WAREHOUSE_ROOM_NAME,
    col: whCol,
    row: whRow,
    width: warehouseWidth,
    height: ROOM_HEIGHT,
    seatUids: [],
    activitySpots: [],
    isWarehouse: true,
  })

  // ── Foreman's Office ───────────────────────────────────────
  const fmCol = whCol + warehouseWidth + ROOM_GAP_COLS
  const fmRow = row1Height + ROOM_GAP_ROWS + ROOM_LABEL_ROWS
  const fmWidth = FOREMAN_ROOM_WIDTH

  for (let r = 0; r < ROOM_HEIGHT; r++) {
    for (let c = 0; c < fmWidth; c++) {
      const tileRow = fmRow + r
      const tileCol = fmCol + c
      if (tileRow >= totalRows || tileCol >= totalCols) continue
      const idx = tileRow * totalCols + tileCol

      const isTopWall = r === 0
      const isBottomWall = r === ROOM_HEIGHT - 1
      const isLeftWall = c === 0
      const isRightWall = c === fmWidth - 1

      if (isBottomWall) {
        const doorCol = Math.floor(fmWidth / 2)
        if (c === doorCol) {
          tiles[idx] = TileType.FLOOR_1
          tileColors[idx] = FOREMAN_FLOOR_COLOR
        } else {
          tiles[idx] = TileType.WALL
          tileColors[idx] = DEFAULT_WALL_COLOR
        }
        continue
      }

      if (isTopWall || isLeftWall || isRightWall) {
        tiles[idx] = TileType.WALL
        tileColors[idx] = DEFAULT_WALL_COLOR
        continue
      }

      tiles[idx] = TileType.FLOOR_1
      tileColors[idx] = FOREMAN_FLOOR_COLOR
    }
  }

  // Foreman's desk in the center-back
  furniture.push({
    uid: 'foreman:desk-0',
    type: FurnitureType.DESK,
    col: fmCol + 3,
    row: fmRow + 1,
  })

  // Chair behind the desk
  furniture.push({
    uid: 'foreman:chair-0',
    type: FurnitureType.CHAIR,
    col: fmCol + 3,
    row: fmRow + 3,
  })

  // Bookshelf on the left wall
  furniture.push({
    uid: 'foreman:bookshelf',
    type: FurnitureType.BOOKSHELF,
    col: fmCol + 1,
    row: fmRow + 1,
  })

  rooms.push({
    projectName: FOREMAN_ROOM_NAME,
    col: fmCol,
    row: fmRow,
    width: fmWidth,
    height: ROOM_HEIGHT,
    seatUids: [],
    activitySpots: [],
    isForeman: true,
  })

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
