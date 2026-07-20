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
): { color: string; pulse: boolean; waiting?: boolean } | null {
  const tools = agentTools[agentId]
  const hasPermission = tools?.some((t) => t.permissionWait && !t.done)
  const hasActiveTools = tools?.some((t) => !t.done)
  const status = agentStatuses[agentId]

  if (hasPermission) {
    return { color: 'var(--pixel-status-permission)', pulse: true }
  }
  if (status === 'waiting') {
    // Deep-blue pulsating glow instead of the opacity pulse (see
    // .pixel-agents-waiting-glow) to flag "waiting for input".
    return { color: 'var(--pixel-status-waiting)', pulse: false, waiting: true }
  }
  if (isActive && hasActiveTools) {
    return { color: 'var(--pixel-status-active)', pulse: false }
  }
  if (isActive) {
    return { color: 'var(--pixel-status-active)', pulse: false }
  }
  return null
}

// JAN_WORKSPACE on the server is the org-wide design workspace used by Jan,
// QAs, and all designer roles. It is never registered as a project (it isn't
// one), so it would never appear in any building's allowedPaths — but the
// agents living there are org-wide and must show regardless of active
// building. Match both the tilde form (how the server stores it) and any
// expanded absolute form ending in /kantoor-workspace.
const ORG_WIDE_WORKSPACE_SUFFIX = '/kantoor-workspace'
const ORG_WIDE_WORKSPACE_TILDE = '~/Projects/kantoor-workspace'
function isOrgWideWorkspace(workspacePath: string | undefined): boolean {
  if (!workspacePath) return false
  return workspacePath === ORG_WIDE_WORKSPACE_TILDE || workspacePath.endsWith(ORG_WIDE_WORKSPACE_SUFFIX)
}

/** Group live + offline agents by their room/project name.
 *
 *  Only projects in `knownProjects` (the active building's membership) are
 *  shown. Agents whose workspacePath isn't in that allowed set are skipped —
 *  their project belongs to another building. The old office-metaphor rooms
 *  (conference, garage, kitchen/filler) are dropped entirely; only Foreman
 *  and Art Director survive as special rooms (their rows open the panels).
 *  Org-wide agents (Jan, QAs, designers — workspace = kantoor-workspace)
 *  bypass the building filter because they're staff of every building, not
 *  tied to one building's project list.
 */
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

  // Sets of workspace paths AND project names that belong to the active
  // building. RoomInfo carries only projectName, while live/offline agents
  // carry workspacePath — we filter against whichever identifier the input
  // provides. Special rooms (no project identity) always show.
  const allowedPaths = new Set<string>()
  const allowedNames = new Set<string>()
  for (const kp of knownProjects) {
    if (kp.workspacePath) allowedPaths.add(kp.workspacePath)
    allowedNames.add(kp.name)
  }

  // Seed with special rooms from officeState. The old pixel-office metaphor
  // rooms (conference, garage, kitchen/filler) are dropped entirely in the
  // flat layout — they were decorative locations, not real staffing rooms.
  // Only Foreman and Art Director survive as "special" because their sidebar
  // rows are the entry points that open those panels. Skip non-special rooms
  // whose projectName isn't in the active building — they'll only resurface
  // if the user re-ticks the project.
  for (const room of officeState.rooms) {
    if (room.isConferenceRoom || room.isGarage || room.isFiller) continue
    const isSpecial = !!(room.isForeman || room.isArtDirector)
    if (!isSpecial && !allowedNames.has(room.projectName)) continue
    const g = ensure(room.projectName)
    if (isSpecial) g.isSpecialRoom = true
  }
  for (const kp of knownProjects) {
    const g = ensure(kp.name)
    if (kp.workspacePath) g.workspacePath = kp.workspacePath
  }
  // Add live agents — filter by allowed workspace paths, except org-wide
  // staff (Jan, QAs, designers).
  for (const id of agents) {
    const ch = officeState.characters.get(id)
    if (!ch || ch.isSubagent) continue
    if (ch.workspacePath && !isOrgWideWorkspace(ch.workspacePath) && !allowedPaths.has(ch.workspacePath)) continue
    const project = ch.projectName || ch.folderName || ''
    const g = ensure(project)
    g.liveAgents.push(id)
    if (ch.workspacePath && !g.workspacePath) g.workspacePath = ch.workspacePath
  }
  // Add offline agents — same filter rules as live agents.
  for (const agent of offlineAgents) {
    if (agent.workspacePath && !isOrgWideWorkspace(agent.workspacePath) && !allowedPaths.has(agent.workspacePath)) continue
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
