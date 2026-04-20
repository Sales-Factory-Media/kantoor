import { useState, useMemo } from 'react'
import type { ToolActivity } from '../office/types.js'
import type { OfficeState } from '../office/engine/officeState.js'
import type { OfflineAgent, KnownProject, OrganogramPayload } from '../hooks/useExtensionMessages.js'
import { vscode } from '../vscodeApi.js'
import { FOREMAN_ROOM_NAME, ART_DIRECTOR_ROOM_NAME } from '../constants.js'
import { Organogram } from './Organogram.js'

interface AgentSidebarProps {
  officeState: OfficeState
  agents: number[]
  selectedAgent: number | null
  onSelectAgent: (id: number | null) => void
  agentTools: Record<number, ToolActivity[]>
  agentStatuses: Record<number, string>
  offlineAgents: OfflineAgent[]
  knownProjects: KnownProject[]
  onSaveAgentMeta: () => void
  onForgetAgent: (sessionId: string) => void
  onOpenForeman?: () => void
  onOpenArtDirector?: () => void
  peersBrokerAvailable?: boolean
  organogram?: OrganogramPayload | null
}

/** Format an ISO timestamp as a relative "time ago" string */
function timeAgo(isoDate: string): string {
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
function getActivity(
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
function getDotInfo(
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

interface RoomGroup {
  liveAgents: number[]
  offlineAgents: OfflineAgent[]
  workspacePath?: string
  /** Special rooms (conference, warehouse) can't hire workers */
  isSpecialRoom?: boolean
}

/** Group live + offline agents by their room/project name */
function groupByRoom(
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
    if (room.isConferenceRoom || room.isWarehouse || room.isGarage || room.isForeman || room.isArtDirector) g.isSpecialRoom = true
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

interface ConfirmDialogProps {
  message: string
  confirmLabel?: string
  onConfirm: () => void
  onCancel: () => void
}

function ConfirmDialog({ message, confirmLabel = 'Fire', onConfirm, onCancel }: ConfirmDialogProps) {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 10001,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.5)',
      }}
      onClick={onCancel}
    >
      <div
        style={{
          background: 'var(--pixel-bg)',
          border: '2px solid var(--pixel-border)',
          borderRadius: 0,
          boxShadow: 'var(--pixel-shadow)',
          padding: '12px',
          minWidth: 240,
          maxWidth: 320,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <span style={{ fontSize: '20px', color: 'var(--pixel-text)' }}>
          {message}
        </span>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            onClick={onCancel}
            style={{
              padding: '4px 12px',
              fontSize: '18px',
              color: 'var(--pixel-text)',
              background: 'var(--pixel-bg)',
              border: '2px solid var(--pixel-border)',
              borderRadius: 0,
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            style={{
              padding: '4px 12px',
              fontSize: '18px',
              color: '#fff',
              background: '#c53030',
              border: '2px solid #9b2c2c',
              borderRadius: 0,
              cursor: 'pointer',
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

const deleteButtonStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'var(--pixel-text-dim)',
  fontSize: '16px',
  cursor: 'pointer',
  padding: '0 2px',
  flexShrink: 0,
  lineHeight: 1,
}

export interface ClickUpTicketRef {
  id: string
  name: string
  url: string
}

interface OfflineAgentRowProps {
  agent: OfflineAgent
  onEdit?: (agent: OfflineAgent) => void
  onDelete?: (agent: OfflineAgent) => void
  onCallIn?: (agent: OfflineAgent) => void
  onRestart?: (agent: OfflineAgent) => void
  /** When set, "Call In" sends clickupStartWork with this ticket instead of the normal call-in flow */
  clickupTicket?: ClickUpTicketRef
  /** When true, the agent should use agent team mode */
  useTeam?: boolean
  /** Additional instructions to append to the ticket task */
  additionalPrompt?: string
}

export function OfflineAgentRow({ agent, onEdit, onDelete, onCallIn, onRestart, clickupTicket, useTeam, additionalPrompt }: OfflineAgentRowProps) {
  const [isHovered, setIsHovered] = useState(false)

  const handleCallIn = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (clickupTicket) {
      vscode.postMessage({
        type: 'clickupStartWork',
        agentId: agent.sessionId,
        ticketId: clickupTicket.id,
        ticketName: clickupTicket.name,
        ticketUrl: clickupTicket.url,
        useTeam: useTeam || undefined,
        additionalPrompt: additionalPrompt || undefined,
      })
      if (onCallIn) onCallIn(agent)
    } else if (agent.isPersistent && onCallIn) {
      onCallIn(agent)
    } else if (onRestart) {
      onRestart(agent)
    }
  }

  return (
    <div
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      style={{
        padding: '4px 6px',
        background: isHovered ? 'var(--pixel-btn-hover-bg)' : 'transparent',
        borderBottom: '1px solid var(--pixel-border)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 4,
      }}
    >
      <div style={{ overflow: 'hidden', flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: 'rgba(255,255,255,0.1)',
              flexShrink: 0,
            }}
          />
          <span
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            <span style={{ fontSize: '22px', color: 'var(--pixel-text-dim)' }}>
              {agent.name || agent.sessionId.slice(0, 8)}
            </span>
            {agent.roleShort && (
              <span style={{ fontSize: '18px', color: 'var(--pixel-accent)', marginLeft: 6, opacity: 0.7 }}>
                {agent.roleShort}
              </span>
            )}
          </span>
        </div>
        {agent.lastSessionEnd && (
          <div
            style={{
              fontSize: '16px',
              color: 'var(--pixel-text-dim)',
              paddingLeft: 10,
              marginTop: 1,
              opacity: 0.7,
            }}
          >
            Last active: {timeAgo(agent.lastSessionEnd)}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexShrink: 0 }}>
        {onEdit && (
          <button
            onClick={(e) => { e.stopPropagation(); onEdit(agent) }}
            title="Employee file"
            style={{
              ...deleteButtonStyle,
              color: isHovered ? 'var(--pixel-text-dim)' : 'transparent',
            }}
          >
            {'\u270E'}
          </button>
        )}
        {onDelete && (
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(agent) }}
            title="Fire employee"
            style={{
              ...deleteButtonStyle,
              color: isHovered ? 'var(--pixel-text-dim)' : 'transparent',
            }}
          >
            {'\u{1F5D1}'}
          </button>
        )}
        <button
          onClick={handleCallIn}
          style={{
            padding: '2px 8px',
            fontSize: '18px',
            color: 'var(--pixel-agent-text)',
            background: 'var(--pixel-agent-bg)',
            border: '2px solid var(--pixel-agent-border)',
            borderRadius: 0,
            cursor: 'pointer',
            flexShrink: 0,
          }}
          title={clickupTicket ? 'Assign this ticket to this agent' : agent.isPersistent ? 'Call this agent back to work' : 'Resume this session in iTerm'}
        >
          {agent.isPersistent ? 'Call In' : 'Resume'}
        </button>
      </div>
    </div>
  )
}

interface EmployeeFileProps {
  officeState: OfficeState
  /** Live character ID to edit, or null for creating a new agent */
  agentId: number | null
  /** Offline persistent agent to edit, or undefined */
  offlineAgent?: OfflineAgent
  /** Pre-filled workspace path for new workers in a specific room */
  defaultWorkspacePath?: string
  onClose: () => void
  onSave: () => void
  /** If true, immediately launch the agent after saving */
  launchAfterSave?: boolean
}

function EmployeeFile({ officeState, agentId, offlineAgent, defaultWorkspacePath, onClose, onSave, launchAfterSave }: EmployeeFileProps) {
  const ch = agentId !== null ? officeState.characters.get(agentId) : null

  const [name, setName] = useState(ch?.name || offlineAgent?.name || '')
  const [roleShort, setRoleShort] = useState(ch?.roleShort || offlineAgent?.roleShort || '')
  const [roleFull, setRoleFull] = useState(ch?.roleFull || offlineAgent?.roleFull || '')
  const [workspacePath, setWorkspacePath] = useState(ch?.workspacePath || offlineAgent?.workspacePath || defaultWorkspacePath || '')

  const persistentId = ch?.persistentAgentId || (offlineAgent?.isPersistent ? offlineAgent.sessionId : undefined)

  const handleSave = () => {
    // Update live character if editing one
    if (ch) {
      ch.name = name
      ch.roleShort = roleShort
      ch.roleFull = roleFull
      ch.workspacePath = workspacePath || undefined
    }

    // Save as persistent agent identity
    vscode.postMessage({
      type: 'saveAgentIdentity',
      agent: {
        id: persistentId || undefined,
        name,
        roleShort,
        roleFull,
        workspacePath: workspacePath || '',
        palette: ch?.palette,
        hueShift: ch?.hueShift,
        seatId: ch?.seatId,
        currentSessionId: ch?.sessionId,
      },
      launch: launchAfterSave || false,
    })

    onSave()
    onClose()
  }

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '4px 6px',
    fontSize: '20px',
    color: 'var(--pixel-text)',
    background: 'var(--pixel-bg)',
    border: '2px solid var(--pixel-border)',
    borderRadius: 0,
    outline: 'none',
    boxSizing: 'border-box',
  }

  const labelStyle: React.CSSProperties = {
    fontSize: '18px',
    color: 'var(--pixel-text-dim)',
    marginBottom: 2,
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 10000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.5)',
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'var(--pixel-bg)',
          border: '2px solid var(--pixel-border)',
          borderRadius: 0,
          boxShadow: 'var(--pixel-shadow)',
          padding: '12px',
          minWidth: 280,
          maxWidth: 360,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: '24px', color: 'var(--pixel-text)', fontWeight: 'bold' }}>
            Employee File
          </span>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--pixel-text-dim)',
              fontSize: '22px',
              cursor: 'pointer',
              padding: '0 4px',
            }}
          >
            {'\u2715'}
          </button>
        </div>

        {/* Name */}
        <div>
          <div style={labelStyle}>Name</div>
          <input
            style={inputStyle}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Agent name"
          />
        </div>

        {/* Short role */}
        <div>
          <div style={labelStyle}>Role (short)</div>
          <input
            style={inputStyle}
            value={roleShort}
            onChange={(e) => setRoleShort(e.target.value)}
            placeholder="e.g. Frontend Dev"
          />
        </div>

        {/* Full role description */}
        <div>
          <div style={labelStyle}>Role (full)</div>
          <textarea
            style={{
              ...inputStyle,
              minHeight: 60,
              resize: 'vertical',
            }}
            value={roleFull}
            onChange={(e) => setRoleFull(e.target.value)}
            placeholder="Full role description..."
          />
        </div>

        {/* Workspace path */}
        <div>
          <div style={labelStyle}>Working Directory</div>
          <input
            style={inputStyle}
            value={workspacePath}
            onChange={(e) => setWorkspacePath(e.target.value)}
            placeholder="/path/to/project"
          />
        </div>

        {/* Save button */}
        <button
          onClick={handleSave}
          style={{
            padding: '6px 12px',
            fontSize: '20px',
            color: 'var(--pixel-agent-text)',
            background: 'var(--pixel-agent-bg)',
            border: '2px solid var(--pixel-agent-border)',
            borderRadius: 0,
            cursor: 'pointer',
            alignSelf: 'flex-end',
          }}
        >
          {launchAfterSave ? 'Save & Hire' : 'Save'}
        </button>
      </div>
    </div>
  )
}

