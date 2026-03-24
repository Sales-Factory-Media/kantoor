import { useState, useCallback, useRef } from 'react'
import { OfficeState } from './office/engine/officeState.js'
import { OfficeCanvas } from './office/components/OfficeCanvas.js'
import { ToolOverlay } from './office/components/ToolOverlay.js'
import { vscode } from './vscodeApi.js'
import { useExtensionMessages } from './hooks/useExtensionMessages.js'
import { PULSE_ANIMATION_DURATION_SEC, ZOOM_DEFAULT_DPR_FACTOR } from './constants.js'
import { ZoomControls } from './components/ZoomControls.js'
import { BottomToolbar } from './components/BottomToolbar.js'
import { DebugView } from './components/DebugView.js'
import { AgentSidebar } from './components/AgentSidebar.js'
import { ConversationPanel } from './components/ConversationPanel.js'
import { ForemanPanel } from './components/ForemanPanel.js'

// Game state lives outside React — updated imperatively by message handlers
const officeStateRef = { current: null as OfficeState | null }

function getOfficeState(): OfficeState {
  if (!officeStateRef.current) {
    officeStateRef.current = new OfficeState()
  }
  return officeStateRef.current
}

function defaultZoom(): number {
  return Math.round(ZOOM_DEFAULT_DPR_FACTOR * (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1))
}

function App() {
  const { agents, selectedAgent, selectAgent, agentTools, agentStatuses, subagentTools, subagentCharacters, layoutReady, workspaceFolders, agentConversation, offlineAgents, knownProjects, saveAgentMeta, forgetAgent, clickupTickets, clickupConfigured, clickupListId } = useExtensionMessages(getOfficeState)

  const [isDebugMode, setIsDebugMode] = useState(false)
  const [zoom, setZoom] = useState(defaultZoom)
  const panRef = useRef({ x: 0, y: 0 })
  const [foremanOpen, setForemanOpen] = useState(false)

  const handleToggleDebugMode = useCallback(() => setIsDebugMode((prev) => !prev), [])

  const handleSelectAgent = useCallback((id: number) => {
    vscode.postMessage({ type: 'focusAgent', id })
  }, [])

  const handleCloseAgent = useCallback((id: number) => {
    vscode.postMessage({ type: 'closeAgent', id })
  }, [])

  const handleClick = useCallback((agentId: number) => {
    // If clicked agent is a sub-agent, focus the parent's terminal instead
    const os = getOfficeState()
    const meta = os.subagentMeta.get(agentId)
    const focusId = meta ? meta.parentAgentId : agentId
    selectAgent(focusId)
    vscode.postMessage({ type: 'focusAgent', id: focusId })
  }, [selectAgent])

  const handleOpenClaude = useCallback(() => {
    vscode.postMessage({ type: 'openClaude' })
  }, [])

  const containerRef = useRef<HTMLDivElement>(null)
  const officeState = getOfficeState()

  if (!layoutReady) {
    return (
      <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--vscode-foreground)' }}>
        Loading...
      </div>
    )
  }

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}>
      <style>{`
        @keyframes pixel-agents-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
        .pixel-agents-pulse { animation: pixel-agents-pulse ${PULSE_ANIMATION_DURATION_SEC}s ease-in-out infinite; }
      `}</style>

      <OfficeCanvas
        officeState={officeState}
        onClick={handleClick}
        zoom={zoom}
        onZoomChange={setZoom}
        panRef={panRef}
      />

      <ZoomControls zoom={zoom} onZoomChange={setZoom} isDebugMode={isDebugMode} onToggleDebugMode={handleToggleDebugMode} />

      {/* Vignette overlay */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: 'var(--pixel-vignette)',
          pointerEvents: 'none',
          zIndex: 40,
        }}
      />

      <ConversationPanel
        officeState={officeState}
        selectedAgent={selectedAgent}
        agentConversation={agentConversation}
      />

      <ForemanPanel
        visible={foremanOpen}
        onClose={() => setForemanOpen(false)}
        clickupTickets={clickupTickets}
        clickupConfigured={clickupConfigured}
        clickupListId={clickupListId}
        offlineAgents={offlineAgents}
      />

      <BottomToolbar
        onOpenClaude={handleOpenClaude}
        workspaceFolders={workspaceFolders}
      />

      <ToolOverlay
        officeState={officeState}
        agents={agents}
        agentTools={agentTools}
        subagentCharacters={subagentCharacters}
        containerRef={containerRef}
        zoom={zoom}
        panRef={panRef}
        onCloseAgent={handleCloseAgent}
      />

      <AgentSidebar
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
      />

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
