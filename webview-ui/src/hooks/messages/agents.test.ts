import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../vscodeApi.js', () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock('../../notificationSound.js', () => ({ playDoneSound: vi.fn() }))

import { vscode } from '../../vscodeApi.js'
import { playDoneSound } from '../../notificationSound.js'
import {
  handleAgentCreated,
  handleAgentClosed,
  handleExistingAgents,
  handleAgentToolStart,
  handleAgentToolDone,
  handleAgentToolsClear,
  handleAgentSelected,
  handleAgentStatus,
  handleAgentToolPermission,
  handleSubagentToolPermission,
  handleAgentToolPermissionClear,
  handleAgentConference,
  handleSubagentToolStart,
  handleSubagentToolDone,
  handleSubagentClear,
  handleAgentConversation,
  handleAgentConversationHistory,
  handleAgentIdentitySaved,
  handleAgentReidentified,
} from './agents.js'
import { makeCtx, makeCharacter, resolveSet } from './__testHelpers.js'
import type { ToolActivity } from '../../office/types.js'

beforeEach(() => vi.clearAllMocks())

describe('agent lifecycle', () => {
  it('agentCreated adds the agent, selects it, and applies inline metadata', () => {
    const { ctx, os } = makeCtx()
    os.addAgent.mockImplementation((id: number) => os.characters.set(id, makeCharacter(id, { sessionId: 's1' })))
    handleAgentCreated({ type: 'agentCreated', id: 7, sessionId: 's1', name: 'Pam', roleShort: 'Dev' }, ctx)
    expect(resolveSet(ctx.setAgents, [])).toEqual([7])
    expect(ctx.setSelectedAgent).toHaveBeenCalledWith(7)
    expect(os.addAgent).toHaveBeenCalled()
    expect(os.characters.get(7)?.roleShort).toBe('Dev')
    expect(os.regenerateRoomLayout).toHaveBeenCalled()
    expect(vscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'saveAgentSeats' }))
  })

  it('agentCreated does not duplicate an existing id', () => {
    const { ctx } = makeCtx()
    handleAgentCreated({ type: 'agentCreated', id: 7 }, ctx)
    expect(resolveSet(ctx.setAgents, [7])).toEqual([7])
  })

  it('agentClosed removes the agent and prunes all per-agent maps', () => {
    const { ctx, os } = makeCtx()
    handleAgentClosed({ type: 'agentClosed', id: 3 }, ctx)
    expect(resolveSet(ctx.setAgents, [1, 3])).toEqual([1])
    expect(resolveSet(ctx.setSelectedAgent, 3)).toBeNull()
    expect(resolveSet(ctx.setAgentTools, { 3: [], 4: [] } as Record<number, ToolActivity[]>)).toEqual({ 4: [] })
    expect(os.removeAllSubagents).toHaveBeenCalledWith(3)
    expect(os.removeAgent).toHaveBeenCalledWith(3)
  })

  it('existingAgents buffers agents and caches meta', () => {
    const { ctx } = makeCtx()
    handleExistingAgents({ type: 'existingAgents', agents: [2, 1], sessionIds: { 1: 's1' }, agentMeta: { s1: { name: 'A' } } }, ctx)
    expect(ctx.buffer.pendingAgents.map((p) => p.id).sort()).toEqual([1, 2])
    expect(ctx.buffer.cachedMeta.s1).toEqual({ name: 'A' })
    expect(resolveSet(ctx.setAgents, [])).toEqual([1, 2])
  })
})

