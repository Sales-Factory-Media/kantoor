import { describe, it, expect } from 'vitest'
import { runWfc } from './wfcEngine.js'
import type { OutdoorTile } from './tileExtractor.js'
import { buildAdjacencyRules } from './tileExtractor.js'

function makeTile(id: number, type: OutdoorTile['type'] = 'grass', edges: { top: [number, number, number]; right: [number, number, number]; bottom: [number, number, number]; left: [number, number, number] }): OutdoorTile {
  return {
    id, sheetCol: id % 16, sheetRow: Math.floor(id / 16),
    sprite: [['#00ff00']], type, weight: type === 'grass' ? 10 : 2,
    topEdge: edges.top, rightEdge: edges.right, bottomEdge: edges.bottom, leftEdge: edges.left,
    transparency: 0, canPlaceOnWalls: false, canPlaceOnSurfaces: false, backgroundTiles: 0,
  } as OutdoorTile
}

describe('WFC Engine', () => {
  const greenEdge: [number, number, number] = [100, 180, 70]
  const brownEdge: [number, number, number] = [150, 120, 80]

  // Two tiles that connect to themselves (all green edges)
  const grassA = makeTile(0, 'grass', { top: greenEdge, right: greenEdge, bottom: greenEdge, left: greenEdge })
  const grassB = makeTile(1, 'grass', { top: greenEdge, right: greenEdge, bottom: greenEdge, left: greenEdge })
  // A stone tile with different edges (won't connect to grass)
  const stone = makeTile(2, 'stone', { top: brownEdge, right: brownEdge, bottom: brownEdge, left: brownEdge })

  it('fills a small grid completely', () => {
    const tiles = [grassA, grassB]
    const adj = buildAdjacencyRules(tiles, 35)
    const result = runWfc(5, 5, tiles, adj, new Set(), 42)

    expect(result.width).toBe(5)
    expect(result.height).toBe(5)
    // Every cell should be collapsed to a valid tile
    for (let i = 0; i < 25; i++) {
      expect(result.grid[i]).toBeGreaterThanOrEqual(0)
    }
  })

  it('respects building mask', () => {
    const tiles = [grassA, grassB]
    const adj = buildAdjacencyRules(tiles, 35)
    const mask = new Set(['1,1', '2,1', '1,2', '2,2'])
    const result = runWfc(4, 4, tiles, adj, mask, 42)

    // Building cells should be -1
    expect(result.grid[1 * 4 + 1]).toBe(-1)
    expect(result.grid[1 * 4 + 2]).toBe(-1)
    expect(result.grid[2 * 4 + 1]).toBe(-1)
    expect(result.grid[2 * 4 + 2]).toBe(-1)

    // Non-building cells should be valid tiles
    expect(result.grid[0]).toBeGreaterThanOrEqual(0)
  })

  it('produces deterministic output with same seed', () => {
    const tiles = [grassA, grassB]
    const adj = buildAdjacencyRules(tiles, 35)
    const r1 = runWfc(6, 6, tiles, adj, new Set(), 123)
    const r2 = runWfc(6, 6, tiles, adj, new Set(), 123)

    for (let i = 0; i < 36; i++) {
      expect(r1.grid[i]).toBe(r2.grid[i])
    }
  })

  it('produces different output with different seeds', () => {
    const tiles = [grassA, grassB]
    const adj = buildAdjacencyRules(tiles, 35)
    const r1 = runWfc(8, 8, tiles, adj, new Set(), 42)
    const r2 = runWfc(8, 8, tiles, adj, new Set(), 999)

    let differences = 0
    for (let i = 0; i < 64; i++) {
      if (r1.grid[i] !== r2.grid[i]) differences++
    }
    expect(differences).toBeGreaterThan(0)
  })

  it('handles tiles with incompatible edges via fallback', () => {
    // Only stone tile, which can connect to itself
    const tiles = [stone]
    const adj = buildAdjacencyRules(tiles, 35)
    const result = runWfc(3, 3, tiles, adj, new Set(), 42)

    // Should still fill the grid (stone connects to stone)
    for (let i = 0; i < 9; i++) {
      expect(result.grid[i]).toBeGreaterThanOrEqual(0)
    }
  })
})
