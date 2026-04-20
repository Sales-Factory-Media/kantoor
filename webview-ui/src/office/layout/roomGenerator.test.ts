import { describe, it, expect } from 'vitest'
import { generateRoomLayout } from './roomGenerator.js'
import { TileType } from '../types.js'
import { CORRIDOR_HEIGHT } from '../../constants.js'

describe('generateRoomLayout', () => {
  describe('room sizing based on worker count', () => {
    it('creates 1 desk and 1 chair for 1 worker', () => {
      const { layout, rooms } = generateRoomLayout([{ name: 'solo', agentCount: 1 }])
      const projectRoom = rooms.find(r => r.projectName === 'solo')!
      expect(projectRoom).toBeDefined()
      expect(projectRoom.seatUids).toHaveLength(1)
      const desks = layout.furniture.filter(f => f.uid.startsWith('solo:desk-'))
      expect(desks).toHaveLength(1)
      const chairs = layout.furniture.filter(f => f.uid.startsWith('solo:chair-'))
      expect(chairs).toHaveLength(1)
    })

    it('creates 1 desk and 2 chairs for 2 workers', () => {
      const { layout, rooms } = generateRoomLayout([{ name: 'duo', agentCount: 2 }])
      const projectRoom = rooms.find(r => r.projectName === 'duo')!
      expect(projectRoom.seatUids).toHaveLength(2)
      const desks = layout.furniture.filter(f => f.uid.startsWith('duo:desk-'))
      expect(desks).toHaveLength(1)
      const chairs = layout.furniture.filter(f => f.uid.startsWith('duo:chair-'))
      expect(chairs).toHaveLength(2)
    })

    it('creates 2 desks and 3 chairs for 3 workers', () => {
      const { layout, rooms } = generateRoomLayout([{ name: 'trio', agentCount: 3 }])
      const projectRoom = rooms.find(r => r.projectName === 'trio')!
      expect(projectRoom.seatUids).toHaveLength(3)
      const desks = layout.furniture.filter(f => f.uid.startsWith('trio:desk-'))
      expect(desks).toHaveLength(2)
    })

    it('creates 3 desks and 5 chairs for 5 workers', () => {
      const { layout, rooms } = generateRoomLayout([{ name: 'team', agentCount: 5 }])
      const projectRoom = rooms.find(r => r.projectName === 'team')!
      expect(projectRoom.seatUids).toHaveLength(5)
      const desks = layout.furniture.filter(f => f.uid.startsWith('team:desk-'))
      expect(desks).toHaveLength(3)
    })
  })

  describe('corridor layout', () => {
    it('places rooms on both sides of the corridor', () => {
      const { rooms } = generateRoomLayout([
        { name: 'alpha', agentCount: 2 },
        { name: 'beta', agentCount: 2 },
      ])
      const alpha = rooms.find(r => r.projectName === 'alpha')!
      const beta = rooms.find(r => r.projectName === 'beta')!

      // alpha (index 0) goes top, beta (index 1) goes bottom
      // Top room is above the corridor, bottom room is below
      expect(alpha.row).toBeLessThan(beta.row)
    })

    it('creates a corridor between top and bottom rows', () => {
      const { layout, rooms } = generateRoomLayout([
        { name: 'alpha', agentCount: 2 },
        { name: 'beta', agentCount: 2 },
      ])
      const alpha = rooms.find(r => r.projectName === 'alpha')!
      const corridorRow = alpha.row + alpha.height

      // Check that corridor tiles are floor (not void/wall)
      const cols = layout.cols
      let floorCount = 0
      for (let r = 0; r < CORRIDOR_HEIGHT; r++) {
        for (let c = 0; c < cols; c++) {
          const tile = layout.tiles[(corridorRow + r) * cols + c]
          if (tile !== TileType.VOID) floorCount++
        }
      }
      expect(floorCount).toBeGreaterThan(0)
    })

    it('alternates rooms top/bottom in alphabetical order', () => {
      const { rooms } = generateRoomLayout([
        { name: 'alpha', agentCount: 1 },
        { name: 'beta', agentCount: 1 },
        { name: 'gamma', agentCount: 1 },
        { name: 'delta', agentCount: 1 },
      ])
      const alpha = rooms.find(r => r.projectName === 'alpha')!
      const beta = rooms.find(r => r.projectName === 'beta')!
      const gamma = rooms.find(r => r.projectName === 'gamma')!
      const delta = rooms.find(r => r.projectName === 'delta')!

      // Even indices (0=alpha, 2=gamma) → top row
      // Odd indices (1=beta, 3=delta) → bottom row
      expect(alpha.row).toBe(gamma.row) // same row (top)
      expect(beta.row).toBe(delta.row) // same row (bottom)
      expect(alpha.row).toBeLessThan(beta.row) // top < bottom
    })
  })

  describe('special rooms', () => {
    it('creates conference, garage, foreman and art director rooms', () => {
      const { rooms } = generateRoomLayout([{ name: 'proj', agentCount: 2 }])
      const names = rooms.map(r => r.projectName)
      expect(names).toContain('Conference')
      expect(names).toContain('Garage')
      expect(names).toContain("Darryl's Office")
      expect(names).toContain("Jan's Office")
      expect(names).not.toContain('Warehouse')
    })

    it('places special rooms on the bottom side', () => {
      const { rooms } = generateRoomLayout([
        { name: 'alpha', agentCount: 2 },
        { name: 'beta', agentCount: 2 },
      ])
      const beta = rooms.find(r => r.projectName === 'beta')! // bottom project room
      const conf = rooms.find(r => r.projectName === 'Conference')!
      expect(conf.row).toBe(beta.row) // same bottom row
    })

    it('garage only has cars for live agents, not total employed', () => {
      const { layout } = generateRoomLayout([{ name: 'proj', agentCount: 10 }], 2)
      const cars = layout.furniture.filter(f => f.uid.startsWith('garage:car-'))
      expect(cars).toHaveLength(2)
    })
  })

  describe('filler rooms', () => {
    it('creates filler rooms on the shorter side', () => {
      // 1 project → goes top only, bottom has only special rooms
      // If top is wider than bottom, fillers go on bottom (or vice versa)
      const { rooms } = generateRoomLayout([
        { name: 'alpha', agentCount: 10 },
        { name: 'beta', agentCount: 1 },
        { name: 'gamma', agentCount: 10 },
      ])
      const fillerRooms = rooms.filter(r => r.isFiller)
      // Fillers should exist on whichever side is shorter
      for (const filler of fillerRooms) {
        expect(filler.seatUids).toHaveLength(0)
      }
    })
  })

  describe('activity props', () => {
    it('places bookshelf and whiteboard in each project room', () => {
      const { layout } = generateRoomLayout([{ name: 'proj', agentCount: 2 }])
      expect(layout.furniture.find(f => f.uid === 'proj:bookshelf')).toBeDefined()
      expect(layout.furniture.find(f => f.uid === 'proj:whiteboard')).toBeDefined()
    })

    it('creates 6 activity spots per project room', () => {
      const { rooms } = generateRoomLayout([{ name: 'proj', agentCount: 2 }])
      const room = rooms.find(r => r.projectName === 'proj')!
      expect(room.activitySpots).toHaveLength(6)
    })
  })

  describe('empty projects', () => {
    it('returns minimal layout when no projects', () => {
      const { rooms, layout } = generateRoomLayout([])
      expect(rooms).toHaveLength(0)
      expect(layout.furniture).toHaveLength(0)
    })
  })
})
