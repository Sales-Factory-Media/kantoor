/**
 * Agent-domain message handlers: agent lifecycle, tool activity, sub-agents,
 * conversation, and live-character identity updates.
 */

import { extractToolName } from '../../office/toolUtils.js'
import { playDoneSound } from '../../notificationSound.js'
import { CONVERSATION_MAX_ENTRIES } from '../../constants.js'
import type { ConversationEntry } from '../../office/types.js'
import type { SubagentCharacter } from '../useExtensionMessages.js'
import { type HandlerCtx, type SeatMeta, pickRandomCarType, saveAgentMeta } from './ctx.js'

export function handleAgentCreated(msg: Record<string, unknown>, ctx: HandlerCtx): void {
  const os = ctx.getOfficeState()
  const id = msg.id as number
  const sessionId = msg.sessionId as string | undefined
  const folderName = msg.folderName as string | undefined
  // Check cached metadata first, fall back to metadata embedded in the message
  const cached = sessionId ? ctx.buffer.cachedMeta[sessionId] : undefined
  const inline = msg.name ? { name: msg.name as string, palette: msg.palette as number | undefined, hueShift: msg.hueShift as number | undefined, seatId: msg.seatId as string | undefined, roleShort: msg.roleShort as string | undefined, roleFull: msg.roleFull as string | undefined, workspacePath: msg.workspacePath as string | undefined, persistentAgentId: msg.persistentAgentId as string | undefined, avatarConfig: msg.avatarConfig as string | undefined, sessionCount: msg.sessionCount as number | undefined, lastSessionEnd: msg.lastSessionEnd as string | undefined } : undefined
  const m = cached || inline
  ctx.setAgents((prev) => (prev.includes(id) ? prev : [...prev, id]))
  ctx.setSelectedAgent(id)
  os.addAgent(id, m?.palette, m?.hueShift, m?.seatId, undefined, folderName, sessionId, m?.name, m?.persistentAgentId)
  {
    const ch = os.characters.get(id)
    if (ch) {
      if (m?.roleShort) ch.roleShort = m.roleShort
      if (m?.roleFull) ch.roleFull = m.roleFull
      if (m?.workspacePath) ch.workspacePath = m.workspacePath
      if (m?.persistentAgentId) ch.persistentAgentId = m.persistentAgentId
      if (m?.avatarConfig) ch.avatarConfig = m.avatarConfig
      if (m?.sessionCount !== undefined) ch.sessionCount = m.sessionCount
      if (m?.lastSessionEnd !== undefined) ch.lastSessionEnd = m.lastSessionEnd
      // taskTitle rides on the message itself (live-session state), not seat meta.
      if (msg.taskTitle !== undefined) ch.taskTitle = msg.taskTitle as string
      ch.carType = (m as Record<string, unknown>)?.carType as string || pickRandomCarType()
    }
  }
  os.regenerateRoomLayout(ctx.knownProjectsRef.current, ctx.offlineAgentsRef.current)
  saveAgentMeta(ctx)
}

export function handleAgentClosed(msg: Record<string, unknown>, ctx: HandlerCtx): void {
  const os = ctx.getOfficeState()
  const id = msg.id as number
  ctx.setAgents((prev) => prev.filter((a) => a !== id))
  ctx.setSelectedAgent((prev) => (prev === id ? null : prev))
  ctx.setAgentTools((prev) => {
    if (!(id in prev)) return prev
    const next = { ...prev }
    delete next[id]
    return next
  })
  ctx.setAgentStatuses((prev) => {
    if (!(id in prev)) return prev
    const next = { ...prev }
    delete next[id]
    return next
  })
  ctx.setSubagentTools((prev) => {
    if (!(id in prev)) return prev
    const next = { ...prev }
    delete next[id]
    return next
  })
  ctx.setAgentConversation((prev) => {
    if (!(id in prev)) return prev
    const next = { ...prev }
    delete next[id]
    return next
  })
  // Remove all sub-agent characters belonging to this agent
  os.removeAllSubagents(id)
  ctx.setSubagentCharacters((prev) => prev.filter((s) => s.parentAgentId !== id))
  os.removeAgent(id)
  os.regenerateRoomLayout(ctx.knownProjectsRef.current, ctx.offlineAgentsRef.current)
}