describe('agent tool activity', () => {
  it('agentToolStart appends a tool and marks the character active', () => {
    const { ctx, os } = makeCtx()
    handleAgentToolStart({ type: 'agentToolStart', id: 1, toolId: 't1', status: 'Read foo' }, ctx)
    expect(resolveSet(ctx.setAgentTools, {} as Record<number, ToolActivity[]>)[1]).toEqual([{ toolId: 't1', status: 'Read foo', done: false }])
    expect(os.setAgentActive).toHaveBeenCalledWith(1, true)
    expect(os.clearPermissionBubble).toHaveBeenCalledWith(1)
  })

  it('agentToolStart dedupes an already-tracked toolId', () => {
    const { ctx } = makeCtx()
    handleAgentToolStart({ type: 'agentToolStart', id: 1, toolId: 't1', status: 'Read' }, ctx)
    const prev = { 1: [{ toolId: 't1', status: 'Read', done: false }] } as Record<number, ToolActivity[]>
    expect(resolveSet(ctx.setAgentTools, prev)).toBe(prev)
  })

  it('agentToolStart spawns a sub-agent character for Subtask: statuses', () => {
    const { ctx, os } = makeCtx()
    os.addSubagent.mockReturnValue(-5)
    handleAgentToolStart({ type: 'agentToolStart', id: 1, toolId: 't1', status: 'Subtask: build' }, ctx)
    expect(os.addSubagent).toHaveBeenCalledWith(1, 't1')
    const subs = resolveSet(ctx.setSubagentCharacters, [])
    expect(subs).toEqual([{ id: -5, parentAgentId: 1, parentToolId: 't1', label: 'build' }])
  })

  it('agentToolDone marks the matching tool done', () => {
    const { ctx } = makeCtx()
    handleAgentToolDone({ type: 'agentToolDone', id: 1, toolId: 't1' }, ctx)
    const prev = { 1: [{ toolId: 't1', status: 'x', done: false }] } as Record<number, ToolActivity[]>
    expect(resolveSet(ctx.setAgentTools, prev)[1][0].done).toBe(true)
  })

  it('agentToolsClear drops tools/subs and clears the bubble', () => {
    const { ctx, os } = makeCtx()
    handleAgentToolsClear({ type: 'agentToolsClear', id: 1 }, ctx)
    expect(resolveSet(ctx.setAgentTools, { 1: [], 2: [] } as Record<number, ToolActivity[]>)).toEqual({ 2: [] })
    expect(os.removeAllSubagents).toHaveBeenCalledWith(1)
    expect(os.setAgentTool).toHaveBeenCalledWith(1, null)
  })

  it('agentSelected sets the selected agent', () => {
    const { ctx } = makeCtx()
    handleAgentSelected({ type: 'agentSelected', id: 9 }, ctx)
    expect(ctx.setSelectedAgent).toHaveBeenCalledWith(9)
  })

  it('agentStatus=waiting shows a bubble and plays the chime', () => {
    const { ctx, os } = makeCtx()
    handleAgentStatus({ type: 'agentStatus', id: 1, status: 'waiting' }, ctx)
    expect(resolveSet(ctx.setAgentStatuses, {})).toEqual({ 1: 'waiting' })
    expect(os.showWaitingBubble).toHaveBeenCalledWith(1)
    expect(playDoneSound).toHaveBeenCalled()
  })

  it('agentStatus=active removes the entry and does not chime', () => {
    const { ctx, os } = makeCtx()
    handleAgentStatus({ type: 'agentStatus', id: 1, status: 'active' }, ctx)
    expect(resolveSet(ctx.setAgentStatuses, { 1: 'waiting' })).toEqual({})
    expect(os.setAgentActive).toHaveBeenCalledWith(1, true)
    expect(playDoneSound).not.toHaveBeenCalled()
  })

  it('agentToolPermission flags undone tools and shows the bubble', () => {
    const { ctx, os } = makeCtx()
    handleAgentToolPermission({ type: 'agentToolPermission', id: 1 }, ctx)
    const prev = { 1: [{ toolId: 't', status: 'x', done: false }] } as Record<number, ToolActivity[]>
    expect(resolveSet(ctx.setAgentTools, prev)[1][0].permissionWait).toBe(true)
    expect(os.showPermissionBubble).toHaveBeenCalledWith(1)
  })

  it('agentToolPermissionClear unflags and clears parent + sub bubbles', () => {
    const { ctx, os } = makeCtx()
    os.subagentMeta.set(-1, { parentAgentId: 1 })
    handleAgentToolPermissionClear({ type: 'agentToolPermissionClear', id: 1 }, ctx)
    const prev = { 1: [{ toolId: 't', status: 'x', done: false, permissionWait: true }] } as Record<number, ToolActivity[]>
    expect(resolveSet(ctx.setAgentTools, prev)[1][0].permissionWait).toBe(false)
    expect(os.clearPermissionBubble).toHaveBeenCalledWith(1)
    expect(os.clearPermissionBubble).toHaveBeenCalledWith(-1)
  })

  it('agentConference forwards to os.sendToConference', () => {
    const { ctx, os } = makeCtx()
    handleAgentConference({ type: 'agentConference', readerId: 1, targetId: 2 }, ctx)
    expect(os.sendToConference).toHaveBeenCalledWith(1, 2)
  })
})

