import type { ToolActivity } from '../office/types.js'
import type { OfficeState } from '../office/engine/officeState.js'
import type { OfflineAgent, KnownProject } from '../hooks/useExtensionMessages.js'

export interface RoomGroup {
  liveAgents: number[]
  offlineAgents: OfflineAgent[]
  workspacePath?: string
  /** Special rooms (conference, warehouse) can't hire workers */
  isSpecialRoom?: boolean
}

export interface ClickUpTicketRef {
  id: string
  name: string
  url: string
}

/** Format an ISO timestamp as a relative "time ago" string */
export function timeAgo(isoDate: string): string {
  const seconds = Math.floor((Date.now() - new Date(isoDate).getTime()) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

/** Derive a short activity label from current tools */
export function getActivity(
  agentId: number,
  agentTools: Record<number, ToolActivity[]>,
  isActive: boolean,
): string {
  const tools = agentTools[agentId]
  if (tools && tools.length > 0) {
    const activeTool = [...tools].reverse().find((t) => !t.done)
    if (activeTool) {
      if (activeTool.permissionWait) return 'Needs approval'
      return activeTool.status
    }
    if (isActive) {
      const lastTool = tools[tools.length - 1]
      if (lastTool) return lastTool.status
    }
  }
  return ''
}

/** Status dot color for an agent */
export function getDotInfo(
  agentId: number,
  agentTools: Record<number, ToolActivity[]>,
  agentStatuses: Record<number, string>,
  isActive: boolean,
): { color: string; pulse: boolean } | null {
  const tools = agentTools[agentId]
  const hasPermission = tools?.some((t) => t.permissionWait && !t.done)
  const hasActiveTools = tools?.some((t) => !t.done)
  const status = agentStatuses[agentId]

  if (hasPermission) {
    return { color: 'var(--pixel-status-permission)', pulse: true }
  }
  if (status === 'waiting') {
    return { color: 'var(--pixel-status-waiting)', pulse: false }
  }
  if (isActive && hasActiveTools) {
    return { color: 'var(--pixel-status-active)', pulse: false }
  }
  if (isActive) {
    return { color: 'var(--pixel-status-active)', pulse: false }
  }
  return null
}

/** Group live + offline agents by their room/project name */
export function groupByRoom(
  agents: number[],
  officeState: OfficeState,
  offlineAgents: OfflineAgent[],
  knownProjects: KnownProject[],
): Map<string, RoomGroup> {
  const groups = new Map<string, RoomGroup>()
  const ensure = (name: string) => {
    if (!groups.has(name)) groups.set(name, { liveAgents: [], offlineAgents: [] })
    return groups.get(name)!
  }
  // Seed with rooms from officeState + known projects (with workspace paths)
  for (const room of officeState.rooms) {
    const g = ensure(room.projectName)
    if (room.isConferenceRoom || room.isGarage || room.isForeman || room.isArtDirector || room.isFiller) g.isSpecialRoom = true
  }
  for (const kp of knownProjects) {
    const g = ensure(kp.name)
    if (kp.workspacePath) g.workspacePath = kp.workspacePath
  }
  // Add live agents
  for (const id of agents) {
    const ch = officeState.characters.get(id)
    if (!ch || ch.isSubagent) continue
    const project = ch.projectName || ch.folderName || ''
    const g = ensure(project)
    g.liveAgents.push(id)
    if (ch.workspacePath && !g.workspacePath) g.workspacePath = ch.workspacePath
  }
  // Add offline agents
  for (const agent of offlineAgents) {
    const project = agent.projectName || 'Unknown'
    const g = ensure(project)
    g.offlineAgents.push(agent)
    if (agent.workspacePath && !g.workspacePath) g.workspacePath = agent.workspacePath
  }
  return groups
}

export const deleteButtonStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'var(--pixel-text-dim)',
  fontSize: '16px',
  cursor: 'pointer',
  padding: '0 2px',
  flexShrink: 0,
  lineHeight: 1,
}
