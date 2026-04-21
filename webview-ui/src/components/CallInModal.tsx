import { useState } from 'react'
import type { OfflineAgent } from '../hooks/useExtensionMessages.js'
import { vscode } from '../vscodeApi.js'

interface CallInModalProps {
  agent: OfflineAgent
  onClose: () => void
}

export function CallInModal({ agent, onClose }: CallInModalProps) {
  const [task, setTask] = useState('')
  const [useTeam, setUseTeam] = useState(false)

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 10001,
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
          maxWidth: 360,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <span style={{ fontSize: '24px', color: 'var(--pixel-text)', fontWeight: 'bold' }}>
          Call In {agent.name || agent.sessionId.slice(0, 8)}
        </span>
        <div>
          <div style={{ fontSize: '18px', color: 'var(--pixel-text-dim)', marginBottom: 2 }}>
            What should they work on? (optional)
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
            value={task}
            onChange={(e) => setTask(e.target.value)}
            placeholder="e.g. Fix the login bug..."
            autoFocus
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
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            onClick={onClose}
            style={{
              padding: '4px 12px',
              fontSize: '18px',
              color: 'var(--pixel-text)',
              background: 'var(--pixel-bg)',
              border: '2px solid var(--pixel-border)',
              borderRadius: 0,
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            onClick={() => {
              vscode.postMessage({
                type: 'launchAgent',
                agentId: agent.sessionId,
                callInTask: task.trim() || undefined,
                useTeam: useTeam || undefined,
              })
              onClose()
            }}
            style={{
              padding: '4px 12px',
              fontSize: '18px',
              color: 'var(--pixel-agent-text)',
              background: 'var(--pixel-agent-bg)',
              border: '2px solid var(--pixel-agent-border)',
              borderRadius: 0,
              cursor: 'pointer',
            }}
          >
            Call In
          </button>
        </div>
      </div>
    </div>
  )
}
