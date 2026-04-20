import { useState, useEffect } from 'react'
import type { ToolActivity } from '../office/types.js'
import type { OfficeState } from '../office/engine/officeState.js'
import type { ClickUpStatusGroup, ClickUpTask, OfflineAgent, KnownProject, WorkerStatusEntry, JanDesignConfig } from '../hooks/useExtensionMessages.js'
import { AgentRoomList } from './AgentSidebar.js'
import { vscode } from '../vscodeApi.js'
import { JAN_CLICKUP_USERNAME } from '../constants.js'

interface ArtDirectorPanelProps {
  visible: boolean
  onClose: () => void
  clickupTickets: ClickUpStatusGroup[]
  clickupConfigured: boolean
  clickupListId: string | null
  offlineAgents: OfflineAgent[]
  officeState: OfficeState
  agents: number[]
  agentTools: Record<number, ToolActivity[]>
  agentStatuses: Record<number, string>
  knownProjects: KnownProject[]
  workers: WorkerStatusEntry[]
  janDesignConfig: JanDesignConfig | null
}

function DesignerPicker({
  ticketId,
  ticketName,
  ticketUrl,
  officeState,
  agents,
  agentTools,
  agentStatuses,
  offlineAgents,
  knownProjects,
  onClose,
}: {
  ticketId: string
  ticketName: string
  ticketUrl: string
  officeState: OfficeState
  agents: number[]
  agentTools: Record<number, ToolActivity[]>
  agentStatuses: Record<number, string>
  offlineAgents: OfflineAgent[]
  knownProjects: KnownProject[]
  onClose: () => void
}) {
  const [additionalPrompt, setAdditionalPrompt] = useState('')
  const ticket = { id: ticketId, name: ticketName, url: ticketUrl }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 10002,
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
          maxWidth: 400,
          maxHeight: '80vh',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: '22px', color: 'var(--pixel-text)', fontWeight: 'bold' }}>
            Assign Designer
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

        <div style={{ fontSize: '18px', color: 'var(--pixel-text-dim)', marginBottom: 4 }}>
          {ticketName}
        </div>

        <div>
          <div style={{ fontSize: '18px', color: 'var(--pixel-text-dim)', marginBottom: 2 }}>
            Design brief notes (optional)
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
            value={additionalPrompt}
            onChange={(e) => setAdditionalPrompt(e.target.value)}
            placeholder="e.g. Focus on mobile-first UX exploration..."
          />
        </div>

        <AgentRoomList
          officeState={officeState}
          agents={agents}
          selectedAgent={null}
          agentTools={agentTools}
          agentStatuses={agentStatuses}
          offlineAgents={offlineAgents}
          knownProjects={knownProjects}
          clickupTicket={ticket}
          additionalPrompt={additionalPrompt.trim() || undefined}
          onTicketAssigned={onClose}
        />
      </div>
    </div>
  )
}

function isAssignedToJan(task: ClickUpTask): boolean {
  return task.assignees.some((a) => a.username === JAN_CLICKUP_USERNAME)
}

function filterGroups(groups: ClickUpStatusGroup[], predicate: (t: ClickUpTask) => boolean): ClickUpStatusGroup[] {
  return groups
    .map((g) => ({ ...g, tasks: g.tasks.filter(predicate) }))
    .filter((g) => g.tasks.length > 0)
}

