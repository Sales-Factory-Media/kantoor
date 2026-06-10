import { useState } from 'react'
import type { Character } from '../office/types.js'
import { EmployeeAvatar } from './EmployeeAvatar.js'
import { timeAgo } from './agentSidebarUtils.js'

/** One running task (= one live session / iTerm tab) for this employee. */
export interface ProfileTask {
  /** Live numeric character id — the focus target for this tab. */
  id: number
  /** Stable session id — the reassign target for this tab. */
  sessionId?: string
  /** 'waiting' | 'permission' | undefined (actively working) */
  status?: string
  /** What this tab is working on (its opening prompt), if known. */
  title?: string
}

interface ProfileCardProps {
  character: Character
  /** The employee's running tasks (one per concurrent session). */
  tasks: ProfileTask[]
  /** Focus a specific task's iTerm tab + select it in the office */
  onGoTo: (id: number) => void
  /** Reassign a task (by session id) to a different employee. */
  onReassign?: (sessionId: string) => void
  /** Launch a new concurrent session for this employee (undefined = not persistent). */
  onStartJob?: (callInTask: string) => void
  /** Open the employee editor (name/role/avatar). */
  onEdit?: () => void
  onClose: () => void
}

function taskStatusLabel(status: string | undefined): { text: string; color: string } {
  if (status === 'permission') return { text: 'Needs permission', color: '#e0a93a' }
  if (status === 'waiting') return { text: 'Waiting for you', color: '#5cc46a' }
  return { text: 'Working', color: 'rgba(30,30,46,0.55)' }
}

// Shared polaroid palette so the ID card matches the photos.
const CARD_BG = '#f4efe2'
const INK = '#1e1e2e'
const INK_DIM = 'rgba(30,30,46,0.55)'
const EDGE = '#0a0a14'
/** Softer hairline for inner dividers/boxes so they don't read as harsh black. */
const SOFT = 'rgba(30,30,46,0.22)'
const PHOTO_SIZE = 200

function experienceLabel(sessionCount: number | undefined): string {
  const n = sessionCount ?? 0
  if (n <= 0) return 'New hire — first session'
  if (n === 1) return '1 session'
  return `${n} sessions`
}

/**
 * An "employee ID" profile card shown when a polaroid is clicked. Styled to
 * match the polaroids (cream frame, hard pixel border) at real ID-card
 * proportions (3.375" × 2.125" landscape), with all details beside the photo.
 * Lists every running task (with what it's working on) and can start a new job.
 */