export function handleExistingAgents(msg: Record<string, unknown>, ctx: HandlerCtx): void {
  const incoming = msg.agents as number[]
  const meta = (msg.agentMeta || {}) as Record<string, SeatMeta>
  const sessionIds = (msg.sessionIds || {}) as Record<number, string>
  const folderNames = (msg.folderNames || {}) as Record<number, string>
  const taskTitles = (msg.taskTitles || {}) as Record<number, string>
  // Cache metadata for later lookups (e.g. new agents arriving with known sessionId)
  ctx.buffer.cachedMeta = { ...ctx.buffer.cachedMeta, ...meta }
  // Buffer agents — they'll be added in layoutLoaded after seats are built
  for (const id of incoming) {
    const sid = sessionIds[id]
    // Try sessionId-keyed metadata first, fall back to agentId-keyed (extension compat)
    const m = (sid ? meta[sid] : undefined) || meta[id]
    ctx.buffer.pendingAgents.push({ id, palette: m?.palette, hueShift: m?.hueShift, seatId: m?.seatId, name: m?.name, sessionId: sid, folderName: folderNames[id], roleShort: m?.roleShort, roleFull: m?.roleFull, workspacePath: m?.workspacePath, persistentAgentId: m?.persistentAgentId, carType: m?.carType, avatarConfig: m?.avatarConfig, sessionCount: m?.sessionCount, lastSessionEnd: m?.lastSessionEnd, taskTitle: taskTitles[id] })
  }
  ctx.setAgents((prev) => {
    const ids = new Set(prev)
    const merged = [...prev]
    for (const id of incoming) {
      if (!ids.has(id)) {
        merged.push(id)
      }
    }
    return merged.sort((a, b) => a - b)
  })
}

export function handleAgentToolStart(msg: Record<string, unknown>, ctx: HandlerCtx): void {
  const os = ctx.getOfficeState()
  const id = msg.id as number
  const toolId = msg.toolId as string
  const status = msg.status as string
  ctx.setAgentTools((prev) => {
    const list = prev[id] || []
    if (list.some((t) => t.toolId === toolId)) return prev
    return { ...prev, [id]: [...list, { toolId, status, done: false }] }
  })
  const toolName = extractToolName(status)
  os.setAgentTool(id, toolName)
  os.setAgentActive(id, true)
  os.clearPermissionBubble(id)
  // Create sub-agent character for Task tool subtasks
  if (status.startsWith('Subtask:')) {
    const label = status.slice('Subtask:'.length).trim()
    const subId = os.addSubagent(id, toolId)
    ctx.setSubagentCharacters((prev) => {
      if (prev.some((s) => s.id === subId)) return prev
      return [...prev, { id: subId, parentAgentId: id, parentToolId: toolId, label }]
    })
  }
}

export function handleAgentToolDone(msg: Record<string, unknown>, ctx: HandlerCtx): void {
  const id = msg.id as number
  const toolId = msg.toolId as string
  ctx.setAgentTools((prev) => {
    const list = prev[id]
    if (!list) return prev
    return {
      ...prev,
      [id]: list.map((t) => (t.toolId === toolId ? { ...t, done: true } : t)),
    }
  })
}

export function handleAgentToolsClear(msg: Record<string, unknown>, ctx: HandlerCtx): void {
  const os = ctx.getOfficeState()
  const id = msg.id as number
  ctx.setAgentTools((prev) => {
    if (!(id in prev)) return prev
    const next = { ...prev }
    delete next[id]
    return next
  })
  ctx.setSubagentTools((prev) => {
    if (!(id in prev)) return prev
    const next = { ...prev }
    delete next[id]
    return next
  })
  // Remove all sub-agent characters belonging to this agent
  os.removeAllSubagents(id)
  ctx.setSubagentCharacters((prev) => prev.filter((s) => s.parentAgentId !== id))
  os.setAgentTool(id, null)
  os.clearPermissionBubble(id)
}

export function handleAgentSelected(msg: Record<string, unknown>, ctx: HandlerCtx): void {
  const id = msg.id as number
  ctx.setSelectedAgent(id)
}