export interface AgentRoomListProps {
  officeState: OfficeState
  agents: number[]
  selectedAgent: number | null
  agentTools: Record<number, ToolActivity[]>
  agentStatuses: Record<number, string>
  offlineAgents: OfflineAgent[]
  knownProjects: KnownProject[]
  /** When set, offline agent "Call In" assigns this ticket instead of the normal flow */
  clickupTicket?: ClickUpTicketRef
  /** When true, the agent should use agent team mode */
  useTeam?: boolean
  /** Additional instructions to append to the ticket task */
  additionalPrompt?: string
  /** Called after a clickup ticket is assigned (to close the picker) */
  onTicketAssigned?: () => void
  // Sidebar-specific callbacks (omitted in worker picker mode)
  onSelectAgent?: (id: number | null) => void
  onEditLiveAgent?: (id: number) => void
  onDeleteLiveAgent?: (id: number, name: string, isPersistent: boolean, persistentAgentId?: string) => void
  onEditOfflineAgent?: (agent: OfflineAgent) => void
  onDeleteOfflineAgent?: (agent: OfflineAgent) => void
  onCallInOfflineAgent?: (agent: OfflineAgent) => void
  onRestartOfflineAgent?: (agent: OfflineAgent) => void
  onHireForRoom?: (workspacePath: string) => void
  onRemoveRoom?: (name: string) => void
  onOpenForeman?: () => void
  onOpenArtDirector?: () => void
}

