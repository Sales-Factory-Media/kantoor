import { useState, useEffect, useRef } from 'react'
import type { WorkspaceFolder, WorkerStatusEntry } from '../hooks/useExtensionMessages.js'
import { vscode, isStandalone } from '../vscodeApi.js'

interface BottomToolbarProps {
  onOpenClaude: () => void
  workspaceFolders: WorkspaceFolder[]
  clickupNextFetchAt: number | null
  workers: WorkerStatusEntry[]
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

const btnBase: React.CSSProperties = {
  padding: '5px 12px',
  fontSize: '26px',
  color: 'var(--pixel-text)',
  background: 'var(--pixel-btn-bg)',
  border: '2px solid transparent',
  borderRadius: 0,
  cursor: 'pointer',
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return '0:00'
  const totalSec = Math.ceil(ms / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return `${min}:${sec.toString().padStart(2, '0')}`
}

export function BottomToolbar({
  onOpenClaude,
  workspaceFolders,
  clickupNextFetchAt,
  workers,
}: BottomToolbarProps) {
  const [hovered, setHovered] = useState<string | null>(null)
  const [isFolderPickerOpen, setIsFolderPickerOpen] = useState(false)
  const [hoveredFolder, setHoveredFolder] = useState<number | null>(null)
  const folderPickerRef = useRef<HTMLDivElement>(null)
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

  const handleFetchNow = () => {
    setFetchStartedFrom(clickupNextFetchAt ?? 0)
    vscode.postMessage({ type: 'clickupRefresh' })
  }

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

  // Close folder picker on outside click
  useEffect(() => {
    if (!isFolderPickerOpen) return
    const handleClick = (e: MouseEvent) => {
      if (folderPickerRef.current && !folderPickerRef.current.contains(e.target as Node)) {
        setIsFolderPickerOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [isFolderPickerOpen])

  const hasMultipleFolders = workspaceFolders.length > 1

  const handleAgentClick = () => {
    if (hasMultipleFolders) {
      setIsFolderPickerOpen((v) => !v)
    } else {
      onOpenClaude()
    }
  }

  const handleFolderSelect = (folder: WorkspaceFolder) => {
    setIsFolderPickerOpen(false)
    vscode.postMessage({ type: 'openClaude', folderPath: folder.path })
  }

  if (isStandalone) {
    return (
      <div
        style={{
          position: 'absolute',
          bottom: 6,
          left: 8,
          right: 8,
          zIndex: 'var(--pixel-controls-z)',
          fontSize: '20px',
          color: 'var(--pixel-text-dim)',
          userSelect: 'none',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          gap: '4px',
        }}
      >
        {workers.length > 0 && (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 6,
              width: '100%',
            }}
          >
            {workers.map((w) => (
              <WorkerChip key={`${w.hostname}:${w.name}`} worker={w} />
            ))}
          </div>
        )}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}
        >
        <span style={{ pointerEvents: 'none' }}>
          Watching... {countdown != null ? `(next fetch in ${countdown})` : 'Countdown not running'}
        </span>
        {countdown != null && (
          isFetching ? (
            <span
              className="pixel-spinner"
              style={{
                fontSize: '16px',
                padding: '2px 8px',
                color: 'var(--pixel-text-dim)',
              }}
              title="Fetching..."
            >
              {'↻'}
            </span>
          ) : (
            <button
              onClick={handleFetchNow}
              onMouseEnter={() => setHovered('fetchNow')}
              onMouseLeave={() => setHovered(null)}
              title="Fetch now"
              style={{
                ...btnBase,
                fontSize: '16px',
                padding: '2px 8px',
                border: hovered === 'fetchNow' ? '2px solid var(--pixel-accent)' : '2px solid transparent',
              }}
            >
              Fetch now
            </button>
          )
        )}
        <span style={{ fontSize: '8px', opacity: 0.4, marginLeft: 8 }}>
          Furniture by pablodelucca (MIT) | Vehicles by MinZinn (CC-BY 4.0) | Cats by bluecarrot16 (CC-BY 3.0) | Forest by Seliel the Shaper
        </span>
        </div>
      </div>
    )
  }

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 10,
        left: 10,
        zIndex: 'var(--pixel-controls-z)',
      }}
    >
      <div ref={folderPickerRef} style={{ position: 'relative' }}>
        <button
          onClick={handleAgentClick}
          onMouseEnter={() => setHovered('agent')}
          onMouseLeave={() => setHovered(null)}
          style={{
            ...btnBase,
            background:
              hovered === 'agent' || isFolderPickerOpen
                ? 'var(--pixel-agent-hover-bg)'
                : 'var(--pixel-agent-bg)',
            border: '2px solid var(--pixel-agent-border)',
            color: 'var(--pixel-agent-text)',
            boxShadow: 'var(--pixel-shadow)',
          }}
        >
          + Agent
        </button>
        {isFolderPickerOpen && (
          <div
            style={{
              position: 'absolute',
              bottom: '100%',
              left: 0,
              marginBottom: 4,
              background: 'var(--pixel-bg)',
              border: '2px solid var(--pixel-border)',
              borderRadius: 0,
              boxShadow: 'var(--pixel-shadow)',
              minWidth: 160,
              zIndex: 'var(--pixel-controls-z)',
            }}
          >
            {workspaceFolders.map((folder, i) => (
              <button
                key={folder.path}
                onClick={() => handleFolderSelect(folder)}
                onMouseEnter={() => setHoveredFolder(i)}
                onMouseLeave={() => setHoveredFolder(null)}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '6px 10px',
                  fontSize: '24px',
                  color: 'var(--pixel-text)',
                  background: hoveredFolder === i ? 'var(--pixel-btn-hover-bg)' : 'transparent',
                  border: 'none',
                  borderRadius: 0,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                {folder.name}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
