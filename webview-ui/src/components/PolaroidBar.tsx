import { useState } from 'react'
import type { OfficeState } from '../office/engine/officeState.js'
import type { Character } from '../office/types.js'
import { vscode } from '../vscodeApi.js'
import { EmployeeAvatar } from './EmployeeAvatar.js'
import { ProfileCard } from './ProfileCard.js'
import { EmployeeFile } from './EmployeeFile.js'

interface PolaroidBarProps {
  officeState: OfficeState
  /** Live (clocked-in) agent IDs */
  agents: number[]
  /** Per-agent status, e.g. 'waiting' | 'permission' (active agents are absent) */
  agentStatuses: Record<number, string>
  /** Focus the agent's iTerm tab + select it in the office */
  onSelect: (id: number) => void
}

/** Photo size — big enough that the caption fits on a couple of lines. */
const PHOTO_SIZE = 160
/** Even cream frame on the left, right, and bottom of the photo. */
const FRAME = 10

/** Status dot color for a single task, matching the on-canvas pip colors. */
function taskDotColor(status: string | undefined): string {
  if (status === 'permission') return '#e0a93a' // needs a permission decision
  if (status === 'waiting') return '#5cc46a' // turn done, awaiting input
  return '#5a8cff' // actively working
}

/** Stable group key: one employee (persistentAgentId) or a lone session. */
function groupKey(ch: Character): string {
  return ch.persistentAgentId ?? `id:${ch.id}`
}

/**
 * A horizontal row of "polaroid" photos for every clocked-in worker, docked at
 * the bottom of the screen. One card PER EMPLOYEE — an employee running several
 * concurrent tasks (one iTerm tab each) shows a single card with a task-count
 * badge. Clicking opens an employee ID card listing those tasks.
 *
 * At rest the cards peek ~20% below the bottom edge; hovering floats a card the
 * same distance up so it clears the edge.
 */
export function PolaroidBar({ officeState, agents, agentStatuses, onSelect }: PolaroidBarProps) {
  const [hovered, setHovered] = useState<string | null>(null)
  const [profileKey, setProfileKey] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)

  // Group live characters by employee, skipping sub-agents (they have no real
  // terminal of their own).
  const groups = new Map<string, Character[]>()
  for (const id of agents) {
    const ch = officeState.characters.get(id)
    if (!ch || ch.isSubagent) continue
    const key = groupKey(ch)
    const arr = groups.get(key)
    if (arr) arr.push(ch)
    else groups.set(key, [ch])
  }
  // Order the cards by project first, then alphabetically by employee name, so
  // teammates on the same project sit together and the row is stable.
  const groupList = [...groups.entries()].sort(([, a], [, b]) => {
    const projA = (a[0].projectName || a[0].folderName || '').toLowerCase()
    const projB = (b[0].projectName || b[0].folderName || '').toLowerCase()
    if (projA !== projB) return projA.localeCompare(projB)
    return (a[0].name || '').toLowerCase().localeCompare((b[0].name || '').toLowerCase())
  })

  const profileTasks = profileKey ? groups.get(profileKey) : undefined
  const profileChar = profileTasks?.[0] ?? null

  if (groupList.length === 0) return null

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 'var(--pixel-controls-z)' as unknown as number,
        display: 'flex',
        justifyContent: 'center',
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          display: 'flex',
          gap: 12,
          padding: '0 12px',
          maxWidth: '100%',
          pointerEvents: 'auto',
        }}
      >
        {groupList.map(([key, members]) => {
          const ch = members[0]
          const project = ch.projectName || ch.folderName
          const captionParts = [ch.name, project, ch.roleShort].filter(Boolean)
          const captionTitle = captionParts.join(' · ')
          const isHovered = hovered === key
          return (
            <button
              key={key}
              onClick={() => setProfileKey(key)}
              onMouseEnter={() => setHovered(key)}
              onMouseLeave={() => setHovered(null)}
              title={captionTitle || `Agent ${ch.id}`}
              style={{
                position: 'relative',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 5,
                padding: `8px ${FRAME}px ${FRAME}px`,
                background: '#f4efe2',
                border: '2px solid #0a0a14',
                borderRadius: 0,
                boxShadow: '2px 2px 0px #0a0a14',
                cursor: 'pointer',
                flexShrink: 0,
                // Peek ~20% below the edge at rest; float the same distance up on hover.
                transform: isHovered ? 'translateY(-20%)' : 'translateY(20%)',
                transition: 'transform 0.18s ease',
              }}
            >
              {/* Status tab — one colored dot per running task, sitting just
                  above the polaroid like a folder tab. */}
              <div
                style={{
                  position: 'absolute',
                  left: '50%',
                  bottom: '100%',
                  transform: 'translate(-50%, 2px)', // overlap the card's top border
                  display: 'flex',
                  alignItems: 'center',
                  gap: 5,
                  padding: '3px 8px',
                  background: '#f4efe2',
                  border: '2px solid #0a0a14',
                  borderBottom: 'none',
                }}
              >
                {members.map((m) => (
                  <span
                    key={m.id}
                    title={agentStatuses[m.id] === 'permission' ? 'Needs permission' : agentStatuses[m.id] === 'waiting' ? 'Waiting for you' : 'Working'}
                    style={{
                      width: 9,
                      height: 9,
                      borderRadius: '50%',
                      background: taskDotColor(agentStatuses[m.id]),
                      border: '1px solid #0a0a14',
                    }}
                  />
                ))}
              </div>
              {/* Full caption on top */}
              <div
                style={{
                  maxWidth: PHOTO_SIZE,
                  fontSize: '18px',
                  color: '#1e1e2e',
                  textAlign: 'center',
                  lineHeight: 1.2,
                  wordBreak: 'break-word',
                  display: 'flex',
                  flexDirection: 'column',
                }}
              >
                {ch.name && <div>{ch.name}</div>}
                {project && <div style={{ fontWeight: 'bold' }}>{project}</div>}
                {ch.roleShort && <div>{ch.roleShort}</div>}
                {captionParts.length === 0 && <div>{`Agent ${ch.id}`}</div>}
              </div>
              {/* Photo */}
              <EmployeeAvatar
                id={ch.persistentAgentId || ch.sessionId}
                name={ch.name}
                avatarConfig={ch.avatarConfig}
                size={PHOTO_SIZE}
                style={{ border: '2px solid #0a0a14' }}
              />
            </button>
          )
        })}
      </div>

      {profileChar && profileTasks && editing && (
        <EmployeeFile
          officeState={officeState}
          agentId={profileChar.id}
          onClose={() => setEditing(false)}
          onSave={() => setEditing(false)}
        />
      )}

      {profileChar && profileTasks && !editing && (
        <ProfileCard
          character={profileChar}
          tasks={profileTasks.map((m) => ({ id: m.id, sessionId: m.sessionId, status: agentStatuses[m.id], title: m.taskTitle }))}
          onGoTo={(id) => onSelect(id)}
          onReassign={(sessionId) => vscode.postMessage({ type: 'reassignTask', sessionId })}
          onStartJob={
            profileChar.persistentAgentId
              ? (callInTask) => {
                  vscode.postMessage({
                    type: 'launchAgent',
                    agentId: profileChar.persistentAgentId,
                    callInTask: callInTask || undefined,
                  })
                }
              : undefined
          }
          onEdit={() => setEditing(true)}
          onClose={() => { setEditing(false); setProfileKey(null) }}
        />
      )}
    </div>
  )
}
