import { describe, it, expect } from 'vitest'
import { placeRequiredFurniture, decorateRoom, decorateProjectRoom } from './wfcRoomDecorator.js'
import { FurnitureType } from '../types.js'
import type { RoomBounds } from './wfcRoomDecorator.js'

function makeRoom(overrides: Partial<RoomBounds> = {}): RoomBounds {
  return {
    name: 'test',
    roomCol: 0,
    roomRow: 2, // room label rows above
    roomWidth: 9,  // 7 interior + 2 walls
    roomHeight: 7,
    doorSide: 'bottom',
    seatCount: 2,
    deskCount: 1,
    desksPerRow: 1,
    deskRows: 1,
    ...overrides,
  }
}

describe('placeRequiredFurniture', () => {
  it('places correct number of desks', () => {
    const room = makeRoom({ seatCount: 4, deskCount: 2, desksPerRow: 2, deskRows: 1 })
    const { furniture } = placeRequiredFurniture(room)
    const desks = furniture.filter(f => f.uid.startsWith('test:desk-'))
    expect(desks).toHaveLength(2)
  })

  it('places correct number of chairs', () => {
    const room = makeRoom({ seatCount: 3, deskCount: 2, desksPerRow: 2, deskRows: 1 })
    const { furniture, seatUids } = placeRequiredFurniture(room)
    const chairs = furniture.filter(f => f.uid.startsWith('test:chair-'))
    expect(chairs).toHaveLength(3)
    expect(seatUids).toHaveLength(3)
  })

  it('places PCs on some desks (not all)', () => {
    const room = makeRoom({ seatCount: 10, deskCount: 5, desksPerRow: 3, deskRows: 2, roomWidth: 16, roomHeight: 12 })
    const { furniture } = placeRequiredFurniture(room)
    const pcs = furniture.filter(f => f.uid.startsWith('test:pc-'))
    // With 60% chance per desk, expect at least 1 but not necessarily all 5
    expect(pcs.length).toBeGreaterThan(0)
    expect(pcs.length).toBeLessThanOrEqual(5)
  })

  it('chairs face the correct direction for their side of the desk', () => {
    const room = makeRoom({ roomWidth: 15, roomHeight: 10, seatCount: 4, deskCount: 2, desksPerRow: 2, deskRows: 1 })
    const { furniture } = placeRequiredFurniture(room)
    const chairs = furniture.filter(f => f.uid.startsWith('test:chair-'))
    for (const chair of chairs) {
      // Every chair must be BACK (south, facing up) or FRONT (north, facing down)
      expect([FurnitureType.WOODEN_CHAIR_BACK, FurnitureType.WOODEN_CHAIR_FRONT]).toContain(chair.type)
    }
  })

  it('creates activity spots', () => {
    const room = makeRoom()
    const { activitySpots } = placeRequiredFurniture(room)
    expect(activitySpots.length).toBeGreaterThan(0)
    expect(activitySpots.some(s => s.toolCategory === 'web_research')).toBe(true)
  })

  it('chairs are adjacent to their desk', () => {
    const room = makeRoom({ roomWidth: 12, roomHeight: 9 })
    const { furniture } = placeRequiredFurniture(room)
    const desk = furniture.find(f => f.uid === 'test:desk-0')!
    const chair = furniture.find(f => f.uid === 'test:chair-0')!
    if (chair.type === FurnitureType.WOODEN_CHAIR_BACK) {
      // South: chair tucked against desk, bg row overlaps desk bottom
      expect(chair.row).toBe(desk.row + 1)
    } else {
      // North: chair 1 row above desk
      expect(chair.row).toBe(desk.row - 1)
    }
  })
})

