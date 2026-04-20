import { describe, it, expect } from 'vitest'
import { generateRoomLayout } from './roomGenerator.js'

describe('generateRoomLayout', () => {
  describe('room sizing based on worker count', () => {
    it('creates 1 desk and 1 chair for 1 worker', () => {
      const { layout, rooms } = generateRoomLayout([{ name: 'solo', agentCount: 1 }])
      const projectRoom = rooms.find(r => r.projectName === 'solo')!
      expect(projectRoom).toBeDefined()
      expect(projectRoom.seatUids).toHaveLength(1)
      // 1 worker → 1 desk (ceil(1/2) = 1)
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
      const chairs = layout.furniture.filter(f => f.uid.startsWith('trio:chair-'))
      expect(chairs).toHaveLength(3)
    })

    it('creates 3 desks and 5 chairs for 5 workers', () => {
      const { layout, rooms } = generateRoomLayout([{ name: 'team', agentCount: 5 }])
      const projectRoom = rooms.find(r => r.projectName === 'team')!
      expect(projectRoom.seatUids).toHaveLength(5)
      const desks = layout.furniture.filter(f => f.uid.startsWith('team:desk-'))
      expect(desks).toHaveLength(3)
      const chairs = layout.furniture.filter(f => f.uid.startsWith('team:chair-'))
      expect(chairs).toHaveLength(5)
    })

    it('creates 4 desks and 8 chairs for 8 workers', () => {
      const { layout, rooms } = generateRoomLayout([{ name: 'big', agentCount: 8 }])
      const projectRoom = rooms.find(r => r.projectName === 'big')!
      expect(projectRoom.seatUids).toHaveLength(8)
      const desks = layout.furniture.filter(f => f.uid.startsWith('big:desk-'))
      expect(desks).toHaveLength(4)
      const chairs = layout.furniture.filter(f => f.uid.startsWith('big:chair-'))
      expect(chairs).toHaveLength(8)
    })
  })

  describe('room height grows with multiple desk rows', () => {
    it('uses single desk row (standard height) for 3 or fewer desks', () => {
      // 6 workers → 3 desks → 1 row of 3, fits in standard height
      const { rooms } = generateRoomLayout([{ name: 'small', agentCount: 6 }])
      const room = rooms.find(r => r.projectName === 'small')!
      expect(room.height).toBe(7) // standard ROOM_HEIGHT
    })

    it('grows taller with 2 desk rows for 4+ desks', () => {
      // 8 workers → 4 desks → 2 rows of 2, needs taller room
      const { rooms } = generateRoomLayout([{ name: 'medium', agentCount: 8 }])
      const room = rooms.find(r => r.projectName === 'medium')!
      // 2 desk rows: interior = 1 + 2*3 = 7, total = 7+2 = 9
      expect(room.height).toBeGreaterThan(7)
    })

    it('grows even taller for very large teams', () => {
      // 14 workers → 7 desks → 3 rows, needs even taller room
      const { rooms } = generateRoomLayout([{ name: 'large', agentCount: 14 }])
      const room = rooms.find(r => r.projectName === 'large')!
      const { rooms: rooms2 } = generateRoomLayout([{ name: 'medium', agentCount: 8 }])
      const medRoom = rooms2.find(r => r.projectName === 'medium')!
      expect(room.height).toBeGreaterThan(medRoom.height)
    })
  })

  describe('room width varies with desk count', () => {
    it('small room for 1 worker (1 desk)', () => {
      const { rooms } = generateRoomLayout([{ name: 'tiny', agentCount: 1 }])
      const room = rooms.find(r => r.projectName === 'tiny')!
      // 1 desk → interiorWidth = max(5, 2 + 1*3) = 5, total = 7
      expect(room.width).toBe(7)
    })

    it('wider room for 2 desks in a row', () => {
      const { rooms } = generateRoomLayout([{ name: 'wider', agentCount: 4 }])
      const room = rooms.find(r => r.projectName === 'wider')!
      // 4 workers → 2 desks, 1 row of 2 → interiorWidth = max(5, 2+2*3) = 8, total = 10
      expect(room.width).toBe(10)
    })

    it('multiple rooms have different widths based on worker count', () => {
      const { rooms } = generateRoomLayout([
        { name: 'small', agentCount: 1 },
        { name: 'bigger', agentCount: 6 },
      ])
      const small = rooms.find(r => r.projectName === 'small')!
      const bigger = rooms.find(r => r.projectName === 'bigger')!
      expect(bigger.width).toBeGreaterThan(small.width)
    })
  })

  describe('activity props are placed correctly', () => {
    it('places bookshelf, PC, and whiteboard in each room', () => {
      const { layout } = generateRoomLayout([{ name: 'proj', agentCount: 2 }])
      expect(layout.furniture.find(f => f.uid === 'proj:bookshelf')).toBeDefined()
      expect(layout.furniture.find(f => f.uid === 'proj:pc')).toBeDefined()
      expect(layout.furniture.find(f => f.uid === 'proj:whiteboard')).toBeDefined()
    })

    it('creates 6 activity spots per room (2 each: bookshelf, PC, whiteboard)', () => {
      const { rooms } = generateRoomLayout([{ name: 'proj', agentCount: 2 }])
      const room = rooms.find(r => r.projectName === 'proj')!
      expect(room.activitySpots).toHaveLength(6)
      expect(room.activitySpots.filter(s => s.toolCategory === 'file_research')).toHaveLength(2)
      expect(room.activitySpots.filter(s => s.toolCategory === 'web_research')).toHaveLength(2)
      expect(room.activitySpots.filter(s => s.toolCategory === 'planning')).toHaveLength(2)
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

    it('garage only has cars for live agents, not total employed', () => {
      // 10 employed workers but only 2 live
      const { layout } = generateRoomLayout([{ name: 'proj', agentCount: 10 }], 2)
      const cars = layout.furniture.filter(f => f.uid.startsWith('garage:car-'))
      expect(cars).toHaveLength(2)
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
