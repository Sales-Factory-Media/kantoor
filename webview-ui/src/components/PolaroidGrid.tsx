import { useState, useRef, useLayoutEffect } from 'react'
import type { OfficeState } from '../office/engine/officeState.js'
import type { Character } from '../office/types.js'
import type { KnownProject } from '../hooks/useExtensionMessages.js'
import { ProjectLogo, makeProjectLogoLookup } from './ProjectLogo.js'
import { vscode } from '../vscodeApi.js'
import { EmployeeAvatar } from './EmployeeAvatar.js'
import { ProfileCard } from './ProfileCard.js'
import { EmployeeFile } from './EmployeeFile.js'
import { ActivityBars } from './ActivityBars.js'

/** True while a task is actively working (not waiting/permission). */
function isWorking(status: string | undefined): boolean {
  return status !== 'permission' && status !== 'waiting'
}

/** How many lines of task text to show before the "More" toggle appears. */
const TASK_CLAMP_LINES = 4

/**
 * Task text clamped to a few lines with a clickable More/Less toggle. The
 * toggle only appears when the text actually overflows the clamp (measured via
 * a ResizeObserver so it re-checks as the card width changes).
 */
function TaskText({ text, tooltip }: { text: string; tooltip?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflowing, setOverflowing] = useState(false)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el || expanded) return
    const measure = () => setOverflowing(el.scrollHeight > el.clientHeight + 1)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [text, expanded])

  return (
    <>
      <div
        ref={ref}
        title={tooltip}
        style={{
          fontSize: 16,
          color: 'var(--pixel-text)',
          lineHeight: 1.3,
          wordBreak: 'break-word',
          overflowWrap: 'anywhere',
          ...(expanded
            ? {}
            : {
                display: '-webkit-box',
                WebkitBoxOrient: 'vertical',
                WebkitLineClamp: TASK_CLAMP_LINES,
                overflow: 'hidden',
              }),
        }}
      >
        {text}
      </div>
      {(overflowing || expanded) && (
        <button
          onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v) }}
          style={{
            marginTop: 3,
            padding: 0,
            background: 'none',
            border: 'none',
            color: 'var(--pixel-accent)',
            fontFamily: 'inherit',
            fontSize: 13,
            fontWeight: 'bold',
            cursor: 'pointer',
          }}
        >
          {expanded ? '▴ Less' : '▾ More'}
        </button>
      )}
    </>
  )
}

interface PolaroidGridProps {
  officeState: OfficeState
  /** Live (clocked-in) agent IDs */
  agents: number[]
  /** Per-agent status, e.g. 'waiting' | 'permission' (active agents are absent) */
  agentStatuses: Record<number, string>
  /** Known projects — supplies the per-project logo shown before the name. */
  knownProjects: KnownProject[]
  /** Focus the agent's iTerm tab + select it in the office */
  onSelect: (id: number) => void
}

// Card family colours — all sourced from the shared theme tokens so the
// "Super Terrain 86" palette stays consistent app-wide.
const CARD_BG = 'var(--pixel-bg)'
const INK = 'var(--pixel-text)'
const INK_DIM = 'var(--pixel-text-dim)'
const EDGE = 'var(--pixel-border)'
const SOFT = 'var(--pixel-border-light)'
const INSET = 'var(--pixel-surface-2)'
const PHOTO_SIZE = 128

