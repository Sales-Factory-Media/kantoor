import { useEffect, useRef, useCallback } from 'react'
import { OrgChart } from 'd3-org-chart'
import { select } from 'd3'
import type { OrganogramPayload, OrganogramNode } from '../hooks/useExtensionMessages.js'
import { vscode } from '../vscodeApi.js'

interface OrganogramProps {
  visible: boolean
  onClose: () => void
  organogram: OrganogramPayload | null
  onSelectAgent?: (persistentAgentId: string) => void
}

function nodeContent(node: { data: OrganogramNode }): string {
  const d = node.data
  const isGroup = d.nodeType === 'team' || d.nodeType === 'project'
  const bg = isGroup
    ? '#2a2a3e'
    : d.isOnline
      ? 'var(--pixel-accent, #7af47a)'
      : 'var(--pixel-bg, #1e1e2e)'
  const textColor = d.isOnline && !isGroup ? '#0a0a14' : 'var(--pixel-text, #cdd6f4)'
  const borderStyle = isGroup ? '2px dashed var(--pixel-border, #45475a)' : '2px solid var(--pixel-border, #45475a)'
  const icon = d.nodeType === 'project' ? '&#128187; ' : d.nodeType === 'team' ? '&#127912; ' : ''

  const ticket = d.currentTicketName
    ? `<div style="font-size:10px;margin-top:4px;opacity:0.9;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${d.currentTicketName.length > 28 ? d.currentTicketName.slice(0, 28) + '...' : d.currentTicketName}</div>`
    : ''

  return `
    <div style="
      background:${bg};
      color:${textColor};
      border:${borderStyle};
      border-radius:0;
      padding:6px 10px;
      text-align:center;
      box-shadow:2px 2px 0px #0a0a14;
      font-family:'FS Pixel Sans',monospace;
      font-size:14px;
      user-select:none;
      width:100%;
      height:100%;
      box-sizing:border-box;
      display:flex;
      flex-direction:column;
      justify-content:center;
      align-items:center;
    ">
      <div style="font-weight:bold;">${icon}${d.name}</div>
      <div style="font-size:11px;opacity:0.8;">${d.roleShort}</div>
      ${ticket}
    </div>
  `
}

export function Organogram({ visible, onClose, organogram, onSelectAgent }: OrganogramProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<OrgChart | null>(null)

  // Refresh data on open
  useEffect(() => {
    if (visible) {
      vscode.postMessage({ type: 'getOrganogram' })
    }
  }, [visible])

  const handleNodeClick = useCallback(
    (d: { data: OrganogramNode }) => {
      if (onSelectAgent && d.data.nodeType === 'person' && !d.data.id.startsWith('__')) {
        onSelectAgent(d.data.id)
      }
    },
    [onSelectAgent],
  )

  // Render / update chart
  useEffect(() => {
    if (!visible || !organogram || !containerRef.current) return

    const nodes = organogram.nodes
    if (nodes.length === 0) return

    // Root node has parentId = null; d3-org-chart expects parentId = '' for root
    const chartData = nodes.map(n => ({
      ...n,
      parentId: n.parentId ?? '',
    }))

    if (!chartRef.current) {
      chartRef.current = new OrgChart()
    }

    const chart = chartRef.current
    chart
      .container(containerRef.current as unknown as string)
      .data(chartData)
      .nodeWidth(() => 160)
      .nodeHeight((d: unknown) => {
        const node = d as { data: OrganogramNode }
        return node.data.currentTicketName ? 70 : 54
      })
      .childrenMargin(() => 40)
      .siblingsMargin(() => 16)
      .neighbourMargin(() => 60)
      .compactMarginBetween(() => 16)
      .compactMarginPair(() => 60)
      .nodeContent((d: unknown) => nodeContent(d as { data: OrganogramNode }))
      .onNodeClick((d: unknown) => handleNodeClick(d as { data: OrganogramNode }))
      .nodeButtonHeight(() => 24)
      .nodeButtonWidth(() => 24)
      .nodeButtonX(() => -12)
      .nodeButtonY(() => -12)
      .linkUpdate(function (this: SVGPathElement) {
        select(this).attr('stroke', 'var(--pixel-border, #45475a)')
      })
      .initialExpandLevel(1)
      .compact(false)
      .render()
      .fit()

    // Style the SVG background to match pixel theme
    const svg = containerRef.current.querySelector('svg')
    if (svg) {
      svg.style.background = 'transparent'
    }

    return () => {
      // Cleanup on unmount
      chartRef.current = null
      if (containerRef.current) {
        containerRef.current.innerHTML = ''
      }
    }
  }, [visible, organogram, handleNodeClick])

  if (!visible) return null

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
          width: '90vw',
          height: '85vh',
          overflow: 'hidden',
          boxShadow: '4px 4px 0px #0a0a14',
          color: 'var(--pixel-text)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
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

        {!organogram || organogram.nodes.length === 0 ? (
          <div style={{ padding: 20, textAlign: 'center', flex: 1 }}>Loading organogram...</div>
        ) : (
          <div ref={containerRef} style={{ flex: 1, overflow: 'hidden' }} />
        )}
      </div>
    </div>
  )
}
