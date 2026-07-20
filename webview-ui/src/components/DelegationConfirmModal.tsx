import { useState } from 'react'
import type { PendingDelegation } from '../hooks/useExtensionMessages.js'
import { EmployeeAvatar } from './EmployeeAvatar.js'
import { vscode } from '../vscodeApi.js'

interface DelegationConfirmModalProps {
  delegations: PendingDelegation[]
  /** Hide the modal — the pending list is kept; reopen from the header button. */
  onClose: () => void
}

/**
 * Auto Mode confirmation popup. Darryl classified one or more To Do tickets and
 * picked a worker for each; the human reviews his pick and clicks Start to
 * dispatch (on the current branch), Discard to drop it, or opens the ticket in
 * ClickUp. Multiple pending decisions render as tabs.
 */
export function DelegationConfirmModal({ delegations, onClose }: DelegationConfirmModalProps) {
  const [activeIndex, setActiveIndex] = useState(0)

  if (delegations.length === 0) return null
  const idx = Math.min(activeIndex, delegations.length - 1)
  const active = delegations[idx]

  const start = () => {
    vscode.postMessage({ type: 'confirmDelegation', ticketId: active.ticketId })
  }
  const discard = () => {
    vscode.postMessage({ type: 'discardDelegation', ticketId: active.ticketId })
  }
  const openInClickUp = () => {
    if (active.ticketUrl) window.open(active.ticketUrl, '_blank', 'noopener')
  }

  const btnStyle: React.CSSProperties = {
    padding: '6px 12px',
    fontSize: '18px',
    borderRadius: 0,
    cursor: 'pointer',
  }

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
          minWidth: 360,
          maxWidth: 460,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: '24px', color: 'var(--pixel-text)', fontWeight: 'bold' }}>
            Darryl's pick
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
            {'✕'}
          </button>
        </div>

        <div style={{ fontSize: '16px', color: 'var(--pixel-text-dim)' }}>
          Darryl picked the best worker for this ticket. Confirm to start work on the current branch.
        </div>

        {/* Tabs — one per pending decision */}
        {delegations.length > 1 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {delegations.map((d, i) => (
              <button
                key={d.ticketId}
                onClick={() => setActiveIndex(i)}
                title={d.ticketName}
                style={{
                  padding: '3px 8px',
                  fontSize: '14px',
                  maxWidth: 140,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  color: i === idx ? 'var(--pixel-text)' : 'var(--pixel-text-dim)',
                  background: 'var(--pixel-btn-bg)',
                  border: i === idx ? '2px solid var(--pixel-accent)' : '2px solid var(--pixel-border)',
                  borderRadius: 0,
                  cursor: 'pointer',
                }}
              >
                {d.ticketName || d.ticketId}
              </button>
            ))}
          </div>
        )}

        {/* Ticket */}
        <div>
          <div style={{ fontSize: '20px', color: 'var(--pixel-text)', fontWeight: 'bold' }}>
            {active.ticketName || active.ticketId}
          </div>
          <button
            onClick={openInClickUp}
            style={{
              marginTop: 4,
              padding: '2px 6px',
              fontSize: '14px',
              color: 'var(--pixel-text)',
              background: 'var(--pixel-btn-bg)',
              border: '2px solid var(--pixel-border)',
              borderRadius: 0,
              cursor: 'pointer',
            }}
          >
            {'↗'} Open in ClickUp
          </button>
        </div>

        {/* Recommended worker */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '8px',
            background: 'var(--pixel-btn-bg)',
            border: '2px solid var(--pixel-border)',
          }}
        >
          <EmployeeAvatar id={active.recommendedAgentId} name={active.recommendedAgentName} size={48} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '20px', color: 'var(--pixel-text)', fontWeight: 'bold' }}>
              {active.recommendedAgentName}
            </div>
            {active.recommendedAgentRole && (
              <div style={{ fontSize: '15px', color: 'var(--pixel-text-dim)' }}>{active.recommendedAgentRole}</div>
            )}
          </div>
        </div>

        {/* Reasoning */}
        {active.reasoning && (
          <div style={{ fontSize: '16px', color: 'var(--pixel-text)' }}>
            <span style={{ color: 'var(--pixel-text-dim)' }}>Why: </span>
            {active.reasoning}
          </div>
        )}

        {/* Brief */}
        {active.brief && (
          <details>
            <summary style={{ fontSize: '15px', color: 'var(--pixel-text-dim)', cursor: 'pointer' }}>
              Brief
            </summary>
            <div
              style={{
                marginTop: 4,
                maxHeight: 160,
                overflowY: 'auto',
                fontSize: '14px',
                color: 'var(--pixel-text)',
                whiteSpace: 'pre-wrap',
              }}
            >
              {active.brief}
            </div>
          </details>
        )}

        {/* Actions */}
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
          <button
            onClick={discard}
            title="Drop this pick — the ticket is re-classified on the next poll"
            style={{
              ...btnStyle,
              color: 'var(--pixel-text)',
              background: 'var(--pixel-bg)',
              border: '2px solid var(--pixel-border)',
            }}
          >
            Discard
          </button>
          <button
            onClick={start}
            style={{
              ...btnStyle,
              fontSize: '20px',
              color: 'var(--pixel-agent-text)',
              background: 'var(--pixel-agent-bg)',
              border: '2px solid var(--pixel-agent-border)',
            }}
          >
            Start
          </button>
        </div>
      </div>
    </div>
  )
}