/** Status dot color for a single task, from the shared status tokens. */
function taskDotColor(status: string | undefined): string {
  if (status === 'permission') return 'var(--pixel-status-permission)' // needs a decision
  if (status === 'waiting') return 'var(--pixel-status-waiting)' // awaiting input
  return 'var(--pixel-status-active)' // actively working
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
 * The main content area of the flat layout: a responsive grid (≈3 columns) of
 * per-employee "polaroid" cards. One card PER EMPLOYEE — an employee running
 * several concurrent tasks (one iTerm tab each) shows a single card listing all
 * of them. Each card gives roomy, direct access to the running tasks (click a
 * task to jump to its tab, ⇄ to reassign it) and an inline "+ New task"
 * composer that launches another concurrent session for that employee.
 *
 * Clicking the photo opens the full employee ID card (ProfileCard); the pencil
 * opens the employee editor (EmployeeFile).
 */
export function PolaroidGrid({ officeState, agents, agentStatuses, knownProjects, onSelect }: PolaroidGridProps) {
  const projectLogo = makeProjectLogoLookup(knownProjects)
  const [profileKey, setProfileKey] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [composingKey, setComposingKey] = useState<string | null>(null)
  const [jobText, setJobText] = useState('')

  // Group live characters by employee, skipping sub-agents (no real terminal).
  const groups = new Map<string, Character[]>()
  for (const id of agents) {
    const ch = officeState.characters.get(id)
    if (!ch || ch.isSubagent) continue
    const key = groupKey(ch)
    const arr = groups.get(key)
    if (arr) arr.push(ch)
    else groups.set(key, [ch])
  }
  // Order by project first, then employee name, so teammates sit together.
  const groupList = [...groups.entries()].sort(([, a], [, b]) => {
    const projA = (a[0].projectName || a[0].folderName || '').toLowerCase()
    const projB = (b[0].projectName || b[0].folderName || '').toLowerCase()
    if (projA !== projB) return projA.localeCompare(projB)
    return (a[0].name || '').toLowerCase().localeCompare((b[0].name || '').toLowerCase())
  })

  const profileTasks = profileKey ? groups.get(profileKey) : undefined
  const profileChar = profileTasks?.[0] ?? null

  function launchJob(persistentAgentId: string | undefined) {
    if (!persistentAgentId) return
    vscode.postMessage({
      type: 'launchAgent',
      agentId: persistentAgentId,
      callInTask: jobText.trim() || undefined,
    })
    setJobText('')
    setComposingKey(null)
  }

  if (groupList.length === 0) {
    return (
      <div
        style={{
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          color: INK_DIM,
          textAlign: 'center',
          padding: 24,
        }}
      >
        <div style={{ fontSize: 28, color: INK }}>No one's clocked in</div>
        <div style={{ fontSize: 18 }}>
          Call someone in from the Employees sidebar, or wait for tickets to be picked up.
        </div>
      </div>
    )
  }

  return (
    <div
      style={{
        // CSS multi-column = masonry. Unlike Grid (where every card in a row
        // shares one row track sized to the tallest card, leaving a gap under
        // the shorter ones), columns let each card tuck directly under the one
        // above it. `columnWidth` fits as many ~360px columns as the width
        // allows (≈3 on a wide screen). Trade-off: fill order is column-major
        // (down column 1, then column 2), not left-to-right by row.
        columnWidth: 360,
        columnGap: 16,
        padding: 16,
      }}
    >
      {groupList.map(([key, members]) => {
        const ch = members[0]
        const project = ch.projectName || ch.folderName
        const persistentAgentId = ch.persistentAgentId
        const isComposing = composingKey === key
        // Any of this employee's concurrent tasks actively working?
        const anyWorking = members.some((m) => isWorking(agentStatuses[m.id]))
        return (
          // Column-item wrapper: `break-inside: avoid` keeps a card from being
          // split across two columns; the bottom margin is the vertical gap
          // between stacked cards (multicol has no row-gap). A plain block
          // wrapper (not the flex card itself) makes the break rule reliable in
          // Blink, which can ignore break-inside on flex containers.
          <div
            key={key}
            style={{
              breakInside: 'avoid',
              marginBottom: 16,
            }}
          >
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              background: CARD_BG,
              border: `2px solid ${EDGE}`,
              borderRadius: 0,
              boxShadow: `2px 2px 0px ${EDGE}`,
              overflow: 'hidden',
            }}
          >
            {/* Identity header — photo + name/project/role. Click the photo for
                the full employee ID card; pencil edits the employee. */}
            <div style={{ display: 'flex', gap: 12, padding: 12, alignItems: 'flex-start' }}>
              <button
                onClick={() => setProfileKey(key)}
                title="Open employee card"
                style={{ position: 'relative', padding: 0, border: 'none', background: 'none', cursor: 'pointer', flexShrink: 0, lineHeight: 0 }}
              >
                <EmployeeAvatar
                  id={persistentAgentId || ch.sessionId}
                  name={ch.name}
                  avatarConfig={ch.avatarConfig}
                  size={PHOTO_SIZE}
                  style={{ border: `2px solid ${EDGE}` }}
                />
                {/* Live "working" indicator — an equalizer badge on the feed
                    while any of this employee's tasks is active. */}
                {anyWorking && (
                  <span
                    style={{
                      position: 'absolute',
                      left: 4,
                      bottom: 4,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                      padding: '2px 5px',
                      background: 'rgba(12, 7, 8, 0.72)',
                      border: `1px solid ${EDGE}`,
                    }}
                  >
                    <ActivityBars height={11} />
                    <span style={{ fontSize: 11, color: 'var(--pixel-accent)', fontWeight: 'bold', letterSpacing: '0.04em' }}>
                      LIVE
                    </span>
                  </span>
                )}
              </button>

              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                  <div
                    style={{ flex: 1, minWidth: 0, fontSize: 22, fontWeight: 'bold', color: INK, lineHeight: 1.15, wordBreak: 'break-word' }}
                  >
                    {ch.name || `Agent ${ch.id}`}
                  </div>
                  <button
                    onClick={() => { setProfileKey(key); setEditing(true) }}
                    title="Edit employee"
                    style={{ background: 'none', border: 'none', color: INK_DIM, fontSize: 16, cursor: 'pointer', padding: '0 2px', lineHeight: 1, flexShrink: 0 }}
                  >
                    {'✎'}
                  </button>
                </div>
                {project && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 16, fontWeight: 'bold', color: INK }}>
                    <ProjectLogo logo={projectLogo(ch.workspacePath, project)} size={18} />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{project}</span>
                  </div>
                )}
                {ch.roleShort && <div style={{ fontSize: 15, color: INK_DIM }}>{ch.roleShort}</div>}
              </div>
            </div>

            {/* Tasks — one row per concurrent iTerm tab. */}
            <div style={{ borderTop: `1px solid ${SOFT}`, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 13, color: INK_DIM, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                {members.length > 1 ? `Active tasks (${members.length})` : 'Current task'}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {members.map((m) => {
                  const status = agentStatuses[m.id]
                  const label = m.taskTitle || taskStatusFallback(status)
                  return (
                    <div
                      key={m.id}
                      style={{
                        display: 'flex',
                        alignItems: 'stretch',
                        border: `1px solid ${SOFT}`,
                        borderRadius: 0,
                        background: INSET,
                      }}
                    >
                      <div
                        onClick={() => onSelect(m.id)}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(m.id) } }}
                        role="button"
                        tabIndex={0}
                        title="Go to this tab"
                        style={{
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: 8,
                          padding: '8px 10px',
                          flex: 1,
                          minWidth: 0,
                          textAlign: 'left',
                          cursor: 'pointer',
                        }}
                      >
                        <span
                          style={{
                            width: 10,
                            height: 10,
                            marginTop: 3,
                            borderRadius: '50%',
                            background: taskDotColor(status),
                            border: `1px solid ${EDGE}`,
                            flexShrink: 0,
                          }}
                        />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <TaskText text={label} tooltip={m.taskTitle || undefined} />
                          <div style={{ fontSize: 13, color: INK_DIM, display: 'flex', alignItems: 'center', marginTop: 2 }}>
                            {isWorking(status) && <ActivityBars height={10} />}
                            {taskStatusFallback(status)}
                          </div>
                        </div>
                      </div>
                      {m.sessionId && (
                        <button
                          onClick={() => vscode.postMessage({ type: 'reassignTask', sessionId: m.sessionId })}
                          title="Reassign this task to someone else"
                          style={{
                            flexShrink: 0,
                            padding: '0 12px',
                            border: 'none',
                            borderLeft: `1px solid ${SOFT}`,
                            background: 'none',
                            color: INK_DIM,
                            fontSize: 16,
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

              {/* Inline "+ New task" composer — direct access to launching
                  another concurrent session for this employee. */}
              {persistentAgentId && (
                isComposing ? (
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
                        fontSize: 14,
                        color: INK,
                        background: INSET,
                        border: `1px solid ${SOFT}`,
                        borderRadius: 0,
                        padding: '6px 8px',
                      }}
                    />
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
                      <button
                        onClick={() => { setComposingKey(null); setJobText('') }}
                        style={{ padding: '5px 12px', fontSize: 15, color: INK_DIM, background: 'transparent', border: `2px solid ${SOFT}`, borderRadius: 0, cursor: 'pointer' }}
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => launchJob(persistentAgentId)}
                        style={{ padding: '5px 12px', fontSize: 15, color: 'var(--pixel-agent-text)', background: 'var(--pixel-agent-bg)', border: '2px solid var(--pixel-agent-border)', borderRadius: 0, cursor: 'pointer' }}
                      >
                        Launch
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => { setComposingKey(key); setJobText('') }}
                    style={{ width: '100%', padding: '7px 12px', fontSize: 15, color: 'var(--pixel-agent-text)', background: 'var(--pixel-agent-bg)', border: '2px solid var(--pixel-agent-border)', borderRadius: 0, cursor: 'pointer' }}
                  >
                    + New task
                  </button>
                )
              )}
            </div>
          </div>
          </div>
        )
      })}

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
          projectLogo={projectLogo(profileChar.workspacePath, profileChar.projectName || profileChar.folderName)}
          onClose={() => { setEditing(false); setProfileKey(null) }}
        />
      )}
    </div>
  )
}
