import { useState } from 'react'
import type { PendingWorker } from '../hooks/useExtensionMessages.js'
import { randomAvatarConfig, type AvatarConfig } from '../avatar.js'
import { EmployeeAvatar } from './EmployeeAvatar.js'
import { vscode } from '../vscodeApi.js'

interface IdentifyWorkerModalProps {
  worker: PendingWorker
  /** Dismiss without resolving — keeps the provisional agent as-is */
  onClose: () => void
}

export function IdentifyWorkerModal({ worker, onClose }: IdentifyWorkerModalProps) {
  // Jump straight to the new-hire form when there's nobody to return as.
  const [view, setView] = useState<'choose' | 'new'>(worker.candidates.length > 0 ? 'choose' : 'new')
  const [name, setName] = useState(worker.provisionalName || '')
  const [roleShort, setRoleShort] = useState('')
  const [roleFull, setRoleFull] = useState('')
  // Initial custom-random face is seeded by the provisional id (stable + unique);
  // the 🎲 button re-rolls to a fresh random combo.
  const [avatar, setAvatar] = useState<AvatarConfig>({ seed: worker.provisionalAgentId })

  const projectLabel = worker.projectName
    || (worker.workspacePath ? worker.workspacePath.split('/').filter(Boolean).pop() : undefined)

  const chooseExisting = (existingAgentId: string) => {
    vscode.postMessage({
      type: 'identifyWorker',
      sessionId: worker.sessionId,
      provisionalAgentId: worker.provisionalAgentId,
      choice: 'existing',
      existingAgentId,
      reassign: worker.reassign === true,
    })
    onClose()
  }

  const saveNew = () => {
    vscode.postMessage({
      type: 'identifyWorker',
      sessionId: worker.sessionId,
      provisionalAgentId: worker.provisionalAgentId,
      choice: 'new',
      name: name.trim() || worker.provisionalName,
      roleShort: roleShort.trim(),
      roleFull: roleFull.trim(),
      avatarConfig: JSON.stringify(avatar),
      reassign: worker.reassign === true,
    })
    onClose()
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

  const labelStyle: React.CSSProperties = {
    fontSize: '18px',
    color: 'var(--pixel-text-dim)',
    marginBottom: 2,
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
          minWidth: 300,
          maxWidth: 380,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: '24px', color: 'var(--pixel-text)', fontWeight: 'bold' }}>
            {worker.reassign ? 'Reassign task' : "Who's this?"}
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
          {worker.reassign ? 'Move this task to someone else.' : 'A new worker just started.'}
        </div>

        {/* Always state which project we're assigning for — it's the key cue for
            picking the right person (the same name can exist in many projects). */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, fontSize: '16px' }}>
          <span style={{ color: 'var(--pixel-text-dim)' }}>Project:</span>
          <span style={{ color: 'var(--pixel-text)', fontWeight: 'bold' }}>
            {projectLabel || 'Unknown'}
          </span>
        </div>

        {view === 'choose' ? (
          <>
            <div style={labelStyle}>Returning employee?</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 280, overflowY: 'auto' }}>
              {worker.candidates.map((c) => (
                <button
                  key={c.id}
                  onClick={() => chooseExisting(c.id)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    textAlign: 'left',
                    padding: '6px 8px',
                    fontSize: '18px',
                    color: 'var(--pixel-text)',
                    background: 'var(--pixel-bg)',
                    border: '2px solid var(--pixel-border)',
                    borderRadius: 0,
                    cursor: 'pointer',
                  }}
                >
                  <EmployeeAvatar id={c.id} name={c.name} avatarConfig={c.avatarConfig} size={36} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 'bold' }}>{c.name}</div>
                    {c.roleShort && (
                      <div style={{ fontSize: '15px', color: 'var(--pixel-text-dim)' }}>{c.roleShort}</div>
                    )}
                  </div>
                  {c.activeTaskCount ? (
                    <span
                      title={`Already working on ${c.activeTaskCount} task${c.activeTaskCount > 1 ? 's' : ''}`}
                      style={{
                        fontSize: '13px',
                        fontWeight: 'bold',
                        color: 'var(--pixel-bg)',
                        background: '#5cc46a',
                        border: '2px solid #0a0a14',
                        borderRadius: 0,
                        padding: '1px 6px',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {`● ${c.activeTaskCount} active`}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
            <button
              onClick={() => setView('new')}
              style={{
                padding: '6px 12px',
                fontSize: '20px',
                color: 'var(--pixel-agent-text)',
                background: 'var(--pixel-agent-bg)',
                border: '2px solid var(--pixel-agent-border)',
                borderRadius: 0,
                cursor: 'pointer',
              }}
            >
              + New employee
            </button>
          </>
        ) : (
          <>
            {/* Face builder */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <EmployeeAvatar id={worker.provisionalAgentId} name={name} avatarConfig={avatar} size={72} />
              <button
                onClick={() => setAvatar(randomAvatarConfig())}
                style={{
                  padding: '6px 12px',
                  fontSize: '18px',
                  color: 'var(--pixel-text)',
                  background: 'var(--pixel-bg)',
                  border: '2px solid var(--pixel-border)',
                  borderRadius: 0,
                  cursor: 'pointer',
                }}
              >
                {'🎲'} Randomize
              </button>
            </div>

            {/* Name */}
            <div>
              <div style={labelStyle}>Name</div>
              <input
                style={inputStyle}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Employee name"
                autoFocus
              />
            </div>

            {/* Short role */}
            <div>
              <div style={labelStyle}>Role (short)</div>
              <input
                style={inputStyle}
                value={roleShort}
                onChange={(e) => setRoleShort(e.target.value)}
                placeholder="e.g. Frontend Dev"
              />
            </div>

            {/* Full role description */}
            <div>
              <div style={labelStyle}>Role description</div>
              <textarea
                style={{ ...inputStyle, minHeight: 60, resize: 'vertical' }}
                value={roleFull}
                onChange={(e) => setRoleFull(e.target.value)}
                placeholder="What does this employee do?"
              />
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              {worker.candidates.length > 0 ? (
                <button
                  onClick={() => setView('choose')}
                  style={{
                    padding: '6px 12px',
                    fontSize: '18px',
                    color: 'var(--pixel-text)',
                    background: 'var(--pixel-bg)',
                    border: '2px solid var(--pixel-border)',
                    borderRadius: 0,
                    cursor: 'pointer',
                  }}
                >
                  {'‹'} Back
                </button>
              ) : <span />}
              <button
                onClick={saveNew}
                style={{
                  padding: '6px 12px',
                  fontSize: '20px',
                  color: 'var(--pixel-agent-text)',
                  background: 'var(--pixel-agent-bg)',
                  border: '2px solid var(--pixel-agent-border)',
                  borderRadius: 0,
                  cursor: 'pointer',
                }}
              >
                Hire
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
