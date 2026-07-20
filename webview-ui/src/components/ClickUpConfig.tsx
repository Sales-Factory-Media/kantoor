import { useState } from 'react'
import { vscode } from '../vscodeApi.js'

/**
 * ClickUp connector config form: an API token plus one or more List IDs to
 * poll. Sends `clickupConfigure` (with `listIds`) for the active building.
 * Lives in the general Settings modal — the connector is per-building
 * workspace config, not a Darryl's-Office concern.
 */
export function ClickUpConfigForm({
  isUpdate,
  initialListIds,
  onDone,
}: {
  isUpdate?: boolean
  initialListIds?: string[]
  onDone?: () => void
}) {
  const [apiToken, setApiToken] = useState('')
  // Always keep at least one (possibly empty) row so there's a field to type in.
  const [listIds, setListIds] = useState<string[]>(
    initialListIds && initialListIds.length > 0 ? initialListIds : [''],
  )

  const cleanedIds = [...new Set(listIds.map((id) => id.trim()).filter(Boolean))]
  const canSave = cleanedIds.length > 0 && (!!apiToken || !!isUpdate)

  const updateListId = (index: number, value: string) => {
    setListIds((prev) => prev.map((id, i) => (i === index ? value : id)))
  }
  const addListRow = () => setListIds((prev) => [...prev, ''])
  const removeListRow = (index: number) => {
    setListIds((prev) => {
      const next = prev.filter((_, i) => i !== index)
      return next.length > 0 ? next : ['']
    })
  }

  const handleSave = () => {
    if (!canSave) return
    vscode.postMessage({ type: 'clickupConfigure', apiToken: apiToken || undefined, listIds: cleanedIds })
    onDone?.()
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

  const smallBtn: React.CSSProperties = {
    padding: '4px 8px',
    fontSize: '20px',
    lineHeight: 1,
    color: 'var(--pixel-text)',
    background: 'var(--pixel-bg)',
    border: '2px solid var(--pixel-border)',
    borderRadius: 0,
    cursor: 'pointer',
    flexShrink: 0,
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '8px 0' }}>
      <div>
        <div style={{ fontSize: '18px', color: 'var(--pixel-text-dim)', marginBottom: 2 }}>
          API Token
        </div>
        <input
          style={inputStyle}
          value={apiToken}
          onChange={(e) => setApiToken(e.target.value)}
          placeholder={isUpdate ? 'Leave blank to keep current' : 'pk_...'}
          type="password"
        />
      </div>
      <div>
        <div style={{ fontSize: '18px', color: 'var(--pixel-text-dim)', marginBottom: 2 }}>
          List IDs
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {listIds.map((id, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                style={inputStyle}
                value={id}
                onChange={(e) => updateListId(i, e.target.value)}
                placeholder="901521570151"
              />
              <button
                onClick={() => removeListRow(i)}
                title="Remove list"
                style={smallBtn}
              >
                {'✕'}
              </button>
            </div>
          ))}
        </div>
        <button
          onClick={addListRow}
          style={{ ...smallBtn, marginTop: 6, width: '100%' }}
        >
          + Add list
        </button>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button
          onClick={handleSave}
          disabled={!canSave}
          style={{
            padding: '6px 12px',
            fontSize: '20px',
            color: 'var(--pixel-agent-text)',
            background: !canSave ? 'var(--pixel-text-dim)' : 'var(--pixel-agent-bg)',
            border: '2px solid var(--pixel-agent-border)',
            borderRadius: 0,
            cursor: !canSave ? 'default' : 'pointer',
          }}
        >
          Save
        </button>
      </div>
    </div>
  )
}
