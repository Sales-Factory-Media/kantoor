import { useState } from 'react'
import type { ToolActivity } from '../office/types.js'
import type { OfficeState } from '../office/engine/officeState.js'
import type { OfflineAgent, KnownProject, OrganogramPayload } from '../hooks/useExtensionMessages.js'
import { vscode } from '../vscodeApi.js'
import { Organogram } from './Organogram.js'
import { ConfirmDialog } from './ConfirmDialog.js'
import { EmployeeFile } from './EmployeeFile.js'
import { CallInModal } from './CallInModal.js'
import { ConferenceModal } from './ConferenceModal.js'
import { WorkingEmployees } from './WorkingEmployees.js'
import { AgentRoomList } from './AgentRoomList.js'

// Re-export for consumers that import from this file
export { AgentRoomList } from './AgentRoomList.js'
export { OfflineAgentRow } from './OfflineAgentRow.js'
export type { ClickUpTicketRef } from './agentSidebarUtils.js'
export type { AgentRoomListProps } from './AgentRoomList.js'

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
  /** Render as a fixed full-height left column (flat layout) rather than a
   *  floating panel. Hides the redundant "Working" quick-view and the collapse
   *  toggle; the agent grid already surfaces who's active. */
  docked?: boolean
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
  docked,
}: AgentSidebarProps) {
  const [collapsed, setCollapsed] = useState(false)
  // In the docked column the sidebar is always expanded (no floating collapse).
  const isCollapsed = docked ? false : collapsed
  const [showOrganogram, setShowOrganogram] = useState(false)
  const [editingAgentId, setEditingAgentId] = useState<number | null>(null)
  const [editingOfflineAgent, setEditingOfflineAgent] = useState<OfflineAgent | undefined>(undefined)
  const [creatingForWorkspace, setCreatingForWorkspace] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<{ sessionId: string; name: string; isPersistent?: boolean } | null>(null)
  const [confirmRoomDelete, setConfirmRoomDelete] = useState<{ name: string } | null>(null)
  const [callInAgent, setCallInAgent] = useState<OfflineAgent | null>(null)
  const [showConferenceModal, setShowConferenceModal] = useState(false)

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
        <CallInModal
          agent={callInAgent}
          onClose={() => setCallInAgent(null)}
        />
      )}
      {showConferenceModal && (
        <ConferenceModal
          officeState={officeState}
          agents={agents}
          offlineAgents={offlineAgents}
          onClose={() => setShowConferenceModal(false)}
        />
      )}
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

      {/* Working Employees quick-view panel \u2014 redundant with the agent grid
          in the docked/flat layout. */}
      {!docked && !isCollapsed && (
        <WorkingEmployees
          officeState={officeState}
          agents={agents}
          selectedAgent={selectedAgent}
          agentTools={agentTools}
          agentStatuses={agentStatuses}
          onSelectAgent={onSelectAgent}
        />
      )}

      <div
        style={{
          position: docked ? 'relative' : 'absolute',
          top: docked ? undefined : 10,
          right: docked ? undefined : 10,
          zIndex: 'var(--pixel-controls-z)',
          display: 'flex',
          flexDirection: 'column',
          gap: 0,
          background: 'var(--pixel-bg)',
          border: docked ? 'none' : '2px solid var(--pixel-border)',
          borderRight: docked ? '2px solid var(--pixel-border)' : undefined,
          borderRadius: 0,
          boxShadow: docked ? 'none' : 'var(--pixel-shadow)',
          width: docked ? 264 : undefined,
          minWidth: docked ? 264 : isCollapsed ? undefined : 180,
          maxWidth: docked ? 264 : 300,
          height: docked ? '100%' : undefined,
          maxHeight: docked ? undefined : 'calc(100% - 20px)',
          overflowY: docked ? 'auto' : 'hidden',
          overflowX: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '4px 6px',
            borderBottom: isCollapsed ? 'none' : '2px solid var(--pixel-border)',
            cursor: docked ? 'default' : 'pointer',
          }}
          onClick={docked ? undefined : () => setCollapsed((p) => !p)}
        >
          <span style={{ fontSize: '22px', color: 'var(--pixel-text)', userSelect: 'none' }}>
            Employees ({agents.length})
          </span>
          {!docked && (
            <span style={{ fontSize: '18px', color: 'var(--pixel-text-dim)', userSelect: 'none', marginLeft: 6 }}>
              {collapsed ? '\u25B6' : '\u25BC'}
            </span>
          )}
        </div>

        {/* Conference button */}
        {!isCollapsed && (
          <button
            onClick={() => setShowConferenceModal(true)}
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

        {/* Organogram button */}
        {!isCollapsed && (
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
        {!isCollapsed && (
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
