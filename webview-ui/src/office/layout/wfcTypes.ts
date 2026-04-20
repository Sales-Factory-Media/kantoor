/**
 * Shared types and utilities for the WFC room decorator.
 */

import type { PlacedFurniture, ActivitySpot } from '../types.js'

// ── Room Bounds ──────────────────────────────────────────────

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

// ── Decoration Module ────────────────────────────────────────

/** A decoration module that can be placed */
export interface DecorationModule {
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

// ── Placed Cell ──────────────────────────────────────────────

export interface PlacedCell {
  col: number
  row: number
  width: number
  height: number
  backgroundTiles: number
}

// ── Lounge Group ─────────────────────────────────────────────

/**
 * Lounge group: a sofa facing a coffee table, placed as a unit.
 * Each group defines the relative offsets of its pieces.
 */
export interface LoungeGroup {
  id: string
  pieces: Array<{ type: string; offsetCol: number; offsetRow: number; width: number; height: number }>
  /** Total footprint for collision checking */
  totalWidth: number
  totalHeight: number
  weight: number
}

// ── Result types ─────────────────────────────────────────────

export interface RequiredFurnitureResult {
  furniture: PlacedFurniture[]
  seatUids: string[]
  activitySpots: ActivitySpot[]
  placed: PlacedCell[]
}

export interface DecorationResult {
  furniture: PlacedFurniture[]
  activitySpots: ActivitySpot[]
}

// ── Chair side ───────────────────────────────────────────────

/** Chair position relative to desk: south = below desk, north = above desk */
export type ChairSide = 'south' | 'north'

// ── Seeded RNG ───────────────────────────────────────────────

/** Simple mulberry32 PRNG for deterministic decoration given a seed */
export function createRng(seed: number): () => number {
  let s = seed | 0
  return () => {
    s = (s + 0x6D2B79F5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Generate a seed from room name for deterministic decoration */
export function nameToSeed(name: string): number {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0
  }
  return hash
}

/** Weighted random selection from an array of modules */
export function weightedPick(modules: DecorationModule[], rng: () => number): DecorationModule | null {
  const totalWeight = modules.reduce((sum, m) => sum + m.weight, 0)
  if (totalWeight === 0) return null
  let r = rng() * totalWeight
  for (const m of modules) {
    r -= m.weight
    if (r <= 0) return m
  }
  return modules[modules.length - 1]
}
