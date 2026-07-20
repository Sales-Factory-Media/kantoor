import type { ToolActivity } from '../office/types.js'
import type { OfficeState } from '../office/engine/officeState.js'
import { vscode } from '../vscodeApi.js'
import { getActivity, getDotInfo } from './agentSidebarUtils.js'

interface WorkingEmployeesProps {
  officeState: OfficeState
  agents: number[]
  selectedAgent: number | null
  agentTools: Record<number, ToolActivity[]>
  agentStatuses: Record<number, string>
  onSelectAgent: (id: number | null) => void
}

export function WorkingEmployees({
  officeState,
  agents,
  selectedAgent,
  agentTools,
  agentStatuses,
  onSelectAgent,
}: WorkingEmployeesProps) {
  if (agents.length === 0) return null

  return (
    <div
      style={{
        position: 'absolute',
        top: 10,
        right: 314,
        zIndex: 'var(--pixel-controls-z)',
        display: 'flex',
        flexDirection: 'column',
        gap: 0,
        background: 'var(--pixel-bg)',
        border: '2px solid var(--pixel-border)',
        borderRadius: 0,
        boxShadow: 'var(--pixel-shadow)',
        minWidth: 160,
        maxWidth: 220,
        maxHeight: 'calc(100% - 20px)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '4px 6px',
          borderBottom: '2px solid var(--pixel-border)',
        }}
      >
        <span style={{ fontSize: '22px', color: 'var(--pixel-text)', userSelect: 'none' }}>
          Working ({agents.length})
        </span>
      </div>
      <div style={{ overflowY: 'auto', overflowX: 'hidden' }}>
        {agents.map((id) => {
          const ch = officeState.characters.get(id)
          if (!ch) return null
          const activity = getActivity(id, agentTools, ch.isActive)
          const dot = getDotInfo(id, agentTools, agentStatuses, ch.isActive)
          const status = agentStatuses[id]
          const isWaiting = status === 'waiting'
          const isSelected = selectedAgent === id

          return (
            <div
              key={id}
              onClick={() => {
                officeState.selectedAgentId = id
                officeState.cameraFollowId = id
                onSelectAgent(id)
                vscode.postMessage({ type: 'focusAgent', id })
              }}
              style={{
                padding: '3px 6px',
                cursor: 'pointer',
                background: isSelected ? 'var(--pixel-active-bg)' : 'transparent',
                borderBottom: '1px solid var(--pixel-border)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span
                  className={dot?.waiting ? 'pixel-agents-waiting-glow' : dot?.pulse ? 'pixel-agents-pulse' : undefined}
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: dot ? dot.color : 'rgba(255,255,255,0.2)',
                    flexShrink: 0,
                  }}
                />
                <span
                  style={{
                    fontSize: '20px',
                    color: isSelected ? '#fff' : 'var(--pixel-text)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {ch.name || `Agent #${id}`}
                </span>
              </div>
              <div
                style={{
                  fontSize: '16px',
                  color: 'var(--pixel-text-dim)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  paddingLeft: 10,
                }}
              >
                {isWaiting ? 'Waiting for input' : activity || (ch.isActive ? 'Thinking...' : 'Idle')}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
