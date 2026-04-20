import { useState } from 'react'
import type { OfficeState } from '../office/engine/officeState.js'
import type { OfflineAgent } from '../hooks/useExtensionMessages.js'
import { vscode } from '../vscodeApi.js'

interface ConferenceModalProps {
  officeState: OfficeState
  agents: number[]
  offlineAgents: OfflineAgent[]
  onClose: () => void
}

export function ConferenceModal({ officeState, agents, offlineAgents, onClose }: ConferenceModalProps) {
  const [agent1, setAgent1] = useState<string | null>(null)
  const [agent2, setAgent2] = useState<string | null>(null)
  const [topic, setTopic] = useState('')

  const persistentOffline = offlineAgents.filter((a) => a.isPersistent)
  const liveAgentIds = new Set(agents)
  const conferenceEligible = persistentOffline.filter((a) => {
    for (const id of liveAgentIds) {
      const ch = officeState.characters.get(id)
      if (ch && ch.persistentAgentId === a.sessionId) return false
    }
    return true
  })

  // Group eligible agents by project
  const agentsByProject = new Map<string, typeof conferenceEligible>()
  for (const a of conferenceEligible) {
    const project = a.projectName || 'No project'
    const group = agentsByProject.get(project) || []
    group.push(a)
    agentsByProject.set(project, group)
  }

  const canStart = agent1 && agent2 && agent1 !== agent2 && topic.trim().length > 0

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
        <span style={{ fontSize: '24px', color: 'var(--pixel-text)', fontWeight: 'bold' }}>
          Start Conference
        </span>

        {/* Agent 1 selector */}
        <div>
          <div style={{ fontSize: '18px', color: 'var(--pixel-text-dim)', marginBottom: 2 }}>
            Agent 1
          </div>
          <select
            value={agent1 || ''}
            onChange={(e) => setAgent1(e.target.value || null)}
            style={{
              width: '100%',
              padding: '4px 6px',
              fontSize: '20px',
              color: 'var(--pixel-text)',
              background: 'var(--pixel-bg)',
              border: '2px solid var(--pixel-border)',
              borderRadius: 0,
              outline: 'none',
              boxSizing: 'border-box',
            }}
          >
            <option value="">Select agent...</option>
            {[...agentsByProject.entries()].map(([project, groupAgents]) => (
              <optgroup key={project} label={project}>
                {groupAgents.map((a) => (
                  <option key={a.sessionId} value={a.sessionId} disabled={a.sessionId === agent2}>
                    {a.name || a.sessionId.slice(0, 8)}{a.roleShort ? ` \u2014 ${a.roleShort}` : ''}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>

        {/* Agent 2 selector */}
        <div>
          <div style={{ fontSize: '18px', color: 'var(--pixel-text-dim)', marginBottom: 2 }}>
            Agent 2
          </div>
          <select
            value={agent2 || ''}
            onChange={(e) => setAgent2(e.target.value || null)}
            style={{
              width: '100%',
              padding: '4px 6px',
              fontSize: '20px',
              color: 'var(--pixel-text)',
              background: 'var(--pixel-bg)',
              border: '2px solid var(--pixel-border)',
              borderRadius: 0,
              outline: 'none',
              boxSizing: 'border-box',
            }}
          >
            <option value="">Select agent...</option>
            {[...agentsByProject.entries()].map(([project, groupAgents]) => (
              <optgroup key={project} label={project}>
                {groupAgents.map((a) => (
                  <option key={a.sessionId} value={a.sessionId} disabled={a.sessionId === agent1}>
                    {a.name || a.sessionId.slice(0, 8)}{a.roleShort ? ` \u2014 ${a.roleShort}` : ''}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>

        {/* Topic */}
        <div>
          <div style={{ fontSize: '18px', color: 'var(--pixel-text-dim)', marginBottom: 2 }}>
            Discussion Topic
          </div>
          <textarea
            style={{
              width: '100%',
              padding: '8px 10px',
              fontSize: '14px',
              color: 'var(--pixel-text)',
              background: 'var(--pixel-bg)',
              border: '2px solid var(--pixel-border)',
              borderRadius: 0,
              outline: 'none',
              boxSizing: 'border-box',
              minHeight: 100,
              resize: 'vertical',
            }}
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="What should they discuss?"
            autoFocus
          />
        </div>

        {/* Buttons */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            onClick={onClose}
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
            disabled={!canStart}
            onClick={() => {
              if (!canStart) return
              vscode.postMessage({
                type: 'startConference',
                agent1Id: agent1,
                agent2Id: agent2,
                topic: topic.trim(),
              })
              onClose()
            }}
            style={{
              padding: '4px 12px',
              fontSize: '18px',
              color: canStart ? 'var(--pixel-agent-text)' : 'var(--pixel-text-dim)',
              background: canStart ? 'var(--pixel-agent-bg)' : 'var(--pixel-bg)',
              border: `2px solid ${canStart ? 'var(--pixel-agent-border)' : 'var(--pixel-border)'}`,
              borderRadius: 0,
              cursor: canStart ? 'pointer' : 'not-allowed',
              opacity: canStart ? 1 : 0.5,
            }}
          >
            Start
          </button>
        </div>
      </div>
    </div>
  )
}
