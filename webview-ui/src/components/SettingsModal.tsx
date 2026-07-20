import { useState } from 'react'
import { vscode, isStandalone } from '../vscodeApi.js'
import { isSoundEnabled, setSoundEnabled } from '../notificationSound.js'
import { ClickUpConfigForm } from './ClickUpConfig.js'

interface SettingsModalProps {
  isOpen: boolean
  onClose: () => void
  isDebugMode: boolean
  onToggleDebugMode: () => void
  clickupConfigured: boolean
  clickupListIds: string[]
}

const menuItemBase: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  width: '100%',
  padding: '6px 10px',
  fontSize: '26px',
  color: 'var(--pixel-text)',
  background: 'transparent',
  border: 'none',
  borderRadius: 0,
  cursor: 'pointer',
  textAlign: 'left',
}

export function SettingsModal({ isOpen, onClose, isDebugMode, onToggleDebugMode, clickupConfigured, clickupListIds }: SettingsModalProps) {
  const [hovered, setHovered] = useState<string | null>(null)
  const [soundLocal, setSoundLocal] = useState(isSoundEnabled)
  const [clickupOpen, setClickupOpen] = useState(false)

  if (!isOpen) return null

  return (
    <>
      {/* Dark backdrop — click to close */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          background: 'rgba(0, 0, 0, 0.5)',
          zIndex: 49,
        }}
      />
      {/* Centered modal */}
      <div
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          zIndex: 50,
          background: 'var(--pixel-bg)',
          border: '2px solid var(--pixel-border)',
          borderRadius: 0,
          padding: '4px',
          boxShadow: 'var(--pixel-shadow)',
          minWidth: clickupOpen ? 280 : 200,
        }}
      >
        {/* Header with title and X button */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '4px 10px',
            borderBottom: '1px solid var(--pixel-border)',
            marginBottom: '4px',
          }}
        >
          <span style={{ fontSize: '26px', color: 'var(--pixel-text)' }}>Settings</span>
          <button
            onClick={onClose}
            onMouseEnter={() => setHovered('close')}
            onMouseLeave={() => setHovered(null)}
            style={{
              background: hovered === 'close' ? 'var(--pixel-btn-hover-bg)' : 'transparent',
              border: 'none',
              borderRadius: 0,
              color: 'var(--pixel-text-dim)',
              fontSize: '26px',
              cursor: 'pointer',
              padding: '0 4px',
              lineHeight: 1,
            }}
          >
            X
          </button>
        </div>
        {/* Menu items */}
        {!isStandalone && (
        <button
          onClick={() => {
            vscode.postMessage({ type: 'openSessionsFolder' })
            onClose()
          }}
          onMouseEnter={() => setHovered('sessions')}
          onMouseLeave={() => setHovered(null)}
          style={{
            ...menuItemBase,
            background: hovered === 'sessions' ? 'var(--pixel-btn-hover-bg)' : 'transparent',
          }}
        >
          Open Sessions Folder
        </button>
        )}
        <button
          onClick={() => {
            const newVal = !isSoundEnabled()
            setSoundEnabled(newVal)
            setSoundLocal(newVal)
            vscode.postMessage({ type: 'setSoundEnabled', enabled: newVal })
          }}
          onMouseEnter={() => setHovered('sound')}
          onMouseLeave={() => setHovered(null)}
          style={{
            ...menuItemBase,
            background: hovered === 'sound' ? 'var(--pixel-btn-hover-bg)' : 'transparent',
          }}
        >
          <span>Sound Notifications</span>
          <span
            style={{
              width: 14,
              height: 14,
              border: '2px solid var(--pixel-border)',
              borderRadius: 0,
              background: soundLocal ? 'var(--pixel-accent)' : 'transparent',
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '14px',
              lineHeight: 1,
              color: '#fff',
            }}
          >
            {soundLocal ? 'X' : ''}
          </span>
        </button>
        <button
          onClick={onToggleDebugMode}
          onMouseEnter={() => setHovered('debug')}
          onMouseLeave={() => setHovered(null)}
          style={{
            ...menuItemBase,
            background: hovered === 'debug' ? 'var(--pixel-btn-hover-bg)' : 'transparent',
          }}
        >
          <span>Debug View</span>
          {isDebugMode && (
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: 'rgba(90, 140, 255, 0.8)',
                flexShrink: 0,
              }}
            />
          )}
        </button>
        <button
          onClick={() => setClickupOpen((v) => !v)}
          onMouseEnter={() => setHovered('clickup')}
          onMouseLeave={() => setHovered(null)}
          style={{
            ...menuItemBase,
            background: hovered === 'clickup' ? 'var(--pixel-btn-hover-bg)' : 'transparent',
          }}
        >
          <span>ClickUp Connection</span>
          <span style={{ fontSize: '18px', color: 'var(--pixel-text-dim)', flexShrink: 0 }}>
            {clickupConfigured ? (clickupOpen ? '–' : 'Edit') : 'Set up'}
          </span>
        </button>
        {clickupOpen && (
          <div style={{ padding: '0 10px' }}>
            <ClickUpConfigForm
              isUpdate={clickupConfigured}
              initialListIds={clickupListIds}
              onDone={() => setClickupOpen(false)}
            />
          </div>
        )}
      </div>
    </>
  )
}
