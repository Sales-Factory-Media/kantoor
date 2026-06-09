import { useState } from 'react'
import type { IdentityPrompt } from '../hooks/useExtensionMessages.js'

interface IdentityPromptModalProps {
  prompt: IdentityPrompt
  onClose: () => void
}

// Cream physical-object palette, matching the ID card / polaroids.
const CARD_BG = '#f4efe2'
const INK = '#1e1e2e'
const INK_DIM = 'rgba(30,30,46,0.55)'
const EDGE = '#0a0a14'
const SOFT = 'rgba(30,30,46,0.22)'

/**
 * Shown right after a session is (re)assigned to an employee. We can't type into
 * the user's iTerm tab for them, so this surfaces a short prompt to copy-paste
 * into that session so the running Claude knows who it now is (and writes to the
 * right MemPalace identity).
 */
export function IdentityPromptModal({ prompt, onClose }: IdentityPromptModalProps) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt.prompt)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard can fail in some webview contexts — the textarea below is
      // selectable as a manual fallback.
    }
  }

  const buttonStyle: React.CSSProperties = {
    padding: '6px 16px',
    fontSize: '16px',
    color: CARD_BG,
    background: INK,
    border: `2px solid ${EDGE}`,
    borderRadius: 0,
    cursor: 'pointer',
  }

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
          position: 'relative',
          width: 460,
          maxWidth: '92vw',
          background: CARD_BG,
          border: `2px solid ${EDGE}`,
          borderRadius: 0,
          boxShadow: `2px 2px 0px ${EDGE}`,
          padding: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          boxSizing: 'border-box',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          title="Close"
          style={{ position: 'absolute', top: 6, right: 8, background: 'none', border: 'none', color: INK_DIM, fontSize: '20px', cursor: 'pointer', padding: '0 2px', lineHeight: 1 }}
        >
          {'✕'}
        </button>

        <div style={{ fontSize: '20px', color: INK, fontWeight: 'bold' }}>
          Tell the session who they are
        </div>
        <div style={{ fontSize: '14px', color: INK_DIM, lineHeight: 1.35 }}>
          Paste this into {prompt.name}&apos;s iTerm tab so the running session knows
          it&apos;s {prompt.name}{prompt.roleShort ? ` (${prompt.roleShort})` : ''}.
        </div>

        <textarea
          readOnly
          value={prompt.prompt}
          onFocus={(e) => e.currentTarget.select()}
          rows={5}
          style={{
            resize: 'vertical',
            fontFamily: 'inherit',
            fontSize: '14px',
            color: INK,
            background: '#fff',
            border: `1px solid ${SOFT}`,
            borderRadius: 0,
            padding: '8px',
          }}
        />

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose} style={{ ...buttonStyle, background: 'transparent', color: INK_DIM, border: `2px solid ${SOFT}` }}>
            Done
          </button>
          <button onClick={copy} style={buttonStyle}>
            {copied ? 'Copied ✓' : 'Copy'}
          </button>
        </div>
      </div>
    </div>
  )
}
