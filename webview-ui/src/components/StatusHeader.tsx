import { useState, useEffect } from 'react'
import type { WorkerStatusEntry } from '../hooks/useExtensionMessages.js'
import { vscode } from '../vscodeApi.js'

interface StatusHeaderProps {
  clickupNextFetchAt: number | null
  workers: WorkerStatusEntry[]
  autoMode: boolean
  pendingDelegationCount: number
  onOpenDelegations: () => void
}

function WorkerChip({ worker }: { worker: WorkerStatusEntry }) {
  const disconnected = worker.status === 'disconnected'
  return (
    <div
      title={
        worker.status === 'busy' && worker.ticketName
          ? `${worker.name} — ${worker.ticketName}`
          : `${worker.name} (${worker.status})`
      }
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 8px',
        fontSize: '14px',
        color: disconnected ? 'var(--pixel-text-dim)' : 'var(--pixel-text)',
        background: 'var(--pixel-btn-bg)',
        border: '2px solid var(--pixel-border)',
        borderRadius: 0,
        opacity: disconnected ? 0.6 : 1,
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          backgroundColor: disconnected ? '#666' : worker.color,
          flexShrink: 0,
        }}
      />
      <span>{worker.name}</span>
      {worker.isHub && (
        <span style={{ fontSize: '12px', color: 'var(--pixel-text-dim)' }}>(hub)</span>
      )}
      {worker.status === 'busy' && worker.ticketId && (
        <span style={{ fontSize: '12px', color: worker.color }}>CU-{worker.ticketId}</span>
      )}
    </div>
  )
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return '0:00'
  const totalSec = Math.ceil(ms / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return `${min}:${sec.toString().padStart(2, '0')}`
}

/**
 * Top-center status strip: the remote-worker chips plus the ClickUp watch
 * countdown and a "Fetch now" button. Lives in the header so the bottom edge
 * is free for the polaroid worker dock.
 */
export function StatusHeader({ clickupNextFetchAt, workers, autoMode, pendingDelegationCount, onOpenDelegations }: StatusHeaderProps) {
  const [hovered, setHovered] = useState(false)
  const [countdown, setCountdown] = useState<string | null>(null)
  const [fetchStartedFrom, setFetchStartedFrom] = useState<number | null>(null)
  const isFetching = fetchStartedFrom !== null

  // Clear spinner when the server broadcasts a new clickupNextFetchAt (fetch completed).
  useEffect(() => {
    if (fetchStartedFrom == null) return
    if (clickupNextFetchAt != null && clickupNextFetchAt !== fetchStartedFrom) {
      setFetchStartedFrom(null)
    }
  }, [clickupNextFetchAt, fetchStartedFrom])

  // Safety cap so a stuck fetch doesn't pin the spinner forever.
  useEffect(() => {
    if (fetchStartedFrom == null) return
    const id = setTimeout(() => setFetchStartedFrom(null), 30000)
    return () => clearTimeout(id)
  }, [fetchStartedFrom])

  useEffect(() => {
    if (clickupNextFetchAt == null) {
      setCountdown(null)
      return
    }
    const tick = () => {
      const remaining = clickupNextFetchAt - Date.now()
      setCountdown(remaining > 0 ? formatCountdown(remaining) : null)
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [clickupNextFetchAt])

  const handleFetchNow = () => {
    setFetchStartedFrom(clickupNextFetchAt ?? 0)
    vscode.postMessage({ type: 'clickupRefresh' })
  }

  const handleToggleAutoMode = () => {
    vscode.postMessage({ type: 'setAutoMode', enabled: !autoMode })
  }

  return (
    <div
      style={{
        position: 'absolute',
        top: 10,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 'var(--pixel-controls-z)' as unknown as number,
        display: 'flex',
        flexWrap: 'wrap',
        justifyContent: 'center',
        alignItems: 'center',
        gap: 6,
        maxWidth: 'calc(100% - 360px)',
        fontSize: '20px',
        color: 'var(--pixel-text-dim)',
        userSelect: 'none',
        pointerEvents: 'auto',
      }}
    >
      {workers.map((w) => (
        <WorkerChip key={`${w.hostname}:${w.name}`} worker={w} />
      ))}

      <label
        onClick={handleToggleAutoMode}
        title="Auto Mode: when on, To Do tickets assigned to you are handed to Darryl to pick a worker — you confirm before work starts."
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '2px 8px',
          fontSize: '16px',
          color: autoMode ? 'var(--pixel-text)' : 'var(--pixel-text-dim)',
          background: 'var(--pixel-btn-bg)',
          border: autoMode ? '2px solid var(--pixel-accent)' : '2px solid var(--pixel-border)',
          borderRadius: 0,
          cursor: 'pointer',
        }}
      >
        <span
          style={{
            width: 14,
            height: 14,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '12px',
            color: 'var(--pixel-bg)',
            background: autoMode ? 'var(--pixel-accent)' : 'transparent',
            border: '2px solid var(--pixel-border)',
            borderRadius: 0,
          }}
        >
          {autoMode ? '✓' : ''}
        </span>
        <span>Auto</span>
      </label>

      {pendingDelegationCount > 0 && (
        <button
          onClick={onOpenDelegations}
          title="Tickets Darryl has classified, awaiting your confirmation"
          style={{
            fontSize: '16px',
            padding: '2px 8px',
            color: 'var(--pixel-agent-text)',
            background: 'var(--pixel-agent-bg)',
            border: '2px solid var(--pixel-agent-border)',
            borderRadius: 0,
            cursor: 'pointer',
          }}
        >
          Awaiting delegation ({pendingDelegationCount})
        </button>
      )}

      <span style={{ pointerEvents: 'none' }}>
        Watching... {countdown != null ? `(next fetch in ${countdown})` : 'Countdown not running'}
      </span>

      {countdown != null && (
        isFetching ? (
          <span
            className="pixel-spinner"
            style={{ fontSize: '16px', padding: '2px 8px', color: 'var(--pixel-text-dim)' }}
            title="Fetching..."
          >
            {'↻'}
          </span>
        ) : (
          <button
            onClick={handleFetchNow}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            title="Fetch now"
            style={{
              fontSize: '16px',
              padding: '2px 8px',
              color: 'var(--pixel-text)',
              background: 'var(--pixel-btn-bg)',
              border: hovered ? '2px solid var(--pixel-accent)' : '2px solid transparent',
              borderRadius: 0,
              cursor: 'pointer',
            }}
          >
            Fetch now
          </button>
        )
      )}
    </div>
  )
}
