import { useState, useCallback, useRef, useEffect } from 'react'
import { OfficeState } from './office/engine/officeState.js'
import { vscode } from './vscodeApi.js'
import { useExtensionMessages } from './hooks/useExtensionMessages.js'
import { PULSE_ANIMATION_DURATION_SEC } from './constants.js'
import { DebugView } from './components/DebugView.js'
import { AgentSidebar } from './components/AgentSidebar.js'
import { ForemanPanel } from './components/ForemanPanel.js'
import { ArtDirectorPanel } from './components/ArtDirectorPanel.js'
import { IdentifyWorkerModal } from './components/IdentifyWorkerModal.js'
import { IdentityPromptModal } from './components/IdentityPromptModal.js'
import { PolaroidGrid } from './components/PolaroidGrid.js'
import { TopBar } from './components/TopBar.js'
import { DelegationConfirmModal } from './components/DelegationConfirmModal.js'
import { Credits } from './components/Credits.js'

// Game state lives outside React — updated imperatively by message handlers.
// Retained (even though the pixel office is no longer rendered) because the
// message handlers populate character identity/status/task data that the
// polaroid grid and sidebar read from.
const officeStateRef = { current: null as OfficeState | null }

function getOfficeState(): OfficeState {
  if (!officeStateRef.current) {
    officeStateRef.current = new OfficeState()
  }
  return officeStateRef.current
}

function App() {
  const { agents, selectedAgent, selectAgent, agentTools, agentStatuses, subagentTools, layoutReady, offlineAgents, knownProjects, saveAgentMeta, forgetAgent, clickupTickets, clickupConfigured, clickupListId, clickupNextFetchAt, workers, organogram, janDesignConfig, buildings, activeBuildingId, projectMemberships, pendingWorkers, dismissPendingWorker, identityPrompt, dismissIdentityPrompt, autoMode, pendingDelegations } = useExtensionMessages(getOfficeState)

  const [isDebugMode, setIsDebugMode] = useState(false)
  const [foremanOpen, setForemanOpen] = useState(false)
  const [artDirectorOpen, setArtDirectorOpen] = useState(false)
  const [showDelegationModal, setShowDelegationModal] = useState(false)

  // Auto-open the confirmation popup when a new delegation arrives; auto-close
  // when the last one is resolved. Dismissing (X) leaves the list intact — the
  // "Awaiting delegation" header button reopens it.
  const prevDelegationCount = useRef(0)
  useEffect(() => {
    const count = pendingDelegations.length
    if (count > prevDelegationCount.current) setShowDelegationModal(true)
    if (count === 0) setShowDelegationModal(false)
    prevDelegationCount.current = count
  }, [pendingDelegations.length])

  const handleToggleDebugMode = useCallback(() => setIsDebugMode((prev) => !prev), [])

  const handleSelectAgent = useCallback((id: number) => {
    vscode.postMessage({ type: 'focusAgent', id })
  }, [])

  const handleClick = useCallback((agentId: number) => {
    // If clicked agent is a sub-agent, focus the parent's terminal instead
    const os = getOfficeState()
    const meta = os.subagentMeta.get(agentId)
    const focusId = meta ? meta.parentAgentId : agentId
    selectAgent(focusId)
    vscode.postMessage({ type: 'focusAgent', id: focusId })
  }, [selectAgent])

  const officeState = getOfficeState()

  if (!layoutReady) {
    return (
      <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--pixel-text)' }}>
        Loading...
      </div>
    )
  }

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--pixel-paper)', overflow: 'hidden' }}>
      <style>{`
        @keyframes pixel-agents-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
        .pixel-agents-pulse { animation: pixel-agents-pulse ${PULSE_ANIMATION_DURATION_SEC}s ease-in-out infinite; }
      `}</style>

      <TopBar
        buildings={buildings}
        activeBuildingId={activeBuildingId}
        projectMemberships={projectMemberships}
        clickupNextFetchAt={clickupNextFetchAt}
        workers={workers}
        autoMode={autoMode}
        pendingDelegationCount={pendingDelegations.length}
        onOpenDelegations={() => setShowDelegationModal(true)}
        isDebugMode={isDebugMode}
        onToggleDebugMode={handleToggleDebugMode}
      />

      {/* Body: fixed employees sidebar + scrollable polaroid grid */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <AgentSidebar
          docked
          officeState={officeState}
          agents={agents}
          selectedAgent={selectedAgent}
          onSelectAgent={selectAgent}
          agentTools={agentTools}
          agentStatuses={agentStatuses}
          offlineAgents={offlineAgents}
          knownProjects={knownProjects}
          onSaveAgentMeta={saveAgentMeta}
          onForgetAgent={forgetAgent}
          onOpenForeman={() => setForemanOpen(true)}
          onOpenArtDirector={() => setArtDirectorOpen(true)}
          organogram={organogram}
        />

        <main style={{ flex: 1, minWidth: 0, overflowY: 'auto', overflowX: 'hidden', position: 'relative' }}>
          <PolaroidGrid
            officeState={officeState}
            agents={agents}
            agentStatuses={agentStatuses}
            onSelect={handleClick}
          />
        </main>
      </div>

      {/* Foreman / Art Director slide-over panels (opened from the sidebar) */}
      <div
        style={{
          position: 'absolute',
          top: 60,
          left: 10,
          zIndex: 'var(--pixel-overlay-selected-z)' as unknown as number,
          display: 'flex',
          flexDirection: 'row',
          gap: 10,
          alignItems: 'flex-start',
          pointerEvents: 'none',
        }}
      >
        <ForemanPanel
          visible={foremanOpen}
          onClose={() => setForemanOpen(false)}
          clickupTickets={clickupTickets}
          clickupConfigured={clickupConfigured}
          clickupListId={clickupListId}
          offlineAgents={offlineAgents}
          officeState={officeState}
          agents={agents}
          agentTools={agentTools}
          agentStatuses={agentStatuses}
          knownProjects={knownProjects}
          workers={workers}
        />

        <ArtDirectorPanel
          visible={artDirectorOpen}
          onClose={() => setArtDirectorOpen(false)}
          clickupTickets={clickupTickets}
          clickupConfigured={clickupConfigured}
          clickupListId={clickupListId}
          offlineAgents={offlineAgents}
          officeState={officeState}
          agents={agents}
          agentTools={agentTools}
          agentStatuses={agentStatuses}
          knownProjects={knownProjects}
          workers={workers}
          janDesignConfig={janDesignConfig}
        />
      </div>

      <Credits />

      {pendingWorkers.length > 0 && (
        <IdentifyWorkerModal
          key={pendingWorkers[0].sessionId}
          worker={pendingWorkers[0]}
          onClose={() => dismissPendingWorker(pendingWorkers[0].sessionId)}
        />
      )}

      {identityPrompt && (
        <IdentityPromptModal
          key={identityPrompt.sessionId}
          prompt={identityPrompt}
          onClose={dismissIdentityPrompt}
        />
      )}

      {showDelegationModal && pendingDelegations.length > 0 && (
        <DelegationConfirmModal
          delegations={pendingDelegations}
          onClose={() => setShowDelegationModal(false)}
        />
      )}

      {isDebugMode && (
        <DebugView
          agents={agents}
          selectedAgent={selectedAgent}
          agentTools={agentTools}
          agentStatuses={agentStatuses}
          subagentTools={subagentTools}
          onSelectAgent={handleSelectAgent}
        />
      )}
    </div>
  )
}

export default App
