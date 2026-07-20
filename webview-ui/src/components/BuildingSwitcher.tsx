import { useState, useRef, useEffect } from 'react'
import { vscode } from '../vscodeApi.js'
import type { BuildingSummary } from '../hooks/useExtensionMessages.js'

export interface ProjectMembershipEntry {
  id: number
  name: string
  workspacePath: string
  description?: string
  belongsToActive: boolean
}

interface Props {
  buildings: BuildingSummary[]
  activeBuildingId: string | null
  projects: ProjectMembershipEntry[]
  /** Render in-flow (for the header bar) instead of absolutely at top-left. */
  inline?: boolean
}

/**
 * Top-left dropdown that lists every building (company workspace) and lets
 * the user switch the active one. Clicking a building sends a `switchBuilding`
 * WS message; the server hot-swaps caches and broadcasts a fresh state for
 * all webviews. Also offers a "+ New building" entry that opens the
 * create-building modal.
 */
export function BuildingSwitcher({ buildings, activeBuildingId, projects, inline }: Props) {
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [managingProjects, setManagingProjects] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onClick)
    return () => window.removeEventListener('mousedown', onClick)
  }, [open])

  const active = buildings.find(b => b.id === activeBuildingId) ?? buildings[0]
  if (!active) return null

  function selectBuilding(slug: string) {
    if (slug === active?.slug) {
      setOpen(false)
      return
    }
    vscode.postMessage({ type: 'switchBuilding', slug })
    setOpen(false)
  }

  function openProjectsModal() {
    vscode.postMessage({ type: 'listProjects' })
    setManagingProjects(true)
    setOpen(false)
  }

  return (
    <div
      ref={ref}
      style={{
        position: inline ? 'relative' : 'absolute',
        top: inline ? undefined : 10,
        left: inline ? undefined : 10,
        zIndex: 'var(--pixel-controls-z)' as unknown as number,
        pointerEvents: 'auto',
        display: 'flex',
        gap: 4,
      }}
    >
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{
          background: 'var(--pixel-btn-bg)',
          border: '2px solid var(--pixel-border)',
          borderRadius: 0,
          color: 'var(--pixel-fg)',
          fontFamily: 'inherit',
          fontSize: 12,
          padding: '6px 10px',
          cursor: 'pointer',
          boxShadow: '2px 2px 0px #0a0a14',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          minWidth: 140,
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: 0,
            background: active.configured ? 'var(--pixel-accent)' : 'var(--pixel-status-permission)',
            display: 'inline-block',
          }}
          title={active.configured ? `${active.connectorType} configured` : `${active.connectorType} not configured`}
        />
        <span style={{ flex: 1, textAlign: 'left' }}>{active.name}</span>
        <span style={{ fontSize: 10, opacity: 0.7 }}>{open ? '▲' : '▼'}</span>
      </button>

      <button
        type="button"
        onClick={openProjectsModal}
        title={`Manage projects in ${active.name}`}
        style={{
          background: 'var(--pixel-btn-bg)',
          border: '2px solid var(--pixel-border)',
          borderRadius: 0,
          color: 'var(--pixel-fg)',
          fontFamily: 'inherit',
          fontSize: 14,
          padding: '6px 8px',
          cursor: 'pointer',
          boxShadow: '2px 2px 0px #0a0a14',
          lineHeight: 1,
        }}
      >⚙</button>

      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            zIndex: 'var(--pixel-controls-z)' as unknown as number,
            background: 'var(--pixel-bg)',
            border: '2px solid var(--pixel-border)',
            borderRadius: 0,
            boxShadow: '2px 2px 0px #0a0a14',
            minWidth: 180,
          }}
        >
          {buildings.map(b => (
            <button
              key={b.id}
              type="button"
              onClick={() => selectBuilding(b.slug)}
              style={{
                background: b.id === activeBuildingId ? 'var(--pixel-accent)' : 'transparent',
                border: 'none',
                borderRadius: 0,
                color: 'var(--pixel-fg)',
                fontFamily: 'inherit',
                fontSize: 12,
                padding: '6px 10px',
                cursor: 'pointer',
                width: '100%',
                textAlign: 'left',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
              onMouseEnter={e => { if (b.id !== activeBuildingId) (e.currentTarget.style.background = 'var(--pixel-btn-bg)') }}
              onMouseLeave={e => { if (b.id !== activeBuildingId) (e.currentTarget.style.background = 'transparent') }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  background: b.configured ? 'var(--pixel-accent)' : 'var(--pixel-status-permission)',
                  display: 'inline-block',
                }}
              />
              <span style={{ flex: 1 }}>{b.name}</span>
              <span style={{ fontSize: 10, opacity: 0.6 }}>{b.connectorType}</span>
            </button>
          ))}

          <div style={{ borderTop: '2px solid var(--pixel-border)' }}>
            <button
              type="button"
              onClick={() => { setCreating(true); setOpen(false) }}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--pixel-fg)',
                fontFamily: 'inherit',
                fontSize: 12,
                padding: '6px 10px',
                cursor: 'pointer',
                width: '100%',
                textAlign: 'left',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--pixel-btn-bg)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              + New building
            </button>
          </div>
        </div>
      )}

      {creating && (
        <CreateBuildingModal
          onClose={() => setCreating(false)}
        />
      )}

      {managingProjects && (
        <ProjectMembershipModal
          buildingName={active.name}
          projects={projects}
          onClose={() => setManagingProjects(false)}
        />
      )}
    </div>
  )
}