export function AgentRoomList({
  officeState,
  agents,
  selectedAgent,
  agentTools,
  agentStatuses,
  offlineAgents,
  knownProjects,
  clickupTicket,
  useTeam,
  additionalPrompt,
  onTicketAssigned,
  onSelectAgent,
  onEditLiveAgent,
  onDeleteLiveAgent,
  onEditOfflineAgent,
  onDeleteOfflineAgent,
  onCallInOfflineAgent,
  onRestartOfflineAgent,
  onHireForRoom,
  onRemoveRoom,
  onOpenForeman,
  onOpenArtDirector,
}: AgentRoomListProps) {
  const [hoveredId, setHoveredId] = useState<number | null>(null)
  const [hoveredRoom, setHoveredRoom] = useState<string | null>(null)
  const [manualToggles, setManualToggles] = useState<Set<string>>(new Set())
  const [editingDescRoom, setEditingDescRoom] = useState<string | null>(null)
  const [descDraft, setDescDraft] = useState('')

  const roomGroups = groupByRoom(agents, officeState, offlineAgents, knownProjects)

  const collapsedRooms = useMemo(() => {
    const result = new Set<string>()
    for (const [name, group] of roomGroups) {
      const hasLive = group.liveAgents.length > 0
      const manuallyToggled = manualToggles.has(name)
      if (hasLive ? manuallyToggled : !manuallyToggled) {
        result.add(name)
      }
    }
    return result
  }, [roomGroups, manualToggles])

  const toggleRoom = (name: string) => {
    setManualToggles((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const handleClick = (id: number) => {
    if (!onSelectAgent) return
    officeState.selectedAgentId = id
    officeState.cameraFollowId = id
    onSelectAgent(id)
    vscode.postMessage({ type: 'focusAgent', id })
  }

  const regularRooms = [...roomGroups.entries()].filter(([, g]) => !g.isSpecialRoom)
  const specialRooms = [...roomGroups.entries()].filter(([, g]) => g.isSpecialRoom)

  return (
    <div style={{ overflowY: 'auto', overflowX: 'hidden' }}>
      {regularRooms.map(([projectName, group]) => (
        <div key={projectName}>
          {/* Room header */}
          <div
            onMouseEnter={() => setHoveredRoom(projectName)}
            onMouseLeave={() => setHoveredRoom(null)}
            onClick={() => toggleRoom(projectName)}
            style={{
              padding: '3px 6px',
              fontSize: '18px',
              color: group.liveAgents.length > 0 ? 'var(--pixel-green)' : 'var(--pixel-text-dim)',
              background: group.liveAgents.length > 0 ? 'rgba(90, 200, 140, 0.08)' : 'rgba(255, 255, 255, 0.03)',
              borderBottom: '1px solid var(--pixel-border)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              userSelect: 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              cursor: 'pointer',
            }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 4, overflow: 'hidden' }}>
              <span style={{ fontSize: '14px', color: 'var(--pixel-text-dim)', flexShrink: 0 }}>
                {collapsedRooms.has(projectName) ? '\u25B6' : '\u25BC'}
              </span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {projectName || 'Unassigned'}
              </span>
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
              {group.workspacePath && hoveredRoom === projectName && (
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    if (editingDescRoom === (group.workspacePath || projectName)) {
                      setEditingDescRoom(null)
                    } else {
                      const roomKey = group.workspacePath || projectName
                      setEditingDescRoom(roomKey)
                      setDescDraft(knownProjects.find((p) => p.workspacePath === group.workspacePath)?.description || '')
                    }
                  }}
                  title="Edit project description"
                  style={deleteButtonStyle}
                >
                  {'\u270E'}
                </button>
              )}
              {onRemoveRoom && group.liveAgents.length === 0 && hoveredRoom === projectName && (
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    onRemoveRoom(projectName)
                  }}
                  title="Remove room"
                  style={deleteButtonStyle}
                >
                  {'\u2715'}
                </button>
              )}
            </span>
          </div>

          {/* Description preview */}
          {(() => {
            const roomKey = group.workspacePath || projectName
            const desc = knownProjects.find((p) => p.workspacePath === group.workspacePath)?.description
            if (desc && editingDescRoom !== roomKey) {
              return (
                <div style={{ fontSize: '14px', color: 'var(--pixel-text-dim)', padding: '2px 8px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {desc}
                </div>
              )
            }
            return null
          })()}

          {/* Description editor */}
          {editingDescRoom === (group.workspacePath || projectName) && (
            <div style={{ padding: '4px 6px', borderBottom: '1px solid var(--pixel-border)' }}>
              <textarea
                style={{
                  width: '100%',
                  padding: '4px 6px',
                  fontSize: '14px',
                  color: 'var(--pixel-text)',
                  background: 'var(--pixel-bg)',
                  border: '2px solid var(--pixel-border)',
                  borderRadius: 0,
                  outline: 'none',
                  boxSizing: 'border-box',
                  minHeight: 80,
                  resize: 'vertical',
                }}
                value={descDraft}
                onChange={(e) => setDescDraft(e.target.value)}
                placeholder="Project description..."
                autoFocus
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
                <button
                  onClick={() => {
                    vscode.postMessage({ type: 'updateProjectDescription', workspacePath: group.workspacePath, description: descDraft })
                    setEditingDescRoom(null)
                  }}
                  style={{
                    padding: '2px 10px',
                    fontSize: '18px',
                    color: 'var(--pixel-agent-text)',
                    background: 'var(--pixel-agent-bg)',
                    border: '2px solid var(--pixel-agent-border)',
                    borderRadius: 0,
                    cursor: 'pointer',
                  }}
                >
                  Save
                </button>
              </div>
            </div>
          )}

          {/* Live agents in this room */}
          {!collapsedRooms.has(projectName) && group.liveAgents.map((id) => {
            const ch = officeState.characters.get(id)
            if (!ch) return null

            const isSelected = selectedAgent === id
            const isHovered = hoveredId === id
            const activity = getActivity(id, agentTools, ch.isActive)
            const dot = getDotInfo(id, agentTools, agentStatuses, ch.isActive)
            const status = agentStatuses[id]
            const isWaiting = status === 'waiting'
            const isIdle = !ch.isActive && !activity && !isWaiting

            return (
              <div
                key={id}
                onClick={() => handleClick(id)}
                onMouseEnter={() => { setHoveredId(id); officeState.hoveredAgentId = id }}
                onMouseLeave={() => { setHoveredId(null); officeState.hoveredAgentId = null }}
                style={{
                  padding: '4px 6px',
                  cursor: onSelectAgent ? 'pointer' : 'default',
                  background: isSelected
                    ? 'var(--pixel-active-bg)'
                    : isHovered
                      ? 'var(--pixel-btn-hover-bg)'
                      : 'transparent',
                  borderBottom: '1px solid var(--pixel-border)',
                }}
              >
                {/* Name row */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span
                    className={dot?.pulse ? 'pixel-agents-pulse' : undefined}
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      background: dot ? dot.color : 'rgba(255,255,255,0.2)',
                      flexShrink: 0,
                    }}
                  />
                  <span
                    style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      flex: 1,
                    }}
                  >
                    <span
                      style={{
                        fontSize: '22px',
                        color: isSelected ? '#fff' : 'var(--pixel-text)',
                        fontWeight: isSelected ? 'bold' : undefined,
                      }}
                    >
                      {ch.name || `Agent #${id}`}
                    </span>
                    {ch.roleShort && (
                      <span
                        style={{
                          fontSize: '18px',
                          color: 'var(--pixel-accent)',
                          marginLeft: 6,
                        }}
                      >
                        {ch.roleShort}
                      </span>
                    )}
                  </span>
                  {onEditLiveAgent && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        onEditLiveAgent(id)
                      }}
                      title="Employee file"
                      style={{
                        ...deleteButtonStyle,
                        color: isHovered || isSelected ? 'var(--pixel-text-dim)' : 'transparent',
                      }}
                    >
                      {'\u270E'}
                    </button>
                  )}
                  {onDeleteLiveAgent && ch.sessionId && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        onDeleteLiveAgent(id, ch.name || `Agent #${id}`, !!ch.persistentAgentId, ch.persistentAgentId)
                      }}
                      title="Fire employee"
                      style={{
                        ...deleteButtonStyle,
                        color: isHovered || isSelected ? 'var(--pixel-text-dim)' : 'transparent',
                      }}
                    >
                      {'\u{1F5D1}'}
                    </button>
                  )}
                </div>

                {/* Activity row */}
                {(activity || isWaiting || isIdle) && (
                  <div
                    style={{
                      fontSize: '18px',
                      color: 'var(--pixel-text-dim)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      paddingLeft: 10,
                      marginTop: 1,
                    }}
                  >
                    {isWaiting ? 'Waiting for input' : activity || (ch.isActive ? 'Thinking...' : 'Idle')}
                  </div>
                )}
              </div>
            )
          })}

          {/* Offline agents in this room */}
          {!collapsedRooms.has(projectName) && group.offlineAgents.map((agent) => (
            <OfflineAgentRow
              key={`offline-${agent.sessionId}`}
              agent={agent}
              clickupTicket={clickupTicket}
              useTeam={useTeam}
              additionalPrompt={additionalPrompt}
              onEdit={onEditOfflineAgent}
              onDelete={onDeleteOfflineAgent}
              onCallIn={clickupTicket ? onTicketAssigned ? () => onTicketAssigned() : undefined : onCallInOfflineAgent}
              onRestart={onRestartOfflineAgent}
            />
          ))}

          {/* + hire link per project room (not special rooms, not in picker mode) */}
          {!collapsedRooms.has(projectName) && !group.isSpecialRoom && onHireForRoom && (
            <div
              onClick={() => onHireForRoom(group.workspacePath || '')}
              style={{
                padding: '3px 6px 3px 16px',
                fontSize: '18px',
                color: 'var(--pixel-accent)',
                cursor: 'pointer',
                borderBottom: '1px solid var(--pixel-border)',
                userSelect: 'none',
              }}
            >
              + hire
            </div>
          )}
        </div>
      ))}

      {/* Special rooms (Conference, Warehouse) in a separate section */}
      {specialRooms.length > 0 && (
        <>
          <div
            style={{
              padding: '3px 6px',
              fontSize: '16px',
              color: 'var(--pixel-text-dim)',
              borderBottom: '1px solid var(--pixel-border)',
              borderTop: '2px solid var(--pixel-border)',
              userSelect: 'none',
              opacity: 0.7,
            }}
          >
            Common Areas
          </div>
          {specialRooms.map(([projectName, group]) => {
            const isForeman = projectName === FOREMAN_ROOM_NAME
            const isArtDirector = projectName === ART_DIRECTOR_ROOM_NAME
            const isClickable = (isForeman && onOpenForeman) || (isArtDirector && onOpenArtDirector)
            const handleClick = isForeman && onOpenForeman ? onOpenForeman : isArtDirector && onOpenArtDirector ? onOpenArtDirector : undefined
            return (
            <div key={projectName}>
              {/* Room header */}
              <div
                onClick={handleClick}
                style={{
                  padding: '3px 6px',
                  fontSize: '18px',
                  color: isClickable ? 'var(--pixel-accent)' : group.liveAgents.length > 0 ? 'var(--pixel-green)' : 'var(--pixel-text-dim)',
                  background: group.liveAgents.length > 0 ? 'rgba(90, 200, 140, 0.08)' : 'rgba(255, 255, 255, 0.03)',
                  borderBottom: '1px solid var(--pixel-border)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  userSelect: 'none',
                  cursor: isClickable ? 'pointer' : 'default',
                }}
              >
                {projectName}
              </div>
            </div>
            )
          })}
        </>
      )}
    </div>
  )
}