export function handleAgentStatus(msg: Record<string, unknown>, ctx: HandlerCtx): void {
  const os = ctx.getOfficeState()
  const id = msg.id as number
  const status = msg.status as string
  ctx.setAgentStatuses((prev) => {
    if (status === 'active') {
      if (!(id in prev)) return prev
      const next = { ...prev }
      delete next[id]
      return next
    }
    return { ...prev, [id]: status }
  })
  os.setAgentActive(id, status === 'active')
  if (status === 'waiting') {
    os.showWaitingBubble(id)
    playDoneSound()
  }
}

export function handleAgentToolPermission(msg: Record<string, unknown>, ctx: HandlerCtx): void {
  const os = ctx.getOfficeState()
  const id = msg.id as number
  ctx.setAgentTools((prev) => {
    const list = prev[id]
    if (!list) return prev
    return {
      ...prev,
      [id]: list.map((t) => (t.done ? t : { ...t, permissionWait: true })),
    }
  })
  os.showPermissionBubble(id)
}

export function handleSubagentToolPermission(msg: Record<string, unknown>, ctx: HandlerCtx): void {
  const os = ctx.getOfficeState()
  const id = msg.id as number
  const parentToolId = msg.parentToolId as string
  // Show permission bubble on the sub-agent character
  const subId = os.getSubagentId(id, parentToolId)
  if (subId !== null) {
    os.showPermissionBubble(subId)
  }
}

export function handleAgentToolPermissionClear(msg: Record<string, unknown>, ctx: HandlerCtx): void {
  const os = ctx.getOfficeState()
  const id = msg.id as number
  ctx.setAgentTools((prev) => {
    const list = prev[id]
    if (!list) return prev
    const hasPermission = list.some((t) => t.permissionWait)
    if (!hasPermission) return prev
    return {
      ...prev,
      [id]: list.map((t) => (t.permissionWait ? { ...t, permissionWait: false } : t)),
    }
  })
  os.clearPermissionBubble(id)
  // Also clear permission bubbles on all sub-agent characters of this parent
  for (const [subId, meta] of os.subagentMeta) {
    if (meta.parentAgentId === id) {
      os.clearPermissionBubble(subId)
    }
  }
}

export function handleAgentConference(msg: Record<string, unknown>, ctx: HandlerCtx): void {
  const os = ctx.getOfficeState()
  const readerId = msg.readerId as number
  const targetId = msg.targetId as number
  os.sendToConference(readerId, targetId)
}

export function handleSubagentToolStart(msg: Record<string, unknown>, ctx: HandlerCtx): void {
  const os = ctx.getOfficeState()
  const id = msg.id as number
  const parentToolId = msg.parentToolId as string
  const toolId = msg.toolId as string
  const status = msg.status as string
  ctx.setSubagentTools((prev) => {
    const agentSubs = prev[id] || {}
    const list = agentSubs[parentToolId] || []
    if (list.some((t) => t.toolId === toolId)) return prev
    return { ...prev, [id]: { ...agentSubs, [parentToolId]: [...list, { toolId, status, done: false }] } }
  })
  // Update sub-agent character's tool and active state
  const subId = os.getSubagentId(id, parentToolId)
  if (subId !== null) {
    const subToolName = extractToolName(status)
    os.setAgentTool(subId, subToolName)
    os.setAgentActive(subId, true)
  }
}

export function handleSubagentToolDone(msg: Record<string, unknown>, ctx: HandlerCtx): void {
  const id = msg.id as number
  const parentToolId = msg.parentToolId as string
  const toolId = msg.toolId as string
  ctx.setSubagentTools((prev) => {
    const agentSubs = prev[id]
    if (!agentSubs) return prev
    const list = agentSubs[parentToolId]
    if (!list) return prev
    return {
      ...prev,
      [id]: { ...agentSubs, [parentToolId]: list.map((t) => (t.toolId === toolId ? { ...t, done: true } : t)) },
    }
  })
}

export function handleSubagentClear(msg: Record<string, unknown>, ctx: HandlerCtx): void {
  const os = ctx.getOfficeState()
  const id = msg.id as number
  const parentToolId = msg.parentToolId as string
  ctx.setSubagentTools((prev) => {
    const agentSubs = prev[id]
    if (!agentSubs || !(parentToolId in agentSubs)) return prev
    const next = { ...agentSubs }
    delete next[parentToolId]
    if (Object.keys(next).length === 0) {
      const outer = { ...prev }
      delete outer[id]
      return outer
    }
    return { ...prev, [id]: next }
  })
  // Remove sub-agent character
  os.removeSubagent(id, parentToolId)
  ctx.setSubagentCharacters((prev) => prev.filter((s: SubagentCharacter) => !(s.parentAgentId === id && s.parentToolId === parentToolId)))
}