interface ProjectMembershipModalProps {
  buildingName: string
  projects: ProjectMembershipEntry[]
  onClose: () => void
}

function ProjectMembershipModal({ buildingName, projects, onClose }: ProjectMembershipModalProps) {
  function toggle(p: ProjectMembershipEntry) {
    vscode.postMessage({
      type: 'setProjectMembership',
      workspacePath: p.workspacePath,
      included: !p.belongsToActive,
    })
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        zIndex: 200,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        style={{
          background: 'var(--pixel-bg)',
          border: '2px solid var(--pixel-border)',
          borderRadius: 0,
          boxShadow: '2px 2px 0px #0a0a14',
          padding: 16,
          minWidth: 480,
          maxHeight: '80vh',
          color: 'var(--pixel-fg)',
          fontFamily: 'inherit',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div style={{ marginBottom: 12, fontSize: 14, fontWeight: 'bold' }}>
          Projects in {buildingName}
        </div>
        <div style={{ marginBottom: 12, fontSize: 11, opacity: 0.7 }}>
          Tick which projects belong to this building. Projects can belong to more than one.
        </div>

        <div style={{ overflowY: 'auto', flex: 1, border: '2px solid var(--pixel-border)' }}>
          {projects.length === 0 ? (
            <div style={{ padding: 12, fontSize: 11, opacity: 0.7 }}>
              No projects discovered yet. Start a Claude session in a project directory to add it.
            </div>
          ) : projects.map(p => (
            <label
              key={p.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '6px 10px',
                cursor: 'pointer',
                fontSize: 12,
                background: p.belongsToActive ? 'rgba(123, 211, 137, 0.15)' : 'transparent',
              }}
              onMouseEnter={e => { if (!p.belongsToActive) (e.currentTarget.style.background = 'var(--pixel-btn-bg)') }}
              onMouseLeave={e => { if (!p.belongsToActive) (e.currentTarget.style.background = 'transparent') }}
            >
              <input
                type="checkbox"
                checked={p.belongsToActive}
                onChange={() => toggle(p)}
                style={{ width: 14, height: 14, cursor: 'pointer' }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: p.belongsToActive ? 'bold' : 'normal' }}>{p.name}</div>
                <div style={{ fontSize: 10, opacity: 0.6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {p.workspacePath}
                </div>
              </div>
            </label>
          ))}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'var(--pixel-btn-bg)', border: '2px solid var(--pixel-border)', borderRadius: 0,
              color: 'var(--pixel-fg)', fontFamily: 'inherit', fontSize: 12, padding: '4px 10px', cursor: 'pointer',
            }}
          >Close</button>
        </div>
      </div>
    </div>
  )
}

