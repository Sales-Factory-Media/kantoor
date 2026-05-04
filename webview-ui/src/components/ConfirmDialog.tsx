import { useEffect } from 'react'

interface ConfirmDialogProps {
  message: string
  confirmLabel?: string
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({ message, confirmLabel = 'Fire', onConfirm, onCancel }: ConfirmDialogProps) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        onConfirm()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onConfirm, onCancel])

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
      onClick={onCancel}
    >
      <div
        style={{
          background: 'var(--pixel-bg)',
          border: '2px solid var(--pixel-border)',
          borderRadius: 0,
          boxShadow: 'var(--pixel-shadow)',
          padding: '12px',
          minWidth: 240,
          maxWidth: 320,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <span style={{ fontSize: '20px', color: 'var(--pixel-text)' }}>
          {message}
        </span>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            onClick={onCancel}
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
            onClick={onConfirm}
            style={{
              padding: '4px 12px',
              fontSize: '18px',
              color: '#fff',
              background: '#c53030',
              border: '2px solid #9b2c2c',
              borderRadius: 0,
              cursor: 'pointer',
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
