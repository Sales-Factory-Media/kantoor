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
  const { agents, selectedAgent, selectAgent, agentTools, agentStatuses, subagentTools, layoutReady, offlineAgents, knownProjects, saveAgentMeta, forgetAgent, clickupTickets, clickupConfigured, clickupListIds, clickupNextFetchAt, workers, organogram, janDesignConfig, buildings, activeBuildingId, projectMemberships, pendingWorkers, dismissPendingWorker, identityPrompt, dismissIdentityPrompt, autoMode, pendingDelegations, dispatchError, dismissDispatchError } = useExtensionMessages(getOfficeState)

  const [isDebugMode, setIsDebugMode] = useState(false)
  const [foremanOpen, setForemanOpen] = useState(false)
  const [artDirectorOpen, setArtDirectorOpen] = useState(false)
  const [showDelegationModal, setShowDelegationModal] = useState(false)

  // Tick periodically so snoozed (postponed) delegations reappear when their
  // snooze window elapses, even without a fresh server broadcast.
  const [nowTick, setNowTick] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 30000)
    return () => clearInterval(t)
  }, [])

  // Delegations currently snoozed via Postpone. These stay in the pending list
  // (header button + modal) — Postpone only suppresses the AUTO-popup, it does
  // NOT drop the delegation. They "un-snooze" once the window elapses (nowTick)
  // or the ticket is updated (server re-broadcast).
  const activeDelegations = pendingDelegations.filter(
    (d) => !d.postponedUntil || d.postponedUntil <= nowTick,
  )

  // Auto-open the confirmation popup when a new NON-snoozed delegation arrives;
  // auto-close only when nothing is left to act on right now. Postponed ones
  // still count toward the header button (see pendingDelegations.length below),
  // so the button remains while any delegation is pending.
  const prevDelegationCount = useRef(0)
  useEffect(() => {
    const count = activeDelegations.length
    if (count > prevDelegationCount.current) setShowDelegationModal(true)
    if (count === 0) setShowDelegationModal(false)
    prevDelegationCount.current = count
  }, [activeDelegations.length])

  // Auto-dismiss a dispatch-failure banner after a while so it doesn't linger.
  useEffect(() => {
    if (!dispatchError) return
    const t = setTimeout(dismissDispatchError, 10000)
    return () => clearTimeout(t)
  }, [dispatchError, dismissDispatchError])

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

      {/* CRT barrel-distortion filter — referenced by EmployeeAvatar via
          filter: url(#crt-barrel) to bulge the face/pixels like a curved tube.
          The displacement map is an inline SVG: red encodes horizontal push
          (0→left … 1→right), green vertical, so pixels spread outward from the
          centre = a magnifying screen bulge. */}
      <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden>
        <filter id="crt-barrel" x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
          <feImage
            preserveAspectRatio="none"
            x="0"
            y="0"
            width="100%"
            height="100%"
            result="map"
            href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='100'%3E%3Cdefs%3E%3ClinearGradient id='rx' x1='0' y1='0' x2='1' y2='0'%3E%3Cstop offset='0' stop-color='%23000'/%3E%3Cstop offset='1' stop-color='%23f00'/%3E%3C/linearGradient%3E%3ClinearGradient id='gy' x1='0' y1='0' x2='0' y2='1'%3E%3Cstop offset='0' stop-color='%23000'/%3E%3Cstop offset='1' stop-color='%230f0'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='100' height='100' fill='url(%23rx)'/%3E%3Crect width='100' height='100' fill='url(%23gy)' style='mix-blend-mode:screen'/%3E%3C/svg%3E"
          />
          <feDisplacementMap in="SourceGraphic" in2="map" scale="10" xChannelSelector="R" yChannelSelector="G" />
        </filter>

        {/* Constant TV snow — fractal-noise static whose seed regenerates every
            frame (SMIL animate) so it churns like an untuned old TV. Referenced
            by EmployeeAvatar's snow overlay via filter: url(#crt-snow). */}
        <filter id="crt-snow" x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch" seed="1" result="noise">
            <animate
              attributeName="seed"
              values="1;5;2;8;3;9;4;7;6;10"
              dur="0.5s"
              calcMode="discrete"
              repeatCount="indefinite"
            />
          </feTurbulence>
          <feColorMatrix in="noise" type="saturate" values="0" result="gray" />
          <feComponentTransfer in="gray">
            <feFuncA type="linear" slope="1.6" intercept="-0.25" />
          </feComponentTransfer>
        </filter>
      </svg>

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
        clickupConfigured={clickupConfigured}
        clickupListIds={clickupListIds}
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
            knownProjects={knownProjects}
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

      {/* Dispatch-failure banner — a confirmed delegation / "start work" launch
          failed on the hub. Without this the failure was silent. */}
      {dispatchError && (
        <div
          style={{
            position: 'fixed',
            top: 70,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 10003,
            maxWidth: 560,
            display: 'flex',
            alignItems: 'flex-start',
            gap: 10,
            padding: '10px 12px',
            background: 'var(--pixel-bg)',
            border: '2px solid var(--pixel-danger, #e5484d)',
            borderRadius: 0,
            boxShadow: 'var(--pixel-shadow)',
            color: 'var(--pixel-text)',
            fontSize: '16px',
            lineHeight: 1.35,
          }}
          role="alert"
        >
          <span style={{ color: 'var(--pixel-danger, #e5484d)', fontWeight: 'bold', flexShrink: 0 }}>
            Launch failed
          </span>
          <span style={{ flex: 1, minWidth: 0 }}>{dispatchError}</span>
          <button
            onClick={dismissDispatchError}
            title="Dismiss"
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--pixel-text-dim)',
              fontSize: '18px',
              cursor: 'pointer',
              padding: '0 2px',
              flexShrink: 0,
            }}
          >
            {'✕'}
          </button>
        </div>
      )}

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
