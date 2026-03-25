import { useState } from 'react'
import type { ToolActivity } from '../office/types.js'
import type { OfficeState } from '../office/engine/officeState.js'
import type { ClickUpStatusGroup, ClickUpTask, OfflineAgent, KnownProject } from '../hooks/useExtensionMessages.js'
import { AgentRoomList } from './AgentSidebar.js'
import { vscode } from '../vscodeApi.js'

interface ForemanPanelProps {
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
}

function WorkerPicker({
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
  const [useTeam, setUseTeam] = useState(false)
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
            Assign Worker
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
            Additional instructions (optional)
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
            placeholder="e.g. Focus on the API layer first..."
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
            padding: '2px 0',
          }}
        >
          <input
            type="checkbox"
            checked={useTeam}
            onChange={(e) => setUseTeam(e.target.checked)}
            style={{ accentColor: 'var(--pixel-accent)' }}
          />
          Use Agent Team
        </label>

        <AgentRoomList
          officeState={officeState}
          agents={agents}
          selectedAgent={null}
          agentTools={agentTools}
          agentStatuses={agentStatuses}
          offlineAgents={offlineAgents}
          knownProjects={knownProjects}
          clickupTicket={ticket}
          useTeam={useTeam}
          additionalPrompt={additionalPrompt.trim() || undefined}
          onTicketAssigned={onClose}
        />
      </div>
    </div>
  )
}

function ConfigurePanel({ onDone, isUpdate, initialListId }: { onDone: () => void; isUpdate?: boolean; initialListId?: string }) {
  const [apiToken, setApiToken] = useState('')
  const [listId, setListId] = useState(initialListId ?? '')

  const canSave = listId && (apiToken || isUpdate)

  const handleSave = () => {
    if (!canSave) return
    vscode.postMessage({ type: 'clickupConfigure', apiToken: apiToken || undefined, listId })
    onDone()
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '8px 0' }}>
      <div style={{ fontSize: '20px', color: 'var(--pixel-text)', fontWeight: 'bold' }}>
        Configure ClickUp
      </div>
      <div>
        <div style={{ fontSize: '18px', color: 'var(--pixel-text-dim)', marginBottom: 2 }}>
          API Token
        </div>
        <input
          style={inputStyle}
          value={apiToken}
          onChange={(e) => setApiToken(e.target.value)}
          placeholder={isUpdate ? 'Leave blank to keep current' : 'pk_...'}
          type="password"
        />
      </div>
      <div>
        <div style={{ fontSize: '18px', color: 'var(--pixel-text-dim)', marginBottom: 2 }}>
          List ID
        </div>
        <input
          style={inputStyle}
          value={listId}
          onChange={(e) => setListId(e.target.value)}
          placeholder="901521570151"
        />
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        {isUpdate && (
          <button
            onClick={onDone}
            style={{
              padding: '6px 12px',
              fontSize: '20px',
              color: 'var(--pixel-text)',
              background: 'var(--pixel-bg)',
              border: '2px solid var(--pixel-border)',
              borderRadius: 0,
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
        )}
        <button
          onClick={handleSave}
          disabled={!canSave}
          style={{
            padding: '6px 12px',
            fontSize: '20px',
            color: 'var(--pixel-agent-text)',
            background: !canSave ? 'var(--pixel-text-dim)' : 'var(--pixel-agent-bg)',
            border: '2px solid var(--pixel-agent-border)',
            borderRadius: 0,
            cursor: !canSave ? 'default' : 'pointer',
          }}
        >
          Save
        </button>
      </div>
    </div>
  )
}

export function ForemanPanel({
  visible,
  onClose,
  clickupTickets,
  clickupConfigured,
  clickupListId,
  offlineAgents,
  officeState,
  agents,
  agentTools,
  agentStatuses,
  knownProjects,
}: ForemanPanelProps) {
  const [pickerTicket, setPickerTicket] = useState<{ id: string; name: string; url: string } | null>(null)
  const [collapsedStatuses, setCollapsedStatuses] = useState<Set<string>>(new Set())
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
        <WorkerPicker
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
          left: 10,
          zIndex: 'var(--pixel-controls-z)',
          background: 'var(--pixel-bg)',
          border: '2px solid var(--pixel-border)',
          borderRadius: 0,
          boxShadow: 'var(--pixel-shadow)',
          width: 340,
          maxHeight: 'calc(100% - 20px)',
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
            Darryl's Office
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
              title="ClickUp settings"
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
          {!clickupConfigured || showSettings ? (
            <div style={{ padding: '0 8px' }}>
              <ConfigurePanel onDone={() => setShowSettings(false)} isUpdate={clickupConfigured} initialListId={clickupListId ?? undefined} />
            </div>
          ) : clickupTickets.length === 0 ? (
            <div style={{ padding: '12px 8px', fontSize: '18px', color: 'var(--pixel-text-dim)' }}>
              No tickets found. Click refresh to fetch.
            </div>
          ) : (
            clickupTickets.map((group) => (
              <div key={group.name}>
                {/* Status header */}
                <div
                  onClick={() => toggleStatus(group.name)}
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
                      {collapsedStatuses.has(group.name) ? '\u25B6' : '\u25BC'}
                    </span>
                    <span style={{ fontWeight: 'bold' }}>{group.name}</span>
                    <span style={{ fontSize: '16px', color: 'var(--pixel-text-dim)' }}>
                      ({group.tasks.length})
                    </span>
                  </span>
                </div>

                {/* Tasks */}
                {!collapsedStatuses.has(group.name) && (() => {
                  const parentTasks = group.tasks.filter((t) => !t.parent)
                  const childrenByParent = new Map<string, ClickUpTask[]>()
                  for (const t of group.tasks) {
                    if (t.parent) {
                      const list = childrenByParent.get(t.parent) ?? []
                      list.push(t)
                      childrenByParent.set(t.parent, list)
                    }
                  }
                  // Subtasks whose parent is in a different status group (not visible here)
                  const orphanSubtasks = group.tasks.filter((t) => t.parent && !group.tasks.some((p) => p.id === t.parent))

                  const renderTask = (task: ClickUpTask, indent: boolean) => (
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
                      <button
                        onClick={() => setPickerTicket({ id: task.id, name: task.name, url: task.url })}
                        style={{
                          padding: '2px 6px',
                          fontSize: '16px',
                          color: 'var(--pixel-agent-text)',
                          background: 'var(--pixel-agent-bg)',
                          border: '2px solid var(--pixel-agent-border)',
                          borderRadius: 0,
                          cursor: 'pointer',
                          flexShrink: 0,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        Start Work
                      </button>
                    </div>
                  )

                  return (
                    <>
                      {parentTasks.map((task) => (
                        <div key={task.id}>
                          {renderTask(task, false)}
                          {(childrenByParent.get(task.id) ?? []).map((sub) => renderTask(sub, true))}
                        </div>
                      ))}
                      {orphanSubtasks.map((task) => renderTask(task, true))}
                    </>
                  )
                })()}
              </div>
            ))
          )}
        </div>
      </div>
    </>
  )
}