function renderTask(
  task: ClickUpTask,
  indent: boolean,
  statusName: string,
  onPickTicket: (t: { id: string; name: string; url: string }) => void,
) {
  const isTodo = statusName.toLowerCase() === 'to do'

  const handleCopyUrl = () => {
    navigator.clipboard.writeText(task.url).catch(() => {
      // silent fail
    })
  }

  return (
    <div
      key={task.id}
      style={{
        padding: `4px 8px 4px ${indent ? 28 : 14}px`,
        borderBottom: '1px solid var(--pixel-border)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 6,
      }}
    >
      <div style={{ overflow: 'hidden', flex: 1 }}>
        <div
          style={{
            fontSize: indent ? '16px' : '18px',
            color: 'var(--pixel-text)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={task.name}
        >
          {indent && <span style={{ color: 'var(--pixel-text-dim)', marginRight: 4 }}>{'\u2514'}</span>}
          {task.name}
        </div>
        {task.assignees.length > 0 && (
          <div style={{ fontSize: '14px', color: 'var(--pixel-text-dim)', paddingLeft: indent ? 16 : 0 }}>
            {task.assignees.map((a) => a.username).join(', ')}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
        {isTodo ? (
          <>
            <button
              onClick={() => onPickTicket({ id: task.id, name: task.name, url: task.url })}
              style={{
                padding: '2px 6px',
                fontSize: '16px',
                color: 'var(--pixel-agent-text)',
                background: 'var(--pixel-agent-bg)',
                border: '2px solid var(--pixel-agent-border)',
                borderRadius: 0,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              Start Work
            </button>
            <button
              onClick={() => vscode.postMessage({ type: 'janDesignBriefing', ticketId: task.id, ticketName: task.name, ticketUrl: task.url })}
              title="Send to Jan for art direction"
              style={{
                padding: '2px 6px',
                fontSize: '16px',
                color: 'var(--pixel-text)',
                background: 'var(--pixel-bg)',
                border: '2px solid var(--pixel-border)',
                borderRadius: 0,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              Jan
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() => window.open(task.url, '_blank')}
              title="Open in ClickUp"
              style={{
                padding: '2px 6px',
                fontSize: '16px',
                color: 'var(--pixel-agent-text)',
                background: 'var(--pixel-agent-bg)',
                border: '2px solid var(--pixel-agent-border)',
                borderRadius: 0,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              Open
            </button>
            <button
              onClick={handleCopyUrl}
              title="Copy ClickUp link"
              style={{
                padding: '2px 6px',
                fontSize: '16px',
                color: 'var(--pixel-text)',
                background: 'var(--pixel-bg)',
                border: '2px solid var(--pixel-border)',
                borderRadius: 0,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              Copy
            </button>
          </>
        )}
      </div>
    </div>
  )
}

function renderStatusGroup(
  group: ClickUpStatusGroup,
  collapsed: boolean,
  onToggle: () => void,
  onPickTicket: (t: { id: string; name: string; url: string }) => void,
) {
  const parentTasks = group.tasks.filter((t) => !t.parent)
  const childrenByParent = new Map<string, ClickUpTask[]>()
  for (const t of group.tasks) {
    if (t.parent) {
      const list = childrenByParent.get(t.parent) ?? []
      list.push(t)
      childrenByParent.set(t.parent, list)
    }
  }
  const orphanSubtasks = group.tasks.filter((t) => t.parent && !group.tasks.some((p) => p.id === t.parent))

  return (
    <div key={group.name}>
      <div
        onClick={onToggle}
        style={{
          padding: '4px 8px',
          fontSize: '18px',
          color: 'var(--pixel-text)',
          background: `${group.color}22`,
          borderBottom: '1px solid var(--pixel-border)',
          borderLeft: `3px solid ${group.color}`,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          userSelect: 'none',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: '14px', color: 'var(--pixel-text-dim)' }}>
            {collapsed ? '\u25B6' : '\u25BC'}
          </span>
          <span style={{ fontWeight: 'bold' }}>{group.name}</span>
          <span style={{ fontSize: '16px', color: 'var(--pixel-text-dim)' }}>
            ({group.tasks.length})
          </span>
        </span>
      </div>
      {!collapsed && (
        <>
          {parentTasks.map((task) => (
            <div key={task.id}>
              {renderTask(task, false, group.name, onPickTicket)}
              {(childrenByParent.get(task.id) ?? []).map((sub) => renderTask(sub, true, group.name, onPickTicket))}
            </div>
          ))}
          {orphanSubtasks.map((task) => renderTask(task, true, group.name, onPickTicket))}
        </>
      )}
    </div>
  )
}

function TicketList({
  clickupTickets,
  collapsedStatuses,
  toggleStatus,
  otherTasksOpen,
  setOtherTasksOpen,
  onPickTicket,
}: {
  clickupTickets: ClickUpStatusGroup[]
  collapsedStatuses: Set<string>
  toggleStatus: (name: string) => void
  otherTasksOpen: boolean
  setOtherTasksOpen: (open: boolean) => void
  onPickTicket: (t: { id: string; name: string; url: string }) => void
}) {
  const janGroups = filterGroups(clickupTickets, isAssignedToJan)
  const otherGroups = filterGroups(clickupTickets, (t) => !isAssignedToJan(t))
  const janTotal = janGroups.reduce((n, g) => n + g.tasks.length, 0)
  const otherTotal = otherGroups.reduce((n, g) => n + g.tasks.length, 0)

  return (
    <>
      {/* Jan's assigned tasks */}
      {janTotal > 0 ? (
        janGroups.map((group) =>
          renderStatusGroup(
            group,
            collapsedStatuses.has(group.name),
            () => toggleStatus(group.name),
            onPickTicket,
          ),
        )
      ) : (
        <div style={{ padding: '8px 8px', fontSize: '18px', color: 'var(--pixel-text-dim)' }}>
          No tasks assigned to Jan.
        </div>
      )}

      {/* Other tasks — collapsible, closed by default */}
      {otherTotal > 0 && (
        <>
          <button
            onClick={() => setOtherTasksOpen(!otherTasksOpen)}
            style={{
              padding: '6px 8px',
              fontSize: '18px',
              color: 'var(--pixel-text)',
              background: 'var(--pixel-bg)',
              borderTop: '2px solid var(--pixel-border)',
              borderBottom: '1px solid var(--pixel-border)',
              borderLeft: 'none',
              borderRight: 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              userSelect: 'none',
              width: '100%',
              textAlign: 'left',
            }}
          >
            <span style={{ fontSize: '14px', color: 'var(--pixel-text-dim)' }}>
              {otherTasksOpen ? '\u25BC' : '\u25B6'}
            </span>
            <span style={{ fontWeight: 'bold' }}>Other Tasks</span>
            <span style={{ fontSize: '16px', color: 'var(--pixel-text-dim)' }}>
              ({otherTotal})
            </span>
          </button>
          {otherTasksOpen &&
            otherGroups.map((group) =>
              renderStatusGroup(
                group,
                collapsedStatuses.has('other:' + group.name),
                () => toggleStatus('other:' + group.name),
                onPickTicket,
              ),
            )}
        </>
      )}
    </>
  )
}

function DesignConfigSection({ config }: { config: JanDesignConfig | null }) {
  const [figmaUrl, setFigmaUrl] = useState('')
  const [clickupDocUrl, setClickupDocUrl] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (config) {
      setFigmaUrl(config.figmaUrl)
      setClickupDocUrl(config.clickupDocUrl)
      setSaved(false)
    }
  }, [config])

  const handleSave = () => {
    vscode.postMessage({ type: 'setJanDesignConfig', figmaUrl, clickupDocUrl })
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const hasChanges = config && (figmaUrl !== config.figmaUrl || clickupDocUrl !== config.clickupDocUrl)

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '6px 8px',
    fontSize: '14px',
    color: 'var(--pixel-text)',
    background: 'var(--pixel-bg)',
    border: '2px solid var(--pixel-border)',
    borderRadius: 0,
    outline: 'none',
    boxSizing: 'border-box',
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '8px 0' }}>
      <div style={{ fontSize: '20px', color: 'var(--pixel-text)', fontWeight: 'bold' }}>
        Design Config
      </div>
      <div>
        <div style={{ fontSize: '18px', color: 'var(--pixel-text-dim)', marginBottom: 2 }}>
          Figma Design File URL
        </div>
        <input
          type="text"
          style={inputStyle}
          value={figmaUrl}
          onChange={(e) => setFigmaUrl(e.target.value)}
          placeholder="https://www.figma.com/design/..."
        />
      </div>
      <div>
        <div style={{ fontSize: '18px', color: 'var(--pixel-text-dim)', marginBottom: 2 }}>
          ClickUp Document URL
        </div>
        <input
          type="text"
          style={inputStyle}
          value={clickupDocUrl}
          onChange={(e) => setClickupDocUrl(e.target.value)}
          placeholder="https://app.clickup.com/..."
        />
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <button
          onClick={handleSave}
          disabled={!hasChanges}
          style={{
            padding: '4px 12px',
            fontSize: '16px',
            color: hasChanges ? 'var(--pixel-agent-text)' : 'var(--pixel-text-dim)',
            background: hasChanges ? 'var(--pixel-agent-bg)' : 'var(--pixel-bg)',
            border: `2px solid ${hasChanges ? 'var(--pixel-agent-border)' : 'var(--pixel-border)'}`,
            borderRadius: 0,
            cursor: hasChanges ? 'pointer' : 'default',
          }}
        >
          Save
        </button>
        {saved && (
          <span style={{ fontSize: '14px', color: 'var(--pixel-accent)' }}>Saved</span>
        )}
      </div>
    </div>
  )
}

export function ArtDirectorPanel({
  visible,
  onClose,
  clickupTickets,
  clickupConfigured,
  offlineAgents,
  officeState,
  agents,
  agentTools,
  agentStatuses,
  knownProjects,
  janDesignConfig,
}: ArtDirectorPanelProps) {
  const [pickerTicket, setPickerTicket] = useState<{ id: string; name: string; url: string } | null>(null)
  const [collapsedStatuses, setCollapsedStatuses] = useState<Set<string>>(new Set())
  const [otherTasksOpen, setOtherTasksOpen] = useState(false)
  const [showSettings, setShowSettings] = useState(false)

  if (!visible) return null

  const toggleStatus = (name: string) => {
    setCollapsedStatuses((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const handleRefresh = () => {
    vscode.postMessage({ type: 'clickupRefresh' })
  }

  return (
    <>
      {pickerTicket && (
        <DesignerPicker
          ticketId={pickerTicket.id}
          ticketName={pickerTicket.name}
          ticketUrl={pickerTicket.url}
          officeState={officeState}
          agents={agents}
          agentTools={agentTools}
          agentStatuses={agentStatuses}
          offlineAgents={offlineAgents}
          knownProjects={knownProjects}
          onClose={() => setPickerTicket(null)}
        />
      )}
      <div
        style={{
          position: 'absolute',
          top: 10,
          left: 360,
          zIndex: 'var(--pixel-controls-z)',
          width: 340,
          maxHeight: 'calc(100% - 20px)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
        }}
      >
        {/* Jan avatar floating above the panel */}
        <div
          style={{
            width: 96,
            height: 96,
            borderRadius: '50%',
            border: '2px solid var(--pixel-border)',
            boxShadow: 'var(--pixel-shadow)',
            overflow: 'hidden',
            marginBottom: -16,
            zIndex: 1,
            pointerEvents: 'none',
          }}
        >
          <img
            src="/jan.png"
            alt="Jan"
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        </div>
        <div
          style={{
            background: 'var(--pixel-bg)',
            border: '2px solid var(--pixel-border)',
            borderRadius: 0,
            boxShadow: 'var(--pixel-shadow)',
            width: '100%',
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '6px 8px',
            borderBottom: '2px solid var(--pixel-border)',
          }}
        >
          <span style={{ fontSize: '22px', color: 'var(--pixel-text)', fontWeight: 'bold' }}>
            Jan's Office
          </span>
          <div style={{ display: 'flex', gap: 4 }}>
            <button
              onClick={handleRefresh}
              title="Refresh tickets"
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--pixel-text-dim)',
                fontSize: '18px',
                cursor: 'pointer',
                padding: '0 4px',
              }}
            >
              {'\u21BB'}
            </button>
            <button
              onClick={() => setShowSettings((p) => !p)}
              title="Design config"
              style={{
                background: 'none',
                border: 'none',
                color: showSettings ? 'var(--pixel-accent)' : 'var(--pixel-text-dim)',
                fontSize: '18px',
                cursor: 'pointer',
                padding: '0 4px',
              }}
            >
              {'\u2699'}
            </button>
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
        </div>

        {/* Content */}
        <div style={{ overflowY: 'auto', flex: 1, padding: '4px 0' }}>
          {showSettings ? (
            <div style={{ padding: '0 8px' }}>
              <DesignConfigSection config={janDesignConfig} />
            </div>
          ) : !clickupConfigured ? (
            <div style={{ padding: '12px 8px', fontSize: '18px', color: 'var(--pixel-text-dim)' }}>
              ClickUp not configured. Set it up in Darryl's Office first.
            </div>
          ) : clickupTickets.length === 0 ? (
            <div style={{ padding: '12px 8px', fontSize: '18px', color: 'var(--pixel-text-dim)' }}>
              No tickets found. Click refresh to fetch.
            </div>
          ) : (
            <TicketList
              clickupTickets={clickupTickets}
              collapsedStatuses={collapsedStatuses}
              toggleStatus={toggleStatus}
              otherTasksOpen={otherTasksOpen}
              setOtherTasksOpen={setOtherTasksOpen}
              onPickTicket={setPickerTicket}
            />
          )}
        </div>
      </div>
      </div>
    </>
  )
}
