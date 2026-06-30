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

function taskStatusFallback(status: string | undefined): string {
  if (status === 'permission') return 'Needs permission'
  if (status === 'waiting') return 'Waiting for you'
  return 'Working…'
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
 * The cards peek ~20% below the bottom edge, statically — no hover-raise, so
 * their task tabs stay easy to click.
 */
export function PolaroidBar({ officeState, agents, agentStatuses, onSelect }: PolaroidBarProps) {
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
          return (
            <div
              key={key}
              role="button"
              tabIndex={0}
              onClick={() => setProfileKey(key)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setProfileKey(key)
                }
              }}
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
                // Peek ~20% below the bottom edge, statically — no hover-raise,
                // so the task tabs above the card stay put and easy to click.
                transform: 'translateY(20%)',
              }}
            >
              {/* Task tab — one clickable button per running task, sitting just
                  above the polaroid like a folder tab. The button label is the
                  task description; clicking jumps straight to its iTerm tab. */}
              <div
                style={{
                  position: 'absolute',
                  left: '50%',
                  bottom: '100%',
                  transform: 'translate(-50%, 2px)', // overlap the card's top border
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'stretch',
                  gap: 3,
                  padding: '4px 4px 5px',
                  background: '#f4efe2',
                  border: '2px solid #0a0a14',
                  borderBottom: 'none',
                  maxWidth: PHOTO_SIZE + FRAME * 2,
                  minWidth: Math.round(PHOTO_SIZE * 0.6),
                }}
              >
                {members.map((m) => {
                  const status = agentStatuses[m.id]
                  const label = m.taskTitle || taskStatusFallback(status)
                  return (
                    <button
                      key={m.id}
                      onClick={(e) => {
                        e.stopPropagation()
                        onSelect(m.id)
                      }}
                      title={label}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '3px 7px',
                        background: '#fffaf0',
                        border: '1px solid #0a0a14',
                        borderRadius: 0,
                        color: '#1e1e2e',
                        font: 'inherit',
                        fontSize: '13px',
                        lineHeight: 1.2,
                        cursor: 'pointer',
                        textAlign: 'left',
                        minWidth: 0,
                      }}
                    >
                      <span
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: '50%',
                          background: taskDotColor(status),
                          border: '1px solid #0a0a14',
                          flexShrink: 0,
                        }}
                      />
                      <span
                        style={{
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          minWidth: 0,
                          flex: 1,
                        }}
                      >
                        {label}
                      </span>
                    </button>
                  )
                })}
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
            </div>
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
