import { useEffect } from 'react'
import type { OrganogramPayload, OrganogramNode } from '../hooks/useExtensionMessages.js'
import { vscode } from '../vscodeApi.js'

interface OrganogramProps {
  visible: boolean
  onClose: () => void
  organogram: OrganogramPayload | null
  onSelectAgent?: (persistentAgentId: string) => void
}

export function Organogram({ visible, onClose, organogram, onSelectAgent }: OrganogramProps) {
  // Refresh on open
  useEffect(() => {
    if (visible) {
      vscode.postMessage({ type: 'getOrganogram' })
    }
  }, [visible])

  if (!visible) return null

  const agentsById = new Map<string, OrganogramNode>()
  if (organogram) {
    for (const a of organogram.agents) agentsById.set(a.id, a)
  }

  const renderNode = (node: OrganogramNode | undefined, label?: string) => {
    if (!node) return null
    const handleClick = () => {
      if (onSelectAgent) onSelectAgent(node.id)
    }
    return (
      <div
        onClick={handleClick}
        style={{
          background: node.isOnline ? 'var(--pixel-accent)' : 'var(--pixel-bg)',
          color: node.isOnline ? '#0a0a14' : 'var(--pixel-text)',
          border: '2px solid var(--pixel-border)',
          borderRadius: 0,
          padding: '6px 10px',
          minWidth: 140,
          textAlign: 'center',
          boxShadow: '2px 2px 0px #0a0a14',
          cursor: onSelectAgent ? 'pointer' : 'default',
          fontSize: 14,
          userSelect: 'none',
        }}
        title={node.roleFull}
      >
        <div style={{ fontWeight: 'bold' }}>{node.name}</div>
        <div style={{ fontSize: 11, opacity: 0.8 }}>{label ?? node.roleShort}</div>
        {node.currentTicketName && (
          <div style={{ fontSize: 10, marginTop: 4, opacity: 0.9 }}>
            {node.currentTicketName.slice(0, 24)}
            {node.currentTicketName.length > 24 ? '...' : ''}
          </div>
        )}
      </div>
    )
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        top: 0, left: 0, right: 0, bottom: 0,
        background: 'rgba(0,0,0,0.7)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--pixel-bg)',
          border: '2px solid var(--pixel-border)',
          borderRadius: 0,
          padding: 24,
          maxWidth: '90vw',
          maxHeight: '90vh',
          overflow: 'auto',
          boxShadow: '4px 4px 0px #0a0a14',
          color: 'var(--pixel-text)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h2 style={{ margin: 0, fontSize: 20 }}>Organogram</h2>
          <button
            onClick={onClose}
            style={{
              background: 'var(--pixel-bg)',
              color: 'var(--pixel-text)',
              border: '2px solid var(--pixel-border)',
              borderRadius: 0,
              padding: '4px 12px',
              cursor: 'pointer',
              fontSize: 14,
            }}
          >
            Close
          </button>
        </div>

        {!organogram || !organogram.root ? (
          <div style={{ padding: 20, textAlign: 'center' }}>Loading organogram...</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 24 }}>
            {/* Jan (root) */}
            {renderNode(organogram.root, 'Art Director')}

            {/* Connector line */}
            <div style={{ width: 2, height: 16, background: 'var(--pixel-border)' }} />

            {/* Teams row */}
            <div style={{ display: 'flex', gap: 60, alignItems: 'flex-start', flexWrap: 'wrap', justifyContent: 'center' }}>
              {organogram.teams.map((team) => {
                const pm = team.pmId ? agentsById.get(team.pmId) : undefined
                const qa = team.qaId ? agentsById.get(team.qaId) : undefined
                const workers = team.workerIds.map((id) => agentsById.get(id)).filter(Boolean) as OrganogramNode[]

                return (
                  <div key={team.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
                    {/* Team label */}
                    <div
                      style={{
                        fontSize: 13,
                        fontWeight: 'bold',
                        padding: '4px 12px',
                        border: '2px dashed var(--pixel-border)',
                        textAlign: 'center',
                      }}
                    >
                      {team.name}
                    </div>

                    {/* PM */}
                    {renderNode(pm, 'PM')}

                    <div style={{ width: 2, height: 12, background: 'var(--pixel-border)' }} />

                    {/* QA + workers row */}
                    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap', justifyContent: 'center', maxWidth: 720 }}>
                      {qa && (
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                          {renderNode(qa, 'QA Reviewer')}
                        </div>
                      )}
                      {workers.map((w) => (
                        <div key={w.id}>{renderNode(w)}</div>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
