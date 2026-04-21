/**
 * Wave Function Collapse engine for outdoor tile generation.
 * Simple Tiled Model: each cell collapses to one tile, constrained by edge adjacency.
 */

import type { OutdoorTile } from './tileExtractor.js'

interface WfcCell {
  /** Set of tile IDs still possible at this position */
  options: Set<number>
  /** Collapsed tile ID, or null if not yet collapsed */
  collapsed: number | null
}

export interface WfcResult {
  /** Grid of collapsed tile IDs (row-major, -1 for building/void cells) */
  grid: Int16Array
  width: number
  height: number
}

/** Run WFC to fill a grid, respecting pre-collapsed building cells.
 *  @param width Grid width
 *  @param height Grid height
 *  @param tiles Available tiles
 *  @param adjacency Adjacency rules (tile ID → { top, right, bottom, left } sets of valid neighbor IDs)
 *  @param buildingMask Set of "col,row" strings that are building/office tiles (pre-collapsed as -1)
 *  @param seed Random seed for deterministic output
 */
export function runWfc(
  width: number,
  height: number,
  tiles: OutdoorTile[],
  adjacency: Map<number, { top: Set<number>; right: Set<number>; bottom: Set<number>; left: Set<number> }>,
  buildingMask: Set<string>,
  seed: number,
): WfcResult {
  const rng = createRng(seed)
  const tileIds = tiles.map(t => t.id)
  const tileWeights = new Map<number, number>()
  for (const t of tiles) tileWeights.set(t.id, t.weight)

  // Initialize grid
  const grid: WfcCell[] = new Array(width * height)
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const idx = r * width + c
      if (buildingMask.has(`${c},${r}`)) {
        grid[idx] = { options: new Set(), collapsed: -1 }
      } else {
        grid[idx] = { options: new Set(tileIds), collapsed: null }
      }
    }
  }

  // Initial propagation from building edges
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      if (buildingMask.has(`${c},${r}`)) {
        propagate(grid, width, height, c, r, adjacency)
      }
    }
  }

  // Collapse loop
  let maxIterations = width * height * 2
  while (maxIterations-- > 0) {
    // Find uncollapsed cell with lowest entropy
    let minEntropy = Infinity
    let minIdx = -1
    for (let i = 0; i < grid.length; i++) {
      const cell = grid[i]
      if (cell.collapsed !== null) continue
      const entropy = cell.options.size
      if (entropy === 0) {
        // Contradiction — fill with most common grass tile as fallback
        cell.collapsed = findGrassFallback(tiles)
        continue
      }
      if (entropy < minEntropy) {
        minEntropy = entropy
        minIdx = i
      }
    }

    if (minIdx === -1) break // All collapsed

    // Collapse: weighted random pick
    const cell = grid[minIdx]
    const options = Array.from(cell.options)
    const totalWeight = options.reduce((sum, id) => sum + (tileWeights.get(id) || 1), 0)
    let pick = rng() * totalWeight
    let chosen = options[0]
    for (const id of options) {
      pick -= tileWeights.get(id) || 1
      if (pick <= 0) { chosen = id; break }
    }

    cell.collapsed = chosen
    cell.options.clear()

    // Propagate constraints
    const col = minIdx % width
    const row = Math.floor(minIdx / width)
    propagate(grid, width, height, col, row, adjacency)
  }

  // Build result grid
  const result = new Int16Array(width * height)
  for (let i = 0; i < grid.length; i++) {
    result[i] = grid[i].collapsed ?? -1
  }

  return { grid: result, width, height }
}

function propagate(
  grid: WfcCell[],
  width: number,
  height: number,
  startCol: number,
  startRow: number,
  adjacency: Map<number, { top: Set<number>; right: Set<number>; bottom: Set<number>; left: Set<number> }>,
): void {
  const stack: Array<[number, number]> = [[startCol, startRow]]
  const visited = new Set<number>()

  while (stack.length > 0) {
    const [c, r] = stack.pop()!
    const idx = r * width + c
    if (visited.has(idx)) continue
    visited.add(idx)

    const cell = grid[idx]

    // For each neighbor, constrain their options based on this cell
    const neighbors: Array<[number, number, 'top' | 'right' | 'bottom' | 'left']> = [
      [c, r - 1, 'top'],      // cell above: must be compatible with our top
      [c + 1, r, 'right'],    // cell right: must be compatible with our right
      [c, r + 1, 'bottom'],   // cell below: must be compatible with our bottom
      [c - 1, r, 'left'],     // cell left: must be compatible with our left
    ]

    for (const [nc, nr, myDir] of neighbors) {
      if (nc < 0 || nc >= width || nr < 0 || nr >= height) continue
      const nIdx = nr * width + nc
      const neighbor = grid[nIdx]
      if (neighbor.collapsed !== null) continue
      if (neighbor.options.size === 0) continue

      // Compute valid tiles for neighbor based on this cell's state
      let validForNeighbor: Set<number>
      if (cell.collapsed !== null && cell.collapsed >= 0) {
        // Cell is collapsed to a specific tile — neighbor must match that tile's edge
        const adj = adjacency.get(cell.collapsed)
        validForNeighbor = adj ? adj[myDir] : new Set()
      } else if (cell.collapsed === -1) {
        // Building cell — any tile can be adjacent (no constraint from building)
        continue
      } else {
        // Cell has multiple options — neighbor must be compatible with ALL remaining options
        validForNeighbor = new Set<number>()
        let first = true
        for (const optId of cell.options) {
          const adj = adjacency.get(optId)
          if (!adj) continue
          if (first) {
            for (const id of adj[myDir]) validForNeighbor.add(id)
            first = false
          } else {
            // Intersect
            for (const id of validForNeighbor) {
              if (!adj[myDir].has(id)) validForNeighbor.delete(id)
            }
          }
        }
      }

      // Remove invalid options from neighbor
      const before = neighbor.options.size
      for (const id of neighbor.options) {
        if (!validForNeighbor.has(id)) {
          neighbor.options.delete(id)
        }
      }

      // If options changed, propagate further
      if (neighbor.options.size < before) {
        // Auto-collapse if only one option left
        if (neighbor.options.size === 1) {
          neighbor.collapsed = neighbor.options.values().next().value!
          neighbor.options.clear()
        }
        stack.push([nc, nr])
      }
    }
  }
}

function findGrassFallback(tiles: OutdoorTile[]): number {
  const grass = tiles.find(t => t.type === 'grass')
  return grass ? grass.id : tiles[0].id
}

function createRng(seed: number): () => number {
  let s = seed | 0
  return () => {
    s = (s + 0x6D2B79F5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