describe('decorateRoom', () => {
  it('places wall decorations including bookshelf and whiteboard', () => {
    const room = makeRoom()
    const { placed } = placeRequiredFurniture(room)
    const { furniture } = decorateRoom(room, placed)

    const bookshelf = furniture.find(f => f.uid === 'test:bookshelf')
    const whiteboard = furniture.find(f => f.uid === 'test:whiteboard')
    expect(bookshelf).toBeDefined()
    expect(whiteboard).toBeDefined()
  })

  it('creates activity spots for bookshelf and whiteboard', () => {
    const room = makeRoom()
    const { placed } = placeRequiredFurniture(room)
    const { activitySpots } = decorateRoom(room, placed)

    const bookshelfSpots = activitySpots.filter(s => s.uid.includes('bookshelf'))
    const whiteboardSpots = activitySpots.filter(s => s.uid.includes('whiteboard'))
    expect(bookshelfSpots.length).toBeGreaterThan(0)
    expect(whiteboardSpots.length).toBeGreaterThan(0)
  })

  it('places decorative items (plants, bins, etc.)', () => {
    // Use a larger room to ensure there's space for decorations
    const room = makeRoom({ roomWidth: 15, roomHeight: 10 })
    const { placed } = placeRequiredFurniture(room)
    const { furniture } = decorateRoom(room, placed)

    // Should have more than just bookshelf + whiteboard
    const nonRequired = furniture.filter(f =>
      !f.uid.includes('bookshelf') && !f.uid.includes('whiteboard')
    )
    expect(nonRequired.length).toBeGreaterThan(0)
  })

  it('is deterministic with the same seed', () => {
    const room = makeRoom({ roomWidth: 15, roomHeight: 10 })
    const { placed: placed1 } = placeRequiredFurniture(room)
    const { placed: placed2 } = placeRequiredFurniture(room)

    const result1 = decorateRoom(room, placed1, 42)
    const result2 = decorateRoom(room, placed2, 42)

    expect(result1.furniture.map(f => f.uid)).toEqual(result2.furniture.map(f => f.uid))
  })

  it('produces different results with different seeds', () => {
    const room = makeRoom({ roomWidth: 15, roomHeight: 10 })
    const { placed: placed1 } = placeRequiredFurniture(room)
    const { placed: placed2 } = placeRequiredFurniture(room)

    const result1 = decorateRoom(room, placed1, 42)
    const result2 = decorateRoom(room, placed2, 999)

    // At least the uid names differ due to random ordering
    // Very unlikely to be identical with different seeds in a large room
    // but bookshelf/whiteboard positions are deterministic, so check decorative items
    const decor1 = result1.furniture.filter(f => f.uid.includes('corner-') || f.uid.includes('edge-'))
    const decor2 = result2.furniture.filter(f => f.uid.includes('corner-') || f.uid.includes('edge-'))
    if (decor1.length > 0 && decor2.length > 0) {
      const positions1 = decor1.map(f => `${f.col},${f.row}`).join(';')
      const positions2 = decor2.map(f => `${f.col},${f.row}`).join(';')
      // Positions or types should differ
      expect(positions1 === positions2 && decor1.map(f => f.type).join() === decor2.map(f => f.type).join()).toBe(false)
    }
  })

  it('wall items are placed at roomRow - 1', () => {
    const room = makeRoom()
    const { placed } = placeRequiredFurniture(room)
    const { furniture } = decorateRoom(room, placed)

    const wallItems = furniture.filter(f => f.uid.includes('bookshelf') || f.uid.includes('whiteboard'))
    for (const item of wallItems) {
      expect(item.row).toBe(room.roomRow - 1)
    }
  })
})

