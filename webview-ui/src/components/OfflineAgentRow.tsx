import { useState } from 'react'
import type { OfflineAgent } from '../hooks/useExtensionMessages.js'
import { vscode } from '../vscodeApi.js'
import { timeAgo, deleteButtonStyle } from './agentSidebarUtils.js'
import type { ClickUpTicketRef } from './agentSidebarUtils.js'

interface OfflineAgentRowProps {
  agent: OfflineAgent
  onEdit?: (agent: OfflineAgent) => void
  onDelete?: (agent: OfflineAgent) => void
  onCallIn?: (agent: OfflineAgent) => void
  onRestart?: (agent: OfflineAgent) => void
  /** When set, "Call In" sends clickupStartWork with this ticket instead of the normal call-in flow */
  clickupTicket?: ClickUpTicketRef
  /** When true, the agent should use agent team mode */
  useTeam?: boolean
  /** Additional instructions to append to the ticket task */
  additionalPrompt?: string
}

export function OfflineAgentRow({ agent, onEdit, onDelete, onCallIn, onRestart, clickupTicket, useTeam, additionalPrompt }: OfflineAgentRowProps) {
  const [isHovered, setIsHovered] = useState(false)

  const handleCallIn = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (clickupTicket) {
      vscode.postMessage({
        type: 'clickupStartWork',
        agentId: agent.sessionId,
        ticketId: clickupTicket.id,
        ticketName: clickupTicket.name,
        ticketUrl: clickupTicket.url,
        useTeam: useTeam || undefined,
        additionalPrompt: additionalPrompt || undefined,
      })
      if (onCallIn) onCallIn(agent)
    } else if (agent.isPersistent && onCallIn) {
      onCallIn(agent)
    } else if (onRestart) {
      onRestart(agent)
    }
  }

  return (
    <div
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      style={{
        padding: '4px 6px',
        background: isHovered ? 'var(--pixel-btn-hover-bg)' : 'transparent',
        borderBottom: '1px solid var(--pixel-border)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 4,
      }}
    >
      <div style={{ overflow: 'hidden', flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: 'rgba(255,255,255,0.1)',
              flexShrink: 0,
            }}
          />
          <span
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            <span style={{ fontSize: '22px', color: 'var(--pixel-text-dim)' }}>
              {agent.name || agent.sessionId.slice(0, 8)}
            </span>
            {agent.roleShort && (
              <span style={{ fontSize: '18px', color: 'var(--pixel-accent)', marginLeft: 6, opacity: 0.7 }}>
                {agent.roleShort}
              </span>
            )}
          </span>
        </div>
        {agent.lastSessionEnd && (
          <div
            style={{
              fontSize: '16px',
              color: 'var(--pixel-text-dim)',
              paddingLeft: 10,
              marginTop: 1,
              opacity: 0.7,
            }}
          >
            Last active: {timeAgo(agent.lastSessionEnd)}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexShrink: 0 }}>
        {onEdit && (
          <button
            onClick={(e) => { e.stopPropagation(); onEdit(agent) }}
            title="Employee file"
            style={{
              ...deleteButtonStyle,
              color: isHovered ? 'var(--pixel-text-dim)' : 'transparent',
            }}
          >
            {'\u270E'}
          </button>
        )}
        {onDelete && (
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(agent) }}
            title="Fire employee"
            style={{
              ...deleteButtonStyle,
              color: isHovered ? 'var(--pixel-text-dim)' : 'transparent',
            }}
          >
            {'\u{1F5D1}'}
          </button>
        )}
        <button
          onClick={handleCallIn}
          style={{
            padding: '2px 8px',
            fontSize: '18px',
            color: 'var(--pixel-agent-text)',
            background: 'var(--pixel-agent-bg)',
            border: '2px solid var(--pixel-agent-border)',
            borderRadius: 0,
            cursor: 'pointer',
            flexShrink: 0,
          }}
          title={clickupTicket ? 'Assign this ticket to this agent' : agent.isPersistent ? 'Call this agent back to work' : 'Resume this session in iTerm'}
        >
          {agent.isPersistent ? 'Call In' : 'Resume'}
        </button>
      </div>
    </div>
  )
}