describe('sub-agents', () => {
  it('subagentToolPermission shows a bubble on the resolved sub id', () => {
    const { ctx, os } = makeCtx()
    os.getSubagentId.mockReturnValue(-3)
    handleSubagentToolPermission({ type: 'subagentToolPermission', id: 1, parentToolId: 'p' }, ctx)
    expect(os.showPermissionBubble).toHaveBeenCalledWith(-3)
  })

  it('subagentToolStart records the tool and activates the sub character', () => {
    const { ctx, os } = makeCtx()
    os.getSubagentId.mockReturnValue(-3)
    handleSubagentToolStart({ type: 'subagentToolStart', id: 1, parentToolId: 'p', toolId: 't', status: 'Read' }, ctx)
    const prev = {} as Record<number, Record<string, ToolActivity[]>>
    expect(resolveSet(ctx.setSubagentTools, prev)[1].p).toEqual([{ toolId: 't', status: 'Read', done: false }])
    expect(os.setAgentActive).toHaveBeenCalledWith(-3, true)
  })

  it('subagentToolDone marks the nested tool done', () => {
    const { ctx } = makeCtx()
    handleSubagentToolDone({ type: 'subagentToolDone', id: 1, parentToolId: 'p', toolId: 't' }, ctx)
    const prev = { 1: { p: [{ toolId: 't', status: 'x', done: false }] } } as Record<number, Record<string, ToolActivity[]>>
    expect(resolveSet(ctx.setSubagentTools, prev)[1].p[0].done).toBe(true)
  })

  it('subagentClear removes the sub tools + character', () => {
    const { ctx, os } = makeCtx()
    handleSubagentClear({ type: 'subagentClear', id: 1, parentToolId: 'p' }, ctx)
    const prev = { 1: { p: [] } } as Record<number, Record<string, ToolActivity[]>>
    expect(resolveSet(ctx.setSubagentTools, prev)).toEqual({})
    expect(os.removeSubagent).toHaveBeenCalledWith(1, 'p')
  })
})

describe('conversation + identity', () => {
  it('agentConversation appends entries', () => {
    const { ctx } = makeCtx()
    handleAgentConversation({ type: 'agentConversation', id: 1, entries: [{ role: 'user', text: 'hi' }] }, ctx)
    const next = resolveSet(ctx.setAgentConversation, { 1: [] } as Record<number, unknown[]>)
    expect(next[1]).toHaveLength(1)
  })

  it('agentConversationHistory loads history when the agent has no entries yet', () => {
    const { ctx } = makeCtx()
    handleAgentConversationHistory({ type: 'agentConversationHistory', id: 1, entries: [{ role: 'user', text: 'hi' }] }, ctx)
    const next = resolveSet(ctx.setAgentConversation, {} as Record<number, unknown[]>)
    expect(next[1]).toHaveLength(1)
  })

  it('agentConversationHistory is a no-op when entries already exist (no duplication)', () => {
    const { ctx } = makeCtx()
    handleAgentConversationHistory({ type: 'agentConversationHistory', id: 1, entries: [{ role: 'user', text: 'history' }] }, ctx)
    // Live entries already present → history must NOT append/duplicate.
    const prev = { 1: [{ role: 'user', text: 'live' }] } as Record<number, unknown[]>
    const next = resolveSet(ctx.setAgentConversation, prev)
    expect(next).toBe(prev)
    expect(next[1]).toHaveLength(1)
    expect(next[1][0]).toEqual({ role: 'user', text: 'live' })
  })

  it('agentIdentitySaved links persistentAgentId by session and applies fields', () => {
    const { ctx, os } = makeCtx()
    os.characters.set(1, makeCharacter(1, { sessionId: 's1' }))
    handleAgentIdentitySaved({ type: 'agentIdentitySaved', agentId: 'PA1', agent: { currentSessionId: 's1', name: 'Kev' } }, ctx)
    expect(os.characters.get(1)?.persistentAgentId).toBe('PA1')
    expect(os.characters.get(1)?.name).toBe('Kev')
    expect(vscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'saveAgentSeats' }))
  })

  it('agentReidentified updates the live character in place and regroups', () => {
    const { ctx, os } = makeCtx()
    os.characters.set(1, makeCharacter(1, { sessionId: 's1' }))
    handleAgentReidentified({ type: 'agentReidentified', id: 1, name: 'Ann', persistentAgentId: 'PA9' }, ctx)
    expect(os.characters.get(1)?.name).toBe('Ann')
    expect(os.regroupCharacterUnderEmployee).toHaveBeenCalledWith(1)
    expect(resolveSet(ctx.setPendingWorkers, [{ sessionId: 's1' }])).toEqual([])
  })
})
