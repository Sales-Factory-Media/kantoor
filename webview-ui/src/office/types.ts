export {
  TILE_SIZE,
  DEFAULT_COLS,
  DEFAULT_ROWS,
  MAX_COLS,
  MAX_ROWS,
  MATRIX_EFFECT_DURATION_SEC as MATRIX_EFFECT_DURATION,
} from '../constants.js'

export const TileType = {
  WALL: 0,
  FLOOR_1: 1,
  FLOOR_2: 2,
  FLOOR_3: 3,
  FLOOR_4: 4,
  FLOOR_5: 5,
  FLOOR_6: 6,
  FLOOR_7: 7,
  VOID: 8,
  /** Floor-to-ceiling window — behaves like a wall for routing and the wall
   *  auto-tile bitmask (neighbors see it as "wall-like"), but renders a
   *  semi-transparent window sprite so the outdoor layer shows through. */
  WINDOW: 9,
} as const
export type TileType = (typeof TileType)[keyof typeof TileType]

/** Per-tile color settings for floor pattern colorization */
export interface FloorColor {
  /** Hue: 0-360 in colorize mode, -180 to +180 in adjust mode */
  h: number
  /** Saturation: 0-100 in colorize mode, -100 to +100 in adjust mode */
  s: number
  /** Brightness -100 to 100 */
  b: number
  /** Contrast -100 to 100 */
  c: number
  /** When true, use Photoshop-style Colorize (grayscale → fixed HSL). Default: adjust mode. */
  colorize?: boolean
}

export const CharacterState = {
  IDLE: 'idle',
  WALK: 'walk',
  TYPE: 'type',
} as const
export type CharacterState = (typeof CharacterState)[keyof typeof CharacterState]

export const Direction = {
  DOWN: 0,
  LEFT: 1,
  RIGHT: 2,
  UP: 3,
} as const
export type Direction = (typeof Direction)[keyof typeof Direction]

/** 2D array of hex color strings (or '' for transparent). [row][col] */
export type SpriteData = string[][]

export interface Seat {
  /** Chair furniture uid */
  uid: string
  /** Tile col where agent sits */
  seatCol: number
  /** Tile row where agent sits */
  seatRow: number
  /** Direction character faces when sitting (toward adjacent desk) */
  facingDir: Direction
  assigned: boolean
}

export interface FurnitureInstance {
  sprite: SpriteData
  /** Pixel x (top-left) */
  x: number
  /** Pixel y (top-left) */
  y: number
  /** Y value used for depth sorting (typically bottom edge) */
  zY: number
}

export interface ActivitySpot {
  /** Unique identifier, e.g. "myproject:bookshelf-spot-0" */
  uid: string
  /** Tool category: 'file_research' | 'web_research' | 'planning' */
  toolCategory: string
  /** Tile col where character stands */
  standCol: number
  /** Tile row where character stands */
  standRow: number
  /** Direction to face when at the spot (toward the prop) */
  facingDir: Direction
  /** Character id occupying this spot, or null */
  occupiedBy: number | null
}

export interface ToolActivity {
  toolId: string
  status: string
  done: boolean
  permissionWait?: boolean
}

export const FurnitureType = {
  // Desks
  DESK: 'DESK_FRONT',
  DESK_FRONT: 'DESK_FRONT',
  DESK_SIDE: 'DESK_SIDE',
  COFFEE_TABLE: 'COFFEE_TABLE',
  SMALL_TABLE_FRONT: 'SMALL_TABLE_FRONT',
  TABLE_FRONT: 'TABLE_FRONT',
  // Chairs
  CHAIR: 'WOODEN_CHAIR_FRONT',
  WOODEN_CHAIR_FRONT: 'WOODEN_CHAIR_FRONT',
  WOODEN_CHAIR_BACK: 'WOODEN_CHAIR_BACK',
  CUSHIONED_CHAIR_FRONT: 'CUSHIONED_CHAIR_FRONT',
  CUSHIONED_BENCH: 'CUSHIONED_BENCH',
  WOODEN_BENCH: 'WOODEN_BENCH',
  SOFA_FRONT: 'SOFA_FRONT',
  SOFA_BACK: 'SOFA_BACK',
  SOFA_SIDE: 'SOFA_SIDE',
  // Wall-mounted
  BOOKSHELF: 'BOOKSHELF',
  DOUBLE_BOOKSHELF: 'DOUBLE_BOOKSHELF',
  WHITEBOARD: 'WHITEBOARD',
  CLOCK: 'CLOCK',
  HANGING_PLANT: 'HANGING_PLANT',
  LARGE_PAINTING: 'LARGE_PAINTING',
  SMALL_PAINTING: 'SMALL_PAINTING',
  SMALL_PAINTING_2: 'SMALL_PAINTING_2',
  // Decor
  PLANT: 'PLANT',
  PLANT_2: 'PLANT_2',
  LARGE_PLANT: 'LARGE_PLANT',
  CACTUS: 'CACTUS',
  POT: 'POT',
  BIN: 'BIN',
  COFFEE: 'COFFEE',
  // Electronics
  PC: 'PC_FRONT_OFF',
  PC_FRONT_OFF: 'PC_FRONT_OFF',
  PC_BACK: 'PC_BACK',
  // Vehicles (MinZinn Pixel Vehicles, CC-BY 4.0)
  CAR_SEDAN: 'CAR_SEDAN',
  CAR_SPORT: 'CAR_SPORT',
  CAR_SUV: 'CAR_SUV',
  CAR_PICKUP: 'CAR_PICKUP',
  CAR_COUPE: 'CAR_COUPE',
  CAR_SUPERCAR: 'CAR_SUPERCAR',
  // Legacy vehicle aliases
  PORSCHE: 'CAR_SPORT',
  LAMBO: 'CAR_SUPERCAR',
  FERRARI: 'CAR_COUPE',
  MULTIPLA: 'CAR_SEDAN',
  MASSERATI: 'CAR_SPORT',
  RANGE_ROVER: 'CAR_SUV',
  // Legacy aliases
  COOLER: 'COFFEE',
  LAMP: 'CLOCK',
  CRATE: 'BIN',
} as const
export type FurnitureType = (typeof FurnitureType)[keyof typeof FurnitureType]

