import { useState } from 'react'
import type { WorkerStatusEntry, BuildingSummary } from '../hooks/useExtensionMessages.js'
import { BuildingSwitcher, type ProjectMembershipEntry } from './BuildingSwitcher.js'
import { StatusHeader } from './StatusHeader.js'
import { SettingsModal } from './SettingsModal.js'

interface TopBarProps {
  buildings: BuildingSummary[]
  activeBuildingId: string | null
  projectMemberships: ProjectMembershipEntry[]
  clickupNextFetchAt: number | null
  workers: WorkerStatusEntry[]
  autoMode: boolean
  pendingDelegationCount: number
  onOpenDelegations: () => void
  isDebugMode: boolean
  onToggleDebugMode: () => void
}

/**
 * The flat-layout top bar. Left: building switcher (which company workspace).
 * Right: the live "office status" — remote worker hubs, Auto mode, the ClickUp
 * fetch countdown, pending delegations — plus a settings gear. Cream/paper
 * styling to match the polaroid cards below.
 */
export function TopBar({
  buildings,
  activeBuildingId,
  projectMemberships,
  clickupNextFetchAt,
  workers,
  autoMode,
  pendingDelegationCount,
  onOpenDelegations,
  isDebugMode,
  onToggleDebugMode,
}: TopBarProps) {
  const [settingsOpen, setSettingsOpen] = useState(false)

  return (
    <header
      style={{
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '8px 12px',
        background: 'var(--pixel-bg)',
        borderBottom: '2px solid var(--pixel-border)',
        position: 'relative',
        zIndex: 60,
      }}
    >
      <BuildingSwitcher
        inline
        buildings={buildings}
        activeBuildingId={activeBuildingId}
        projects={projectMemberships}
      />

      {/* Push the status cluster to the right edge */}
      <div style={{ flex: 1, minWidth: 12 }} />

      <StatusHeader
        inline
        clickupNextFetchAt={clickupNextFetchAt}
        workers={workers}
        autoMode={autoMode}
        pendingDelegationCount={pendingDelegationCount}
        onOpenDelegations={onOpenDelegations}
      />

      <div style={{ position: 'relative', flexShrink: 0 }}>
        <button
          onClick={() => setSettingsOpen((v) => !v)}
          title="Settings"
          style={{
            width: 36,
            height: 36,
            padding: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--pixel-btn-bg)',
            color: 'var(--pixel-text)',
            border: '2px solid var(--pixel-border)',
            borderRadius: 0,
            cursor: 'pointer',
          }}
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <circle cx="9" cy="9" r="3" stroke="currentColor" strokeWidth="1.5" />
            <path
              d="M9 1.5v2M9 14.5v2M1.5 9h2M14.5 9h2M3.1 3.1l1.4 1.4M13.5 13.5l1.4 1.4M3.1 14.9l1.4-1.4M13.5 4.5l1.4-1.4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
        <SettingsModal
          isOpen={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          isDebugMode={isDebugMode}
          onToggleDebugMode={onToggleDebugMode}
        />
      </div>
    </header>
  )
}
