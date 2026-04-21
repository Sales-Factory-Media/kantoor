/**
 * Decoration module definitions for the WFC room decorator.
 */

import { FurnitureType } from '../types.js'
import type { DecorationModule, LoungeGroup } from './wfcTypes.js'

// ── Wall Modules ─────────────────────────────────────────────

export const WALL_MODULES: DecorationModule[] = [
  { id: 'bookshelf', type: FurnitureType.BOOKSHELF, width: 2, height: 1, placement: 'wall', weight: 3, maxPerRoom: 1, backgroundTiles: 0, canPlaceOnWalls: true, canPlaceOnSurfaces: false },
  { id: 'double-bookshelf', type: FurnitureType.DOUBLE_BOOKSHELF, width: 2, height: 2, placement: 'wall', weight: 2, maxPerRoom: 1, backgroundTiles: 0, canPlaceOnWalls: true, canPlaceOnSurfaces: false },
  { id: 'whiteboard', type: FurnitureType.WHITEBOARD, width: 2, height: 2, placement: 'wall', weight: 3, maxPerRoom: 1, backgroundTiles: 0, canPlaceOnWalls: true, canPlaceOnSurfaces: false },
  { id: 'large-painting', type: FurnitureType.LARGE_PAINTING, width: 2, height: 2, placement: 'wall', weight: 2, maxPerRoom: 1, backgroundTiles: 0, canPlaceOnWalls: true, canPlaceOnSurfaces: false },
  { id: 'small-painting', type: FurnitureType.SMALL_PAINTING, width: 1, height: 2, placement: 'wall', weight: 2, maxPerRoom: 2, backgroundTiles: 0, canPlaceOnWalls: true, canPlaceOnSurfaces: false },
  { id: 'small-painting-2', type: FurnitureType.SMALL_PAINTING_2, width: 1, height: 2, placement: 'wall', weight: 2, maxPerRoom: 2, backgroundTiles: 0, canPlaceOnWalls: true, canPlaceOnSurfaces: false },
  { id: 'clock', type: FurnitureType.CLOCK, width: 1, height: 2, placement: 'wall', weight: 1, maxPerRoom: 1, backgroundTiles: 0, canPlaceOnWalls: true, canPlaceOnSurfaces: false },
  { id: 'hanging-plant', type: FurnitureType.HANGING_PLANT, width: 1, height: 2, placement: 'wall', weight: 2, maxPerRoom: 2, backgroundTiles: 0, canPlaceOnWalls: true, canPlaceOnSurfaces: false },
]

// ── Plant Modules ────────────────────────────────────────────

export const PLANT_MODULES: DecorationModule[] = [
  { id: 'plant', type: FurnitureType.PLANT, width: 1, height: 2, placement: 'floor-corner', weight: 3, maxPerRoom: 8, backgroundTiles: 1, canPlaceOnWalls: false, canPlaceOnSurfaces: false },
  { id: 'plant-2', type: FurnitureType.PLANT_2, width: 1, height: 2, placement: 'floor-corner', weight: 3, maxPerRoom: 8, backgroundTiles: 1, canPlaceOnWalls: false, canPlaceOnSurfaces: false },
  { id: 'cactus', type: FurnitureType.CACTUS, width: 1, height: 2, placement: 'floor-corner', weight: 2, maxPerRoom: 4, backgroundTiles: 1, canPlaceOnWalls: false, canPlaceOnSurfaces: false },
  { id: 'large-plant', type: FurnitureType.LARGE_PLANT, width: 2, height: 3, placement: 'floor-corner', weight: 1, maxPerRoom: 2, backgroundTiles: 2, canPlaceOnWalls: false, canPlaceOnSurfaces: false },
]

// ── Lounge Groups ────────────────────────────────────────────

export const LOUNGE_GROUPS: LoungeGroup[] = [
  // Sofa (front-facing) with coffee table in front
  {
    id: 'sofa-front-table',
    pieces: [
      { type: FurnitureType.SOFA_FRONT, offsetCol: 0, offsetRow: 0, width: 2, height: 1 },
      { type: FurnitureType.COFFEE_TABLE, offsetCol: 0, offsetRow: 1, width: 2, height: 2 },
    ],
    totalWidth: 2, totalHeight: 3, weight: 3,
  },
  // Sofa (back-facing) with coffee table behind (above)
  {
    id: 'sofa-back-table',
    pieces: [
      { type: FurnitureType.COFFEE_TABLE, offsetCol: 0, offsetRow: 0, width: 2, height: 2 },
      { type: FurnitureType.SOFA_BACK, offsetCol: 0, offsetRow: 2, width: 2, height: 1 },
    ],
    totalWidth: 2, totalHeight: 3, weight: 3,
  },
  // Simple bench
  {
    id: 'bench',
    pieces: [
      { type: FurnitureType.WOODEN_BENCH, offsetCol: 0, offsetRow: 0, width: 1, height: 1 },
    ],
    totalWidth: 1, totalHeight: 1, weight: 1,
  },
]

// ── Floor Edge Modules ───────────────────────────────────────

export const FLOOR_MODULES: DecorationModule[] = [
  { id: 'bin', type: FurnitureType.BIN, width: 1, height: 1, placement: 'floor-edge', weight: 2, maxPerRoom: 2, backgroundTiles: 0, canPlaceOnWalls: false, canPlaceOnSurfaces: false },
  { id: 'pot', type: FurnitureType.POT, width: 1, height: 1, placement: 'floor-edge', weight: 1, maxPerRoom: 1, backgroundTiles: 0, canPlaceOnWalls: false, canPlaceOnSurfaces: false },
]

// ── Surface Modules ──────────────────────────────────────────

export const SURFACE_MODULES: DecorationModule[] = [
  { id: 'coffee', type: FurnitureType.COFFEE, width: 1, height: 1, placement: 'surface', weight: 2, maxPerRoom: 2, backgroundTiles: 0, canPlaceOnWalls: false, canPlaceOnSurfaces: true },
]