export function ProfileCard({ character: ch, tasks, onGoTo, onReassign, onStartJob, onEdit, onClose }: ProfileCardProps) {
  const project = ch.projectName || ch.folderName
  const [composing, setComposing] = useState(false)
  const [jobText, setJobText] = useState('')
  const labelStyle: React.CSSProperties = {
    fontSize: '13px',
    color: INK_DIM,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  }
  const valueStyle: React.CSSProperties = { fontSize: '17px', color: INK }
  // Solid dark button on the cream card — high contrast, on-theme (matches the
  // dark task-count badge on the polaroids). The old --pixel-agent-* green vars
  // washed out to unreadable pale-green text on cream.
  const buttonStyle: React.CSSProperties = {
    padding: '5px 14px',
    fontSize: '16px',
    color: CARD_BG,
    background: INK,
    border: `2px solid ${EDGE}`,
    borderRadius: 0,
    cursor: 'pointer',
  }

  function launchJob() {
    onStartJob?.(jobText.trim())
    setJobText('')
    setComposing(false)
    onClose()
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
        pointerEvents: 'auto',
      }}
      onClick={onClose}
    >
      <div
        style={{
          position: 'relative',
          width: 540,
          // No fixed ratio: the card grows in height as more tasks/jobs run.
          // Cap at the viewport with a scroll fallback for extreme task counts.
          maxHeight: '90vh',
          overflowY: 'auto',
          background: CARD_BG,
          border: `2px solid ${EDGE}`,
          borderRadius: 0,
          boxShadow: `2px 2px 0px ${EDGE}`,
          padding: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          boxSizing: 'border-box',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Edit + Close */}
        <div style={{ position: 'absolute', top: 6, right: 8, display: 'flex', gap: 8, alignItems: 'center', zIndex: 1 }}>
          {onEdit && (
            <button
              onClick={onEdit}
              title="Edit employee"
              style={{ background: 'none', border: 'none', color: INK_DIM, fontSize: '18px', cursor: 'pointer', padding: '0 2px', lineHeight: 1 }}
            >
              {'✎'}
            </button>
          )}
          <button
            onClick={onClose}
            title="Close"
            style={{ background: 'none', border: 'none', color: INK_DIM, fontSize: '20px', cursor: 'pointer', padding: '0 2px', lineHeight: 1 }}
          >
            {'✕'}
          </button>
        </div>

        {/* Top: agent information — photo beside identity (kept as-is) */}
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
          <EmployeeAvatar
            id={ch.persistentAgentId || ch.sessionId}
            name={ch.name}
            avatarConfig={ch.avatarConfig}
            size={PHOTO_SIZE}
            style={{ border: `2px solid ${EDGE}`, flexShrink: 0 }}
          />

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1, minWidth: 0 }}>
            {/* Name with the role behind it */}
            <div style={{ lineHeight: 1.15 }}>
              <span style={{ fontSize: '26px', color: INK, fontWeight: 'bold' }}>
                {ch.name || 'Unknown'}
              </span>
              {ch.roleShort && (
                <span style={{ fontSize: '17px', color: INK_DIM, marginLeft: 8 }}>
                  {ch.roleShort}
                </span>
              )}
            </div>

            {project && (
              <div>
                <div style={labelStyle}>Project</div>
                <div style={valueStyle}>{project}</div>
              </div>
            )}

            <div>
              <div style={labelStyle}>Experience</div>
              <div style={valueStyle}>
                {experienceLabel(ch.sessionCount)}
                {ch.lastSessionEnd && (
                  <span style={{ color: INK_DIM, fontSize: '14px' }}>
                    {'  ·  '}last active {timeAgo(ch.lastSessionEnd)}
                  </span>
                )}
              </div>
            </div>

            {ch.roleFull && (
              <div>
                <div style={labelStyle}>Role description</div>
                <div style={{ fontSize: '15px', color: INK, lineHeight: 1.35, whiteSpace: 'pre-wrap' }}>
                  {ch.roleFull}
                </div>
              </div>
            )}

            {ch.workspacePath && (
              <div style={{ fontSize: '12px', color: INK_DIM, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {ch.workspacePath}
              </div>
            )}
          </div>
        </div>

        {/* Running tasks — full-width, one row per concurrent iTerm tab */}
        {tasks.length > 0 && (
          <div>
            <div style={labelStyle}>{tasks.length > 1 ? `Active tasks (${tasks.length})` : 'Current task'}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 4 }}>
              {tasks.map((t, i) => {
                const st = taskStatusLabel(t.status)
                return (
                  <div
                    key={t.id}
                    style={{
                      display: 'flex',
                      alignItems: 'stretch',
                      border: `1px solid ${SOFT}`,
                      borderRadius: 0,
                      background: 'rgba(255,255,255,0.45)',
                    }}
                  >
                    <button
                      onClick={() => onGoTo(t.id)}
                      title="Go to this tab"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '6px 8px',
                        flex: 1,
                        minWidth: 0,
                        textAlign: 'left',
                        border: 'none',
                        background: 'none',
                        cursor: 'pointer',
                      }}
                    >
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: st.color, flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{ fontSize: '15px', color: INK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                          title={t.title || undefined}
                        >
                          {t.title || `Tab ${i + 1}`}
                        </div>
                        <div style={{ fontSize: '13px', color: INK_DIM }}>{st.text}</div>
                      </div>
                    </button>
                    {onReassign && t.sessionId && (
                      <button
                        onClick={() => { onReassign(t.sessionId!); onClose() }}
                        title="Reassign this task to someone else"
                        style={{
                          flexShrink: 0,
                          padding: '0 10px',
                          border: 'none',
                          borderLeft: `1px solid ${SOFT}`,
                          background: 'none',
                          color: INK_DIM,
                          fontSize: '16px',
                          cursor: 'pointer',
                        }}
                      >
                        {'⇄'}
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Start a new concurrent job (a new iTerm tab) for this employee. Full-width. */}
        {onStartJob && (
          composing ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <textarea
                autoFocus
                value={jobText}
                onChange={(e) => setJobText(e.target.value)}
                placeholder="What should they work on? (optional)"
                rows={2}
                style={{
                  resize: 'vertical',
                  fontFamily: 'inherit',
                  fontSize: '14px',
                  color: INK,
                  background: '#fff',
                  border: `1px solid ${SOFT}`,
                  borderRadius: 0,
                  padding: '6px 8px',
                }}
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
                <button onClick={() => { setComposing(false); setJobText('') }} style={{ ...buttonStyle, background: 'transparent', color: INK_DIM, border: `2px solid ${SOFT}` }}>
                  Cancel
                </button>
                <button onClick={launchJob} style={buttonStyle}>
                  Launch
                </button>
              </div>
            </div>
          ) : (
            <button onClick={() => setComposing(true)} style={{ ...buttonStyle, width: '100%' }}>
              + Start new job
            </button>
          )
        )}
      </div>
    </div>
  )
}