interface CreateBuildingProps {
  onClose: () => void
}

function CreateBuildingModal({ onClose }: CreateBuildingProps) {
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [connectorType, setConnectorType] = useState<'clickup' | 'github'>('github')

  function submit() {
    const cleanSlug = slug.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-')
    if (!name.trim() || !cleanSlug) return
    vscode.postMessage({
      type: 'createBuilding',
      slug: cleanSlug,
      name: name.trim(),
      connectorType,
    })
    onClose()
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        zIndex: 200,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        style={{
          background: 'var(--pixel-bg)',
          border: '2px solid var(--pixel-border)',
          borderRadius: 0,
          boxShadow: '2px 2px 0px #0a0a14',
          padding: 16,
          minWidth: 320,
          color: 'var(--pixel-fg)',
          fontFamily: 'inherit',
        }}
      >
        <div style={{ marginBottom: 12, fontSize: 14, fontWeight: 'bold' }}>New building</div>

        <label style={{ display: 'block', fontSize: 11, marginBottom: 4 }}>Name</label>
        <input
          value={name}
          onChange={e => {
            setName(e.target.value)
            if (!slug) setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))
          }}
          style={{
            width: '100%', boxSizing: 'border-box', marginBottom: 10,
            background: 'var(--pixel-btn-bg)', border: '2px solid var(--pixel-border)', borderRadius: 0,
            color: 'var(--pixel-fg)', fontFamily: 'inherit', fontSize: 12, padding: '4px 6px',
          }}
        />

        <label style={{ display: 'block', fontSize: 11, marginBottom: 4 }}>Slug (lowercase, hyphens)</label>
        <input
          value={slug}
          onChange={e => setSlug(e.target.value)}
          style={{
            width: '100%', boxSizing: 'border-box', marginBottom: 10,
            background: 'var(--pixel-btn-bg)', border: '2px solid var(--pixel-border)', borderRadius: 0,
            color: 'var(--pixel-fg)', fontFamily: 'inherit', fontSize: 12, padding: '4px 6px',
          }}
        />

        <label style={{ display: 'block', fontSize: 11, marginBottom: 4 }}>Connector</label>
        <select
          value={connectorType}
          onChange={e => setConnectorType(e.target.value as 'clickup' | 'github')}
          style={{
            width: '100%', boxSizing: 'border-box', marginBottom: 16,
            background: 'var(--pixel-btn-bg)', border: '2px solid var(--pixel-border)', borderRadius: 0,
            color: 'var(--pixel-fg)', fontFamily: 'inherit', fontSize: 12, padding: '4px 6px',
          }}
        >
          <option value="clickup">ClickUp</option>
          <option value="github">GitHub Issues</option>
        </select>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'var(--pixel-btn-bg)', border: '2px solid var(--pixel-border)', borderRadius: 0,
              color: 'var(--pixel-fg)', fontFamily: 'inherit', fontSize: 12, padding: '4px 10px', cursor: 'pointer',
            }}
          >Cancel</button>
          <button
            type="button"
            onClick={submit}
            disabled={!name.trim() || !slug.trim()}
            style={{
              background: 'var(--pixel-accent)', border: '2px solid var(--pixel-border)', borderRadius: 0,
              color: 'var(--pixel-fg)', fontFamily: 'inherit', fontSize: 12, padding: '4px 10px', cursor: 'pointer',
              opacity: (!name.trim() || !slug.trim()) ? 0.5 : 1,
            }}
          >Create</button>
        </div>
      </div>
    </div>
  )
}
