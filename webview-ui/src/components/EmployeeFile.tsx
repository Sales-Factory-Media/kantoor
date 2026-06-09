import { useState } from 'react'
import type { OfficeState } from '../office/engine/officeState.js'
import type { OfflineAgent } from '../hooks/useExtensionMessages.js'
import { parseAvatarConfig, randomAvatarConfig, type AvatarConfig } from '../avatar.js'
import { EmployeeAvatar } from './EmployeeAvatar.js'
import { vscode } from '../vscodeApi.js'

interface EmployeeFileProps {
  officeState: OfficeState
  /** Live character ID to edit, or null for creating a new agent */
  agentId: number | null
  /** Offline persistent agent to edit, or undefined */
  offlineAgent?: OfflineAgent
  /** Pre-filled workspace path for new workers in a specific room */
  defaultWorkspacePath?: string
  onClose: () => void
  onSave: () => void
  /** If true, immediately launch the agent after saving */
  launchAfterSave?: boolean
}

export function EmployeeFile({ officeState, agentId, offlineAgent, defaultWorkspacePath, onClose, onSave, launchAfterSave }: EmployeeFileProps) {
  const ch = agentId !== null ? officeState.characters.get(agentId) : null

  const [name, setName] = useState(ch?.name || offlineAgent?.name || '')
  const [roleShort, setRoleShort] = useState(ch?.roleShort || offlineAgent?.roleShort || '')
  const [roleFull, setRoleFull] = useState(ch?.roleFull || offlineAgent?.roleFull || '')
  const [workspacePath, setWorkspacePath] = useState(ch?.workspacePath || offlineAgent?.workspacePath || defaultWorkspacePath || '')

  const persistentId = ch?.persistentAgentId || (offlineAgent?.isPersistent ? offlineAgent.sessionId : undefined)

  const [avatar, setAvatar] = useState<AvatarConfig>(
    () => parseAvatarConfig(ch?.avatarConfig ?? offlineAgent?.avatarConfig)
      ?? { seed: persistentId || ch?.sessionId || name || 'employee' },
  )

  const handleSave = () => {
    const avatarConfig = JSON.stringify(avatar)
    // Update live character if editing one
    if (ch) {
      ch.name = name
      ch.roleShort = roleShort
      ch.roleFull = roleFull
      ch.workspacePath = workspacePath || undefined
      ch.avatarConfig = avatarConfig
    }

    // Save as persistent agent identity
    vscode.postMessage({
      type: 'saveAgentIdentity',
      agent: {
        id: persistentId || undefined,
        name,
        roleShort,
        roleFull,
        workspacePath: workspacePath || '',
        palette: ch?.palette,
        hueShift: ch?.hueShift,
        seatId: ch?.seatId,
        currentSessionId: ch?.sessionId,
        avatarConfig,
      },
      launch: launchAfterSave || false,
    })

    onSave()
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
        zIndex: 10000,
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
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: '24px', color: 'var(--pixel-text)', fontWeight: 'bold' }}>
            Employee File
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
            {'\u2715'}
          </button>
        </div>

        {/* Face builder */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <EmployeeAvatar id={persistentId} name={name} avatarConfig={avatar} size={72} />
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
            placeholder="Agent name"
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
          <div style={labelStyle}>Role (full)</div>
          <textarea
            style={{
              ...inputStyle,
              minHeight: 60,
              resize: 'vertical',
            }}
            value={roleFull}
            onChange={(e) => setRoleFull(e.target.value)}
            placeholder="Full role description..."
          />
        </div>

        {/* Workspace path */}
        <div>
          <div style={labelStyle}>Working Directory</div>
          <input
            style={inputStyle}
            value={workspacePath}
            onChange={(e) => setWorkspacePath(e.target.value)}
            placeholder="/path/to/project"
          />
        </div>

        {/* Save button */}
        <button
          onClick={handleSave}
          style={{
            padding: '6px 12px',
            fontSize: '20px',
            color: 'var(--pixel-agent-text)',
            background: 'var(--pixel-agent-bg)',
            border: '2px solid var(--pixel-agent-border)',
            borderRadius: 0,
            cursor: 'pointer',
            alignSelf: 'flex-end',
          }}
        >
          {launchAfterSave ? 'Save & Hire' : 'Save'}
        </button>
      </div>
    </div>
  )
}