export function AgentSidebar({
  officeState,
  agents,
  selectedAgent,
  onSelectAgent,
  agentTools,
  agentStatuses,
  offlineAgents,
  knownProjects,
  onSaveAgentMeta,
  onForgetAgent,
  onOpenForeman,
  onOpenArtDirector,
  peersBrokerAvailable,
  organogram,
}: AgentSidebarProps) {
  const [collapsed, setCollapsed] = useState(false)
  const [showOrganogram, setShowOrganogram] = useState(false)
  const [editingAgentId, setEditingAgentId] = useState<number | null>(null)
  const [editingOfflineAgent, setEditingOfflineAgent] = useState<OfflineAgent | undefined>(undefined)
  const [creatingForWorkspace, setCreatingForWorkspace] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<{ sessionId: string; name: string; isPersistent?: boolean } | null>(null)
  const [confirmRoomDelete, setConfirmRoomDelete] = useState<{ name: string } | null>(null)
  const [callInAgent, setCallInAgent] = useState<OfflineAgent | null>(null)
  const [callInTask, setCallInTask] = useState('')
  const [callInUseTeam, setCallInUseTeam] = useState(false)
  const [showConferenceModal, setShowConferenceModal] = useState(false)
  const [confAgent1, setConfAgent1] = useState<string | null>(null)
  const [confAgent2, setConfAgent2] = useState<string | null>(null)
  const [confTopic, setConfTopic] = useState('')

  // Always show sidebar — rooms exist even without agents
  if (agents.length === 0 && offlineAgents.length === 0 && knownProjects.length === 0) return null

  const showEmployeeFile = editingAgentId !== null || editingOfflineAgent !== undefined || creatingForWorkspace !== null

  return (
    <>
      {confirmDelete && (
        <ConfirmDialog
          message={`Fire "${confirmDelete.name}"? This cannot be undone.`}
          onConfirm={() => {
            if (confirmDelete.isPersistent) {
              vscode.postMessage({ type: 'deleteAgentIdentity', agentId: confirmDelete.sessionId })
            } else {
              onForgetAgent(confirmDelete.sessionId)
            }
            setConfirmDelete(null)
          }}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
      {confirmRoomDelete && (
        <ConfirmDialog
          message={`Remove room "${confirmRoomDelete.name}"?`}
          confirmLabel="Remove"
          onConfirm={() => {
            vscode.postMessage({ type: 'removeRoom', roomName: confirmRoomDelete.name })
            setConfirmRoomDelete(null)
          }}
          onCancel={() => setConfirmRoomDelete(null)}
        />
      )}
      {callInAgent && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 10001,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0,0,0,0.5)',
          }}
          onClick={() => setCallInAgent(null)}
        >
          <div
            style={{
              background: 'var(--pixel-bg)',
              border: '2px solid var(--pixel-border)',
              borderRadius: 0,
              boxShadow: 'var(--pixel-shadow)',
              padding: '12px',
              minWidth: 280,
              maxWidth: 360,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <span style={{ fontSize: '24px', color: 'var(--pixel-text)', fontWeight: 'bold' }}>
              Call In {callInAgent.name || callInAgent.sessionId.slice(0, 8)}
            </span>
            <div>
              <div style={{ fontSize: '18px', color: 'var(--pixel-text-dim)', marginBottom: 2 }}>
                What should they work on? (optional)
              </div>
              <textarea
                style={{
                  width: '100%',
                  padding: '8px 10px',
                  fontSize: '14px',
                  color: 'var(--pixel-text)',
                  background: 'var(--pixel-bg)',
                  border: '2px solid var(--pixel-border)',
                  borderRadius: 0,
                  outline: 'none',
                  boxSizing: 'border-box',
                  minHeight: 160,
                  resize: 'vertical',
                }}
                value={callInTask}
                onChange={(e) => setCallInTask(e.target.value)}
                placeholder="e.g. Fix the login bug..."
                autoFocus
              />
            </div>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: '18px',
                color: 'var(--pixel-text)',
                cursor: 'pointer',
                userSelect: 'none',
              }}
            >
              <input
                type="checkbox"
                checked={callInUseTeam}
                onChange={(e) => setCallInUseTeam(e.target.checked)}
                style={{ accentColor: 'var(--pixel-accent)' }}
              />
              Use Agent Team
            </label>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                onClick={() => setCallInAgent(null)}
                style={{
                  padding: '4px 12px',
                  fontSize: '18px',
                  color: 'var(--pixel-text)',
                  background: 'var(--pixel-bg)',
                  border: '2px solid var(--pixel-border)',
                  borderRadius: 0,
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  vscode.postMessage({
                    type: 'launchAgent',
                    agentId: callInAgent.sessionId,
                    callInTask: callInTask.trim() || undefined,
                    useTeam: callInUseTeam || undefined,
                  })
                  setCallInAgent(null)
                }}
                style={{
                  padding: '4px 12px',
                  fontSize: '18px',
                  color: 'var(--pixel-agent-text)',
                  background: 'var(--pixel-agent-bg)',
                  border: '2px solid var(--pixel-agent-border)',
                  borderRadius: 0,
                  cursor: 'pointer',
                }}
              >
                Call In
              </button>
            </div>
          </div>
        </div>
      )}
      {showConferenceModal && (() => {
        const persistentOffline = offlineAgents.filter((a) => a.isPersistent)
        const liveAgentIds = new Set(agents)
        const conferenceEligible = persistentOffline.filter((a) => {
          // Exclude agents that are currently online (have a matching live character)
          for (const id of liveAgentIds) {
            const ch = officeState.characters.get(id)
            if (ch && ch.persistentAgentId === a.sessionId) return false
          }
          return true
        })
        // Group eligible agents by project
        const agentsByProject = new Map<string, typeof conferenceEligible>()
        for (const a of conferenceEligible) {
          const project = a.projectName || 'No project'
          const group = agentsByProject.get(project) || []
          group.push(a)
          agentsByProject.set(project, group)
        }
        const canStart = confAgent1 && confAgent2 && confAgent1 !== confAgent2 && confTopic.trim().length > 0
        return (
          <div
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 10001,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'rgba(0,0,0,0.5)',
            }}
            onClick={() => setShowConferenceModal(false)}
          >
            <div
              style={{
                background: 'var(--pixel-bg)',
                border: '2px solid var(--pixel-border)',
                borderRadius: 0,
                boxShadow: 'var(--pixel-shadow)',
                padding: '12px',
                minWidth: 280,
                maxWidth: 360,
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <span style={{ fontSize: '24px', color: 'var(--pixel-text)', fontWeight: 'bold' }}>
                Start Conference
              </span>

              {/* Agent 1 selector */}
              <div>
                <div style={{ fontSize: '18px', color: 'var(--pixel-text-dim)', marginBottom: 2 }}>
                  Agent 1
                </div>
                <select
                  value={confAgent1 || ''}
                  onChange={(e) => setConfAgent1(e.target.value || null)}
                  style={{
                    width: '100%',
                    padding: '4px 6px',
                    fontSize: '20px',
                    color: 'var(--pixel-text)',
                    background: 'var(--pixel-bg)',
                    border: '2px solid var(--pixel-border)',
                    borderRadius: 0,
                    outline: 'none',
                    boxSizing: 'border-box',
                  }}
                >
                  <option value="">Select agent...</option>
                  {[...agentsByProject.entries()].map(([project, groupAgents]) => (
                    <optgroup key={project} label={project}>
                      {groupAgents.map((a) => (
                        <option key={a.sessionId} value={a.sessionId} disabled={a.sessionId === confAgent2}>
                          {a.name || a.sessionId.slice(0, 8)}{a.roleShort ? ` — ${a.roleShort}` : ''}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </div>

              {/* Agent 2 selector */}
              <div>
                <div style={{ fontSize: '18px', color: 'var(--pixel-text-dim)', marginBottom: 2 }}>
                  Agent 2
                </div>
                <select
                  value={confAgent2 || ''}
                  onChange={(e) => setConfAgent2(e.target.value || null)}
                  style={{
                    width: '100%',
                    padding: '4px 6px',
                    fontSize: '20px',
                    color: 'var(--pixel-text)',
                    background: 'var(--pixel-bg)',
                    border: '2px solid var(--pixel-border)',
                    borderRadius: 0,
                    outline: 'none',
                    boxSizing: 'border-box',
                  }}
                >
                  <option value="">Select agent...</option>
                  {[...agentsByProject.entries()].map(([project, groupAgents]) => (
                    <optgroup key={project} label={project}>
                      {groupAgents.map((a) => (
                        <option key={a.sessionId} value={a.sessionId} disabled={a.sessionId === confAgent1}>
                          {a.name || a.sessionId.slice(0, 8)}{a.roleShort ? ` — ${a.roleShort}` : ''}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </div>

              {/* Topic */}
              <div>
                <div style={{ fontSize: '18px', color: 'var(--pixel-text-dim)', marginBottom: 2 }}>
                  Discussion Topic
                </div>
                <textarea
                  style={{
                    width: '100%',
                    padding: '8px 10px',
                    fontSize: '14px',
                    color: 'var(--pixel-text)',
                    background: 'var(--pixel-bg)',
                    border: '2px solid var(--pixel-border)',
                    borderRadius: 0,
                    outline: 'none',
                    boxSizing: 'border-box',
                    minHeight: 100,
                    resize: 'vertical',
                  }}
                  value={confTopic}
                  onChange={(e) => setConfTopic(e.target.value)}
                  placeholder="What should they discuss?"
                  autoFocus
                />
              </div>

              {/* Buttons */}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button
                  onClick={() => setShowConferenceModal(false)}
                  style={{
                    padding: '4px 12px',
                    fontSize: '18px',
                    color: 'var(--pixel-text)',
                    background: 'var(--pixel-bg)',
                    border: '2px solid var(--pixel-border)',
                    borderRadius: 0,
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
                <button
                  disabled={!canStart}
                  onClick={() => {
                    if (!canStart) return
                    vscode.postMessage({
                      type: 'startConference',
                      agent1Id: confAgent1,
                      agent2Id: confAgent2,
                      topic: confTopic.trim(),
                    })
                    setShowConferenceModal(false)
                    setConfAgent1(null)
                    setConfAgent2(null)
                    setConfTopic('')
                  }}
                  style={{
                    padding: '4px 12px',
                    fontSize: '18px',
                    color: canStart ? 'var(--pixel-agent-text)' : 'var(--pixel-text-dim)',
                    background: canStart ? 'var(--pixel-agent-bg)' : 'var(--pixel-bg)',
                    border: `2px solid ${canStart ? 'var(--pixel-agent-border)' : 'var(--pixel-border)'}`,
                    borderRadius: 0,
                    cursor: canStart ? 'pointer' : 'not-allowed',
                    opacity: canStart ? 1 : 0.5,
                  }}
                >
                  Start
                </button>
              </div>
            </div>
          </div>
        )
      })()}
      {showEmployeeFile && (
        <EmployeeFile
          officeState={officeState}
          agentId={editingAgentId}
          offlineAgent={editingOfflineAgent}
          defaultWorkspacePath={creatingForWorkspace ?? undefined}
          onClose={() => { setEditingAgentId(null); setEditingOfflineAgent(undefined); setCreatingForWorkspace(null) }}
          onSave={onSaveAgentMeta}
          launchAfterSave={creatingForWorkspace !== null}
        />
      )}
      <div
        style={{
          position: 'absolute',
          top: 10,
          right: 10,
          zIndex: 'var(--pixel-controls-z)',
          display: 'flex',
          flexDirection: 'column',
          gap: 0,
          background: 'var(--pixel-bg)',
          border: '2px solid var(--pixel-border)',
          borderRadius: 0,
          boxShadow: 'var(--pixel-shadow)',
          minWidth: collapsed ? undefined : 180,
          maxWidth: 300,
          maxHeight: 'calc(100% - 20px)',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '4px 6px',
            borderBottom: collapsed ? 'none' : '2px solid var(--pixel-border)',
            cursor: 'pointer',
          }}
          onClick={() => setCollapsed((p) => !p)}
        >
          <span style={{ fontSize: '22px', color: 'var(--pixel-text)', userSelect: 'none' }}>
            Employees ({agents.length})
          </span>
          <span style={{ fontSize: '18px', color: 'var(--pixel-text-dim)', userSelect: 'none', marginLeft: 6 }}>
            {collapsed ? '\u25B6' : '\u25BC'}
          </span>
        </div>

        {/* Conference button */}
        {!collapsed && (
          <button
            onClick={() => {
              setShowConferenceModal(true)
              setConfAgent1(null)
              setConfAgent2(null)
              setConfTopic('')
            }}
            disabled={peersBrokerAvailable === false}
            title={peersBrokerAvailable === false ? 'Peers broker not running. Run: docker compose up -d' : 'Start a conference between two agents'}
            style={{
              padding: '3px 8px',
              margin: '4px 6px',
              fontSize: '18px',
              color: peersBrokerAvailable === false ? 'var(--pixel-text-dim)' : 'var(--pixel-text)',
              background: 'var(--pixel-bg)',
              border: '2px solid var(--pixel-border)',
              borderRadius: 0,
              boxShadow: '2px 2px 0px #0a0a14',
              cursor: peersBrokerAvailable === false ? 'not-allowed' : 'pointer',
              opacity: peersBrokerAvailable === false ? 0.5 : 1,
              userSelect: 'none',
            }}
          >
            Conference
          </button>
        )}

        {/* Organogram button (under Conference) */}
        {!collapsed && (
          <button
            onClick={() => setShowOrganogram(true)}
            title="Show team organogram (design teams + reporting lines)"
            style={{
              padding: '3px 8px',
              margin: '4px 6px',
              fontSize: '18px',
              color: 'var(--pixel-text)',
              background: 'var(--pixel-bg)',
              border: '2px solid var(--pixel-border)',
              borderRadius: 0,
              boxShadow: '2px 2px 0px #0a0a14',
              cursor: 'pointer',
              userSelect: 'none',
            }}
          >
            Organogram
          </button>
        )}

        {/* Agent list grouped by room */}
        {!collapsed && (
          <AgentRoomList
            officeState={officeState}
            agents={agents}
            selectedAgent={selectedAgent}
            agentTools={agentTools}
            agentStatuses={agentStatuses}
            offlineAgents={offlineAgents}
            knownProjects={knownProjects}
            onSelectAgent={onSelectAgent}
            onEditLiveAgent={(id) => {
              setEditingAgentId(id)
              setEditingOfflineAgent(undefined)
              setCreatingForWorkspace(null)
            }}
            onDeleteLiveAgent={(id, name, isPersistent, persistentAgentId) => {
              const ch = officeState.characters.get(id)
              setConfirmDelete({ sessionId: (isPersistent ? persistentAgentId : ch?.sessionId) || '', name, isPersistent })
            }}
            onEditOfflineAgent={(a) => {
              setEditingAgentId(null)
              setEditingOfflineAgent(a)
              setCreatingForWorkspace(null)
            }}
            onDeleteOfflineAgent={(a) => {
              setConfirmDelete({ sessionId: a.sessionId, name: a.name || a.sessionId.slice(0, 8), isPersistent: a.isPersistent })
            }}
            onCallInOfflineAgent={(a) => {
              setCallInAgent(a)
              setCallInTask('')
              setCallInUseTeam(false)
            }}
            onRestartOfflineAgent={(a) => {
              vscode.postMessage({
                type: 'restartAgent',
                sessionId: a.sessionId,
                workspacePath: a.workspacePath,
              })
            }}
            onHireForRoom={(workspacePath) => {
              setEditingAgentId(null)
              setEditingOfflineAgent(undefined)
              setCreatingForWorkspace(workspacePath)
            }}
            onRemoveRoom={(name) => setConfirmRoomDelete({ name })}
            onOpenForeman={onOpenForeman}
            onOpenArtDirector={onOpenArtDirector}
          />
        )}
      </div>
      <Organogram
        visible={showOrganogram}
        onClose={() => setShowOrganogram(false)}
        organogram={organogram ?? null}
      />
    </>
  )
}