describe('decorateProjectRoom', () => {
  it('combines required furniture and decorations', () => {
    const room = makeRoom()
    const { furniture, seatUids, activitySpots } = decorateProjectRoom(room)

    // Should have desks, chairs, PCs, bookshelf, whiteboard, and decorations
    const desks = furniture.filter(f => f.uid.startsWith('test:desk-'))
    const chairs = furniture.filter(f => f.uid.startsWith('test:chair-'))
    const bookshelf = furniture.find(f => f.uid === 'test:bookshelf')
    const whiteboard = furniture.find(f => f.uid === 'test:whiteboard')

    expect(desks).toHaveLength(1)
    expect(chairs).toHaveLength(2)
    expect(seatUids).toHaveLength(2)
    expect(bookshelf).toBeDefined()
    expect(whiteboard).toBeDefined()
    expect(activitySpots.length).toBeGreaterThanOrEqual(6) // 2 bookshelf + 2 whiteboard + 2 PC
  })

  it('no furniture overlaps (excluding surface items and background tiles)', () => {
    const room = makeRoom({ roomWidth: 15, roomHeight: 10, seatCount: 4, deskCount: 2, desksPerRow: 2, deskRows: 1 })
    const { furniture } = decorateProjectRoom(room)

    // Build a set of all occupied tiles (ignoring surface items like PCs and background tiles)
    const occupied = new Set<string>()
    for (const item of furniture) {
      // Skip PCs (surface items) - they sit on desks
      if (item.type === FurnitureType.PC) continue

      // Determine footprint from known types
      let w = 1, h = 1, bg = 0
      if (item.type === FurnitureType.DESK) { w = 3; h = 2; bg = 1 }
      else if (item.type === FurnitureType.WOODEN_CHAIR_FRONT || item.type === FurnitureType.WOODEN_CHAIR_BACK) { w = 1; h = 2; bg = 1 }
      else if (item.type === FurnitureType.BOOKSHELF) { w = 2; h = 1 }
      else if (item.type === FurnitureType.WHITEBOARD || item.type === FurnitureType.LARGE_PAINTING || item.type === FurnitureType.DOUBLE_BOOKSHELF) { w = 2; h = 2 }
      else if (item.type === FurnitureType.PLANT || item.type === FurnitureType.PLANT_2 || item.type === FurnitureType.CACTUS) { w = 1; h = 2; bg = 1 }
      else if (item.type === FurnitureType.LARGE_PLANT) { w = 2; h = 3; bg = 2 }
      else if (item.type === FurnitureType.CLOCK || item.type === FurnitureType.HANGING_PLANT || item.type === FurnitureType.SMALL_PAINTING || item.type === FurnitureType.SMALL_PAINTING_2) { w = 1; h = 2 }

      for (let dr = bg; dr < h; dr++) {
        for (let dc = 0; dc < w; dc++) {
          const key = `${item.col + dc},${item.row + dr}`
          // Wall items can overlap with each other in wall space (row < roomRow)
          if (item.row + dr < room.roomRow) continue
          expect(occupied.has(key)).toBe(false)
          occupied.add(key)
        }
      }
    }
  })

  it('handles large rooms with many workers', () => {
    const room = makeRoom({
      name: 'bigteam',
      roomWidth: 16,
      roomHeight: 12,
      seatCount: 6,
      deskCount: 3,
      desksPerRow: 3,
      deskRows: 1,
    })
    const { furniture, seatUids } = decorateProjectRoom(room)
    expect(seatUids).toHaveLength(6)
    expect(furniture.filter(f => f.uid.startsWith('bigteam:desk-'))).toHaveLength(3)
    // Should still have decorations
    expect(furniture.length).toBeGreaterThan(6 + 3 + 3) // chairs + desks + PCs
  })

  it('handles tiny 1-worker room', () => {
    const room = makeRoom({
      name: 'solo',
      roomWidth: 9,
      roomHeight: 7,
      seatCount: 1,
      deskCount: 1,
      desksPerRow: 1,
      deskRows: 1,
    })
    const { furniture, seatUids } = decorateProjectRoom(room)
    expect(seatUids).toHaveLength(1)
    expect(furniture.filter(f => f.uid.startsWith('solo:desk-'))).toHaveLength(1)
    expect(furniture.filter(f => f.uid.startsWith('solo:chair-'))).toHaveLength(1)
  })
})
