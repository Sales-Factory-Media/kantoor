import { useState, useMemo } from 'react'
import type { ToolActivity } from '../office/types.js'
import type { OfficeState } from '../office/engine/officeState.js'
import type { OfflineAgent, KnownProject } from '../hooks/useExtensionMessages.js'
import { vscode } from '../vscodeApi.js'
import { FOREMAN_ROOM_NAME, ART_DIRECTOR_ROOM_NAME } from '../constants.js'
import { getActivity, getDotInfo, groupByRoom, deleteButtonStyle } from './agentSidebarUtils.js'
import type { ClickUpTicketRef } from './agentSidebarUtils.js'
import { OfflineAgentRow } from './OfflineAgentRow.js'

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

  const regularRooms = [...roomGroups.entries()]
    .filter(([, g]) => !g.isSpecialRoom)
    .sort(([a], [b]) => {
      if (!a) return 1
      if (!b) return -1
      return a.localeCompare(b, undefined, { sensitivity: 'base' })
    })
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
            const handleSpecialClick = isForeman && onOpenForeman ? onOpenForeman : isArtDirector && onOpenArtDirector ? onOpenArtDirector : undefined
            return (
            <div key={projectName}>
              {/* Room header */}
              <div
                onClick={handleSpecialClick}
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
