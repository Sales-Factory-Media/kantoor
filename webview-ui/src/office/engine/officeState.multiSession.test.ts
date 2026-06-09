import { describe, it, expect } from 'vitest'
import { OfficeState } from './officeState.js'
import { TASK_PIP_COLOR_WAITING, TASK_PIP_COLOR_PERMISSION } from '../../constants.js'

/**
 * Multi-session grouping ("One Pam + pips"): an employee running several
 * concurrent sessions shows ONE visible body (the primary) plus hidden
 * "follower" task-bodies that surface as clickable pips.
 */

// addAgent(id, palette?, hueShift?, seatId?, skipSpawnEffect?, folderName?, sessionId?, name?, persistentAgentId?)
function addSession(os: OfficeState, id: number, sessionId: string, persistentAgentId: string) {
  os.addAgent(id, undefined, undefined, undefined, true, undefined, sessionId, 'Pam', persistentAgentId)
}

describe('OfficeState multi-session grouping', () => {
  it("creates a follower for an employee's second session (one visible body)", () => {
    const os = new OfficeState()
    addSession(os, 1, 's1', 'emp-pam')
    addSession(os, 2, 's2', 'emp-pam')

    const primary = os.characters.get(1)!
    const follower = os.characters.get(2)!
    expect(primary.followerOf == null).toBe(true)
    expect(follower.followerOf).toBe(1)
    // Follower holds no seat; it shares the primary's position.
    expect(follower.seatId).toBeNull()
    expect(follower.x).toBe(primary.x)
    expect(follower.y).toBe(primary.y)
    // getCharacters() (drawn + hit-tested bodies) excludes followers.
    const bodyIds = os.getCharacters().map(c => c.id)
    expect(bodyIds).toContain(1)
    expect(bodyIds).not.toContain(2)
  })

  it('keeps separate bodies for different employees', () => {
    const os = new OfficeState()
    addSession(os, 1, 's1', 'emp-pam')
    addSession(os, 2, 's2', 'emp-jim')
    expect(os.characters.get(1)!.followerOf == null).toBe(true)
    expect(os.characters.get(2)!.followerOf == null).toBe(true)
    expect(os.getCharacters().map(c => c.id).sort()).toEqual([1, 2])
  })
})

describe('OfficeState task pips', () => {
  it('emits no pips for a single-session employee', () => {
    const os = new OfficeState()
    addSession(os, 1, 's1', 'emp-pam')
    expect(os.getTaskPips()).toHaveLength(0)
  })

  it('emits one pip per task for a multitasking employee', () => {
    const os = new OfficeState()
    addSession(os, 1, 's1', 'emp-pam')
    addSession(os, 2, 's2', 'emp-pam')
    addSession(os, 3, 's3', 'emp-pam')
    const pips = os.getTaskPips()
    expect(pips).toHaveLength(3)
    expect(pips.map(p => p.memberId).sort()).toEqual([1, 2, 3])
  })

  it('reflects per-task status in the pip color', () => {
    const os = new OfficeState()
    addSession(os, 1, 's1', 'emp-pam')
    addSession(os, 2, 's2', 'emp-pam')
    os.showWaitingBubble(1) // primary task finished a turn
    os.showPermissionBubble(2) // follower task needs a decision
    const pip1 = os.getTaskPips().find(p => p.memberId === 1)!
    const pip2 = os.getTaskPips().find(p => p.memberId === 2)!
    expect(pip1.color).toBe(TASK_PIP_COLOR_WAITING)
    expect(pip2.color).toBe(TASK_PIP_COLOR_PERMISSION)
  })

  it('hit-tests a pip at its center and returns the task id', () => {
    const os = new OfficeState()
    addSession(os, 1, 's1', 'emp-pam')
    addSession(os, 2, 's2', 'emp-pam')
    const pip = os.getTaskPips()[0]
    const hit = os.getPipAt(pip.x + pip.size / 2, pip.y + pip.size / 2)
    expect(hit).toBe(pip.memberId)
  })

  it('returns null when no pip is under the point', () => {
    const os = new OfficeState()
    addSession(os, 1, 's1', 'emp-pam')
    addSession(os, 2, 's2', 'emp-pam')
    expect(os.getPipAt(-9999, -9999)).toBeNull()
  })
})

describe('OfficeState removeAgent with task groups', () => {
  it('removing a follower leaves the primary intact', () => {
    const os = new OfficeState()
    addSession(os, 1, 's1', 'emp-pam')
    addSession(os, 2, 's2', 'emp-pam')
    os.removeAgent(2)
    expect(os.characters.has(2)).toBe(false)
    expect(os.characters.has(1)).toBe(true)
    expect(os.getTaskPips()).toHaveLength(0) // back to a single task
  })

  it('removing the primary promotes a follower to take over the desk', () => {
    const os = new OfficeState()
    addSession(os, 1, 's1', 'emp-pam')
    addSession(os, 2, 's2', 'emp-pam')
    const seatBefore = os.characters.get(1)!.seatId
    os.removeAgent(1)
    expect(os.characters.has(1)).toBe(false)
    const promoted = os.characters.get(2)!
    expect(promoted.followerOf == null).toBe(true) // now the visible body
    expect(promoted.seatId).toBe(seatBefore) // inherited the desk
    expect(os.getCharacters().map(c => c.id)).toEqual([2])
  })

  it('keeps the last session a normal (despawning) removal', () => {
    const os = new OfficeState()
    addSession(os, 1, 's1', 'emp-pam')
    os.removeAgent(1)
    // Normal removal path starts a despawn animation rather than promoting.
    expect(os.characters.get(1)!.matrixEffect).toBe('despawn')
  })
})

describe('OfficeState regroupCharacterUnderEmployee', () => {
  it('folds a late-identified session into an already-working employee', () => {
    const os = new OfficeState()
    // Two independent bodies first (e.g. a fresh provisional session + the
    // employee already working), each its own primary.
    addSession(os, 1, 's1', 'emp-pam')
    os.addAgent(2, undefined, undefined, undefined, true, undefined, 's2', 'Pam', 'provisional-x')
    expect(os.getCharacters().map(c => c.id).sort()).toEqual([1, 2])

    // The popup resolves session 2 onto the same employee as session 1.
    os.characters.get(2)!.persistentAgentId = 'emp-pam'
    os.regroupCharacterUnderEmployee(2)

    expect(os.characters.get(2)!.followerOf).toBe(1) // demoted to a pip
    expect(os.characters.get(2)!.seatId).toBeNull()
    expect(os.getCharacters().map(c => c.id)).toEqual([1])
    expect(os.getTaskPips()).toHaveLength(2)
  })
})