export const EditTool = {
  TILE_PAINT: 'tile_paint',
  WALL_PAINT: 'wall_paint',
  FURNITURE_PLACE: 'furniture_place',
  FURNITURE_PICK: 'furniture_pick',
  SELECT: 'select',
  EYEDROPPER: 'eyedropper',
  ERASE: 'erase',
} as const
export type EditTool = (typeof EditTool)[keyof typeof EditTool]

export interface FurnitureCatalogEntry {
  type: string // FurnitureType enum or asset ID
  label: string
  footprintW: number
  footprintH: number
  sprite: SpriteData
  isDesk: boolean
  category?: string
  /** Orientation from rotation group: 'front' | 'back' | 'left' | 'right' */
  orientation?: string
  /** Whether this item can be placed on top of desk/table surfaces */
  canPlaceOnSurfaces?: boolean
  /** Number of tile rows from the top of the footprint that are "background" (allow placement, still block walking). Default 0. */
  backgroundTiles?: number
  /** Whether this item can be placed on wall tiles */
  canPlaceOnWalls?: boolean
}

export interface PlacedFurniture {
  uid: string
  type: string // FurnitureType enum or asset ID
  col: number
  row: number
  /** Optional color override for furniture */
  color?: FloorColor
}

export interface OfficeLayout {
  version: 1
  cols: number
  rows: number
  tiles: TileType[]
  furniture: PlacedFurniture[]
  /** Per-tile color settings, parallel to tiles array. null = wall/no color */
  tileColors?: Array<FloorColor | null>
}

export interface Character {
  id: number
  /** Display name shown above the character */
  name: string
  state: CharacterState
  dir: Direction
  /** Pixel position */
  x: number
  y: number
  /** Current tile column */
  tileCol: number
  /** Current tile row */
  tileRow: number
  /** Remaining path steps (tile coords) */
  path: Array<{ col: number; row: number }>
  /** 0-1 lerp between current tile and next tile */
  moveProgress: number
  /** Current tool name for typing vs reading animation, or null */
  currentTool: string | null
  /** Palette index (0-5) */
  palette: number
  /** Hue shift in degrees (0 = no shift, ≥45 for repeated palettes) */
  hueShift: number
  /** Animation frame index */
  frame: number
  /** Time accumulator for animation */
  frameTimer: number
  /** Timer for idle wander decisions */
  wanderTimer: number
  /** Number of wander moves completed in current roaming cycle */
  wanderCount: number
  /** Max wander moves before returning to seat for rest */
  wanderLimit: number
  /** Whether the agent is actively working */
  isActive: boolean
  /** Assigned seat uid, or null if no seat */
  seatId: string | null
  /** Active speech bubble type, or null if none showing */
  bubbleType: 'permission' | 'waiting' | null
  /** Countdown timer for bubble (waiting: 2→0, permission: unused) */
  bubbleTimer: number
  /** Timer to stay seated while inactive after seat reassignment (counts down to 0) */
  seatTimer: number
  /** Whether this character represents a sub-agent (spawned by Task tool) */
  isSubagent: boolean
  /** Parent agent ID if this is a sub-agent, null otherwise */
  parentAgentId: number | null
  /**
   * Multi-session grouping: if set, this character is a hidden "task" body for
   * the same employee as the character with this id. One employee running N
   * concurrent sessions shows ONE visible body (the primary, followerOf == null)
   * plus N-1 followers; the followers aren't drawn but carry per-task activity
   * state, surfaced as clickable pips above the primary's head.
   */
  followerOf?: number | null
  /** Active matrix spawn/despawn effect, or null */
  matrixEffect: 'spawn' | 'despawn' | null
  /** Timer counting up from 0 to MATRIX_EFFECT_DURATION */
  matrixEffectTimer: number
  /** Per-column random seeds (16 values) for staggered rain timing */
  matrixEffectSeeds: number[]
  /** Workspace folder name */
  folderName?: string
  /** Project name for room assignment */
  projectName?: string
  /** Session ID for metadata persistence (stable across restarts) */
  sessionId?: string
  /** Short role description (e.g. "Frontend Dev") */
  roleShort?: string
  /** Full role description */
  roleFull?: string
  /** Workspace root directory path */
  workspacePath?: string
  /** Linked persistent agent ID */
  persistentAgentId?: string
  /** DiceBear pixel-art avatar combo (JSON string) for this employee */
  avatarConfig?: string
  /** Number of completed sessions (a rough "experience" metric) */
  sessionCount?: number
  /** ISO timestamp of the last session end */
  lastSessionEnd?: string
  /** Short label of what THIS session/tab is working on (its opening prompt). */
  taskTitle?: string
  /** Whether the character is standing at an activity spot (not seated) */
  atActivitySpot: boolean
  /** Current activity spot target, or null if heading to seat */
  activityTarget: ActivitySpot | null
  /** Assigned car type for the garage (persisted per agent) */
  carType?: string
}

export interface ConversationEntry {
  kind: 'assistant_text' | 'user_text' | 'tool_use' | 'tool_result' | 'turn_end'
  content: string
  toolId?: string
  toolName?: string
}