export function handleAgentConversation(msg: Record<string, unknown>, ctx: HandlerCtx): void {
  const id = msg.id as number
  const entries = msg.entries as ConversationEntry[]
  ctx.setAgentConversation((prev) => {
    const existing = prev[id] || []
    const merged = [...existing, ...entries]
    return { ...prev, [id]: merged.length > CONVERSATION_MAX_ENTRIES ? merged.slice(-CONVERSATION_MAX_ENTRIES) : merged }
  })
}

export function handleAgentConversationHistory(msg: Record<string, unknown>, ctx: HandlerCtx): void {
  const id = msg.id as number
  const entries = msg.entries as ConversationEntry[]
  ctx.setAgentConversation((prev) => {
    const existing = prev[id] || []
    const merged = [...existing, ...entries]
    return { ...prev, [id]: merged.length > CONVERSATION_MAX_ENTRIES ? merged.slice(-CONVERSATION_MAX_ENTRIES) : merged }
  })
}

export function handleAgentIdentitySaved(msg: Record<string, unknown>, ctx: HandlerCtx): void {
  const os = ctx.getOfficeState()
  // Link the persistent agent ID to the live character
  const agentId = msg.agentId as string
  for (const ch of os.characters.values()) {
    if (ch.sessionId && ch.persistentAgentId === undefined) {
      // Check if this character's session matches any of the saved agent data
      const savedAgent = msg.agent as { currentSessionId?: string } | undefined
      if (savedAgent?.currentSessionId === ch.sessionId) {
        ch.persistentAgentId = agentId
      }
    }
    // Also match if we just saved for this character
    if (ch.persistentAgentId === agentId) {
      const savedAgent = msg.agent as { name?: string; roleShort?: string; roleFull?: string; workspacePath?: string; avatarConfig?: string } | undefined
      if (savedAgent) {
        if (savedAgent.name) ch.name = savedAgent.name
        if (savedAgent.roleShort !== undefined) ch.roleShort = savedAgent.roleShort
        if (savedAgent.roleFull !== undefined) ch.roleFull = savedAgent.roleFull
        if (savedAgent.workspacePath !== undefined) ch.workspacePath = savedAgent.workspacePath
        if (savedAgent.avatarConfig !== undefined) ch.avatarConfig = savedAgent.avatarConfig
      }
    }
  }
  saveAgentMeta(ctx)
}

export function handleAgentReidentified(msg: Record<string, unknown>, ctx: HandlerCtx): void {
  const os = ctx.getOfficeState()
  // The user resolved a "who's this?" popup — update the live character in
  // place (name/role/appearance) without tearing it down.
  const id = msg.id as number
  const ch = os.characters.get(id)
  if (ch) {
    if (msg.name !== undefined) ch.name = msg.name as string
    if (msg.roleShort !== undefined) ch.roleShort = msg.roleShort as string
    if (msg.roleFull !== undefined) ch.roleFull = msg.roleFull as string
    if (msg.workspacePath !== undefined) ch.workspacePath = (msg.workspacePath as string) || undefined
    if (msg.palette !== undefined && msg.palette !== null) ch.palette = msg.palette as number
    if (msg.hueShift !== undefined && msg.hueShift !== null) ch.hueShift = msg.hueShift as number
    if (msg.persistentAgentId !== undefined) {
      ch.persistentAgentId = msg.persistentAgentId as string
      // The session may have just been adopted onto an employee who is
      // already working — fold it into that employee's body (it becomes a
      // pip) instead of standing as a second identical character.
      os.regroupCharacterUnderEmployee(id)
    }
    if (msg.avatarConfig !== undefined) ch.avatarConfig = msg.avatarConfig as string
    // Drop the resolved worker from the popup queue (match by live session).
    if (ch.sessionId) ctx.setPendingWorkers((prev) => prev.filter((w) => w.sessionId !== ch.sessionId))
    saveAgentMeta(ctx)
  }
}
