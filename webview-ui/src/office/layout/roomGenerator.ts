import { TileType } from '../types.js'
import type { TileType as TileTypeVal, OfficeLayout, PlacedFurniture, FloorColor, ActivitySpot } from '../types.js'
import {
  ROOM_HEIGHT,
  ROOM_LABEL_ROWS,
  ROOM_MIN_SEATS,
  ROOM_EXTRA_SEATS,
  ROOM_MIN_INTERIOR_WIDTH,
  ROOM_MAX_DESKS_PER_ROW,
  ROOM_FLOOR_COLOR,
  CONFERENCE_ROOM_WIDTH,
  GARAGE_WIDTH,
  FOREMAN_ROOM_WIDTH,
  ART_DIRECTOR_ROOM_WIDTH,
  CORRIDOR_HEIGHT,
} from '../../constants.js'
import {
  fillRoomTiles,
  placeProjectRoomFurniture,
  buildGarage,
  buildConferenceRoom,
  buildForemanOffice,
  buildArtDirectorOffice,
  buildCorridor,
  placeFillers,
  type BuildContext,
} from './roomBuilders.js'

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

export interface RoomSpec {
  name: string
  seatCount: number
  deskCount: number
  deskRows: number
  desksPerRow: number
  interiorWidth: number
  roomWidth: number
  roomHeight: number
}

// ── Layout seed cache ────────────────────────────────────────
// The decoration seed is randomized once and reused until the room config changes.
let cachedLayoutSeed = Math.floor(Math.random() * 2147483647)
let cachedConfigKey = ''

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
  const topSpecs: RoomSpec[] = []
  const bottomSpecs: RoomSpec[] = []
  for (let i = 0; i < roomSpecs.length; i++) {
    if (i % 2 === 0) topSpecs.push(roomSpecs[i])
    else bottomSpecs.push(roomSpecs[i])
  }

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
  const ctx: BuildContext = { tiles, tileColors, furniture, rooms, totalCols }

  // ── Garage ──────────────────────────────────────────────────
  buildGarage(ctx, garageTopRow, garageHeight, corridorRow, carTypes)

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
  buildConferenceRoom(ctx, bottomColOffset, bottomRowStart)
  bottomColOffset += CONFERENCE_ROOM_WIDTH - 1

  buildForemanOffice(ctx, bottomColOffset, bottomRowStart)
  bottomColOffset += FOREMAN_ROOM_WIDTH - 1

  buildArtDirectorOffice(ctx, bottomColOffset, bottomRowStart)
  bottomColOffset += ART_DIRECTOR_ROOM_WIDTH - 1

  // ── Central corridor + east wall + sparse plants ───────────
  const corridorStart = garageColOffset
  const corridorEnd = totalCols
  buildCorridor(ctx, corridorRow, corridorStart, corridorEnd, topRowStart)

  // ── Filler rooms (fill gaps up to the east wall) ────────────
  const topEnd = topColOffset
  const bottomEnd = bottomColOffset
  const maxEnd = totalCols
  if (topEnd < maxEnd) {
    placeFillers(ctx, topEnd, maxEnd, topRowStart, maxTopHeight, 'bottom')
  }
  if (bottomEnd < maxEnd) {
    placeFillers(ctx, bottomEnd, maxEnd, bottomRowStart, maxBottomHeight, 'top')
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
