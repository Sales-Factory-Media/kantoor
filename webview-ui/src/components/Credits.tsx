import { useState, useRef, useEffect } from 'react'

const CREDITS = [
  'Furniture by pablodelucca (MIT)',
  'Vehicles by MinZinn (CC-BY 4.0)',
  'Cats by bluecarrot16 (CC-BY 3.0)',
  'Forest by Seliel the Shaper',
]

/**
 * Asset-attribution credits, tucked behind an (i) icon at the bottom-right.
 * Clicking the icon toggles a small popup listing the credits.
 */
export function Credits() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onClick)
    return () => window.removeEventListener('mousedown', onClick)
  }, [open])

  return (
    <div
      ref={ref}
      style={{
        position: 'absolute',
        bottom: 8,
        right: 10,
        zIndex: 'var(--pixel-controls-z)' as unknown as number,
        pointerEvents: 'auto',
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Asset credits"
        style={{
          width: 22,
          height: 22,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '14px',
          fontStyle: 'italic',
          fontWeight: 'bold',
          color: 'var(--pixel-text-dim)',
          background: 'var(--pixel-btn-bg)',
          border: '2px solid var(--pixel-border)',
          borderRadius: 0,
          cursor: 'pointer',
          opacity: open ? 1 : 0.6,
        }}
      >
        i
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            bottom: '100%',
            right: 0,
            marginBottom: 4,
            background: 'var(--pixel-bg)',
            border: '2px solid var(--pixel-border)',
            borderRadius: 0,
            boxShadow: 'var(--pixel-shadow)',
            padding: '8px 10px',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            fontSize: '12px',
            lineHeight: 1.3,
            color: 'var(--pixel-text-dim)',
            whiteSpace: 'nowrap',
          }}
        >
          <div style={{ fontWeight: 'bold', color: 'var(--pixel-text)', marginBottom: 2 }}>
            Asset credits
          </div>
          {CREDITS.map((c) => (
            <span key={c}>{c}</span>
          ))}
        </div>
      )}
    </div>
  )
}
