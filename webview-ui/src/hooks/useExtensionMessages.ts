import { useState, useEffect, useRef, useCallback } from 'react'

/**
 * `useState`, but writes are coalesced through `requestAnimationFrame`.
 *
 * WebSocket messages from the standalone server arrive in their own event-
 * loop turns, so React 19's automatic batching only batches setState calls
 * within a single message handler — not across messages. With a busy fleet
 * (10–50 msgs/sec) that meant the App tree was reconciling 10–50× per
 * second, on top of the canvas tick.
 *
 * This wrapper keeps the latest value in a ref (so functional updaters see
 * accumulated state) and flushes to React state at most once per frame.
 * Reads return one-frame-stale data, which is fine for UI driven by these
 * fields (it updates at the screen refresh rate anyway).
 */
function useBatchedState<T>(initial: T): [T, (updater: T | ((prev: T) => T)) => void] {
  const [state, setState] = useState<T>(initial)
  const valueRef = useRef<T>(initial)
  const scheduledRef = useRef(false)
  const rafRef = useRef<number>(0)

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  const batchedSet = useCallback((updater: T | ((prev: T) => T)) => {
    const next = typeof updater === 'function'
      ? (updater as (prev: T) => T)(valueRef.current)
      : updater
    if (next === valueRef.current) return
    valueRef.current = next
    if (scheduledRef.current) return
    scheduledRef.current = true
    rafRef.current = requestAnimationFrame(() => {
      scheduledRef.current = false
      setState(valueRef.current)
    })
  }, [])

  return [state, batchedSet]
}
import type { OfficeState } from '../office/engine/officeState.js'
import type { ToolActivity, ConversationEntry } from '../office/types.js'
import { FurnitureType } from '../office/types.js'
import { extractToolName } from '../office/toolUtils.js'
import { buildDynamicCatalog } from '../office/layout/furnitureCatalog.js'
import { setFloorSprites } from '../office/floorTiles.js'
import { setWallSprites } from '../office/wallTiles.js'
import { setCharacterTemplates } from '../office/sprites/spriteData.js'
import { vscode } from '../vscodeApi.js'
import { playDoneSound, setSoundEnabled } from '../notificationSound.js'
import { CONVERSATION_MAX_ENTRIES } from '../constants.js'

const CAR_TYPES = [
  FurnitureType.CAR_SEDAN, FurnitureType.CAR_SPORT, FurnitureType.CAR_SUV,
  FurnitureType.CAR_PICKUP, FurnitureType.CAR_COUPE, FurnitureType.CAR_SUPERCAR,
]
function pickRandomCarType(): string {
  return CAR_TYPES[Math.floor(Math.random() * CAR_TYPES.length)]
}

export interface SubagentCharacter {
  id: number
  parentAgentId: number
  parentToolId: string
  label: string
}

export interface FurnitureAsset {
  id: string
  name: string
  label: string
  category: string
  file: string
  width: number
  height: number
  footprintW: number
  footprintH: number
  isDesk: boolean
  canPlaceOnWalls: boolean
  partOfGroup?: boolean
  groupId?: string
  canPlaceOnSurfaces?: boolean
  backgroundTiles?: number
}

export interface WorkspaceFolder {
  name: string
  path: string
}

export interface KnownProject {
  name: string
  workspacePath: string
  description?: string
}

export interface OfflineAgent {
  sessionId: string
  name?: string
  projectName?: string
  workspacePath?: string
  palette?: number
  hueShift?: number
  isPersistent?: boolean
  roleShort?: string
  roleFull?: string
  lastSessionEnd?: string
  sessionCount?: number
  avatarConfig?: string
}

/** An existing employee offered as a match in the "who's this?" popup */
export interface IdentifyCandidate {
  id: string
  name: string
  roleShort?: string
  lastSessionEnd?: string
  sessionCount?: number
  avatarConfig?: string
  /** How many concurrent sessions/tasks this employee is already running. */
  activeTaskCount?: number
}

/** A freshly-discovered session awaiting user identification */
export interface PendingWorker {
  sessionId: string
  provisionalAgentId: string
  provisionalName: string
  workspacePath?: string
  projectName?: string
  candidates: IdentifyCandidate[]
  /** True when this popup is an explicit reassignment of an already-identified
   *  session (vs. first-time identification). Picking a new hire then MOVES the
   *  task to a brand-new employee instead of renaming the current owner. */
  reassign?: boolean
}

/** Auto Mode: a ticket Darryl classified, awaiting the human's Start/Discard. */
export interface PendingDelegation {
  ticketId: string
  ticketName: string
  ticketUrl: string
  recommendedAgentId: string
  recommendedAgentName: string
  recommendedAgentRole: string
  recommendedWorkspacePath: string
  reasoning: string
  brief: string
  createdAt: number
}

/** A copy-paste prompt to make a live session aware of who it now is. */
export interface IdentityPrompt {
  sessionId: string
  agentId: string
  name: string
  roleShort?: string
  prompt: string
}

export interface WorkerStatusEntry {
  name: string
  color: string
  hostname: string
  status: 'idle' | 'busy' | 'disconnected'
  ticketId: string | null
  ticketName: string | null
  isHub: boolean
}

export type OrganogramNodeType = 'person' | 'team' | 'project'

export interface OrganogramNode {
  id: string
  parentId: string | null
  name: string
  roleShort: string
  roleFull: string
  isOnline: boolean
  nodeType: OrganogramNodeType
  currentTicketId?: string
  currentTicketName?: string
}

export interface OrganogramPayload {
  nodes: OrganogramNode[]
}

export interface ClickUpTask {
  id: string
  name: string
  status: { status: string; color: string }
  assignees: Array<{ username: string }>
  url: string
  priority: { id: string } | null
  parent: string | null
}

export interface ClickUpStatusGroup {
  name: string
  color: string
  tasks: ClickUpTask[]
}

export interface JanDesignConfig {
  figmaUrl: string
  clickupDocUrl: string
  examplesUrl: string
}

export interface BuildingSummary {
  id: string
  slug: string
  name: string
  connectorType: string
  sortOrder: number
  configured: boolean
}

export interface ProjectMembershipEntry {
  id: number
  name: string
  workspacePath: string
  description?: string
  belongsToActive: boolean
}

export interface ExtensionMessageState {
  agents: number[]
  selectedAgent: number | null
  selectAgent: (id: number | null) => void
  agentTools: Record<number, ToolActivity[]>
  agentStatuses: Record<number, string>
  subagentTools: Record<number, Record<string, ToolActivity[]>>
  subagentCharacters: SubagentCharacter[]
  layoutReady: boolean
  loadedAssets?: { catalog: FurnitureAsset[]; sprites: Record<string, string[][]> }
  workspaceFolders: WorkspaceFolder[]
  agentConversation: Record<number, ConversationEntry[]>
  offlineAgents: OfflineAgent[]
  knownProjects: KnownProject[]
  saveAgentMeta: () => void
  forgetAgent: (sessionId: string) => void
  clickupTickets: ClickUpStatusGroup[]
  clickupConfigured: boolean
  clickupListId: string | null
  clickupNextFetchAt: number | null
  activeConference: { conferenceId: string; agent1Id: string; agent2Id: string; topic: string } | null
  peersBrokerAvailable: boolean
  workers: WorkerStatusEntry[]
  organogram: OrganogramPayload | null
  janDesignConfig: JanDesignConfig | null
  buildings: BuildingSummary[]
  activeBuildingId: string | null
  projectMemberships: ProjectMembershipEntry[]
  pendingWorkers: PendingWorker[]
  dismissPendingWorker: (sessionId: string) => void
  identityPrompt: IdentityPrompt | null
  dismissIdentityPrompt: () => void
  autoMode: boolean
  pendingDelegations: PendingDelegation[]
}

export function useExtensionMessages(
  getOfficeState: () => OfficeState,
): ExtensionMessageState {
  const [agents, setAgents] = useState<number[]>([])
  const [selectedAgent, setSelectedAgent] = useState<number | null>(null)
  // High-frequency channels — every JSONL line write produces a message that
  // hits one of these. Routed through useBatchedState so a busy fleet can't
  // hammer React reconciliation faster than the screen can refresh.
  const [agentTools, setAgentTools] = useBatchedState<Record<number, ToolActivity[]>>({})
  const [agentStatuses, setAgentStatuses] = useBatchedState<Record<number, string>>({})
  const [subagentTools, setSubagentTools] = useBatchedState<Record<number, Record<string, ToolActivity[]>>>({})
  const [subagentCharacters, setSubagentCharacters] = useBatchedState<SubagentCharacter[]>([])
  const [layoutReady, setLayoutReady] = useState(false)
  const [loadedAssets, setLoadedAssets] = useState<{ catalog: FurnitureAsset[]; sprites: Record<string, string[][]> } | undefined>()
  const [workspaceFolders, setWorkspaceFolders] = useState<WorkspaceFolder[]>([])
  const [agentConversation, setAgentConversation] = useBatchedState<Record<number, ConversationEntry[]>>({})
  const [offlineAgents, setOfflineAgents] = useState<OfflineAgent[]>([])
  const [clickupTickets, setClickupTickets] = useState<ClickUpStatusGroup[]>([])
  const [clickupConfigured, setClickupConfigured] = useState(false)
  const [clickupListId, setClickupListId] = useState<string | null>(null)
  const [clickupNextFetchAt, setClickupNextFetchAt] = useState<number | null>(null)
  const [activeConference, setActiveConference] = useState<{ conferenceId: string; agent1Id: string; agent2Id: string; topic: string } | null>(null)
  const [peersBrokerAvailable, setPeersBrokerAvailable] = useState(false)
  const [workers, setWorkers] = useState<WorkerStatusEntry[]>([])
  const [organogram, setOrganogram] = useState<OrganogramPayload | null>(null)
  const [janDesignConfig, setJanDesignConfig] = useState<JanDesignConfig | null>(null)
  const [buildings, setBuildings] = useState<BuildingSummary[]>([])
  const [activeBuildingId, setActiveBuildingId] = useState<string | null>(null)
  const [projectMemberships, setProjectMemberships] = useState<ProjectMembershipEntry[]>([])
  const [pendingWorkers, setPendingWorkers] = useState<PendingWorker[]>([])
  const [identityPrompt, setIdentityPrompt] = useState<IdentityPrompt | null>(null)
  const [autoMode, setAutoMode] = useState(false)
  const [pendingDelegations, setPendingDelegations] = useState<PendingDelegation[]>([])

  // Ref to expose saveAgentMeta and forgetAgent outside the effect closure
  const saveAgentMetaRef = useRef<() => void>(() => {})
  const forgetAgentRef = useRef<(sessionId: string) => void>(() => {})

  // Track whether initial layout has been loaded (ref to avoid re-render)
  const layoutReadyRef = useRef(false)

  // Known projects — state for sidebar, ref for effect closure
  const [knownProjects, setKnownProjects] = useState<KnownProject[]>([])
  const knownProjectsRef = useRef<KnownProject[]>([])

  // Offline agents ref for room sizing (effect closure needs current value)
  const offlineAgentsRef = useRef<OfflineAgent[]>([])

  useEffect(() => {
    // Buffer agents from existingAgents until layout is loaded
    let pendingAgents: Array<{ id: number; palette?: number; hueShift?: number; seatId?: string; name?: string; sessionId?: string; folderName?: string; roleShort?: string; roleFull?: string; workspacePath?: string; persistentAgentId?: string; carType?: string; avatarConfig?: string; sessionCount?: number; lastSessionEnd?: string; taskTitle?: string }> = []

    // Cached metadata from seats.json (keyed by sessionId)
    let cachedMeta: Record<string, { name?: string; palette?: number; hueShift?: number; seatId?: string; roleShort?: string; roleFull?: string; workspacePath?: string; persistentAgentId?: string; avatarConfig?: string; sessionCount?: number; lastSessionEnd?: string }> = {}

    /** Save all non-sub-agent character metadata keyed by sessionId */
    function saveAgentMeta(os: OfficeState): void {
      const seats: Record<string, { name?: string; palette?: number; hueShift?: number; seatId?: string; roleShort?: string; roleFull?: string; workspacePath?: string; persistentAgentId?: string; carType?: string; avatarConfig?: string }> = {}
      for (const ch of os.characters.values()) {
        if (ch.isSubagent || !ch.sessionId) continue
        seats[ch.sessionId] = { name: ch.name, palette: ch.palette, hueShift: ch.hueShift, seatId: ch.seatId ?? undefined, roleShort: ch.roleShort, roleFull: ch.roleFull, workspacePath: ch.workspacePath, persistentAgentId: ch.persistentAgentId, carType: ch.carType, avatarConfig: ch.avatarConfig }
      }
      // Merge with cached meta to preserve data for offline agents
      const merged = { ...cachedMeta, ...seats }
      cachedMeta = merged
      vscode.postMessage({ type: 'saveAgentSeats', seats: merged })
    }

    saveAgentMetaRef.current = () => saveAgentMeta(getOfficeState())
    forgetAgentRef.current = (sessionId: string) => {
      delete cachedMeta[sessionId]
      vscode.postMessage({ type: 'forgetAgent', sessionId })
    }

    const handler = (e: MessageEvent) => {
      const msg = e.data
      const os = getOfficeState()

      if (msg.type === 'offlineAgents') {
        const incoming = msg.agents as OfflineAgent[]
        offlineAgentsRef.current = incoming
        setOfflineAgents(incoming)
        if (layoutReadyRef.current) {
          os.regenerateRoomLayout(knownProjectsRef.current, incoming)
        }
      } else if (msg.type === 'organogramSnapshot') {
        setOrganogram(msg.organogram as OrganogramPayload)
      } else if (msg.type === 'knownProjects') {
        const projects = msg.projects as KnownProject[]
        knownProjectsRef.current = projects
        setKnownProjects(projects)
        if (layoutReadyRef.current) {
          os.regenerateRoomLayout(projects, offlineAgentsRef.current)
        }
      } else if (msg.type === 'layoutLoaded') {
        // Generate room layout from known projects and buffered agents
        // First add buffered agents so their project names are counted
        for (const p of pendingAgents) {
          os.addAgent(p.id, p.palette, p.hueShift, p.seatId, true, p.folderName, p.sessionId, p.name, p.persistentAgentId)
          const ch = os.characters.get(p.id)
          if (ch) {
            if (p.roleShort) ch.roleShort = p.roleShort
            if (p.roleFull) ch.roleFull = p.roleFull
            if (p.workspacePath) ch.workspacePath = p.workspacePath
            if (p.persistentAgentId) ch.persistentAgentId = p.persistentAgentId
            if (p.avatarConfig) ch.avatarConfig = p.avatarConfig
            if (p.sessionCount !== undefined) ch.sessionCount = p.sessionCount
            if (p.lastSessionEnd !== undefined) ch.lastSessionEnd = p.lastSessionEnd
            if (p.taskTitle !== undefined) ch.taskTitle = p.taskTitle
            ch.carType = p.carType || pickRandomCarType()
          }
        }
        pendingAgents = []
        os.regenerateRoomLayout(knownProjectsRef.current, offlineAgentsRef.current)
        saveAgentMeta(os)
        layoutReadyRef.current = true
        setLayoutReady(true)
      } else if (msg.type === 'agentCreated') {
        const id = msg.id as number
        const sessionId = msg.sessionId as string | undefined
        const folderName = msg.folderName as string | undefined
        // Check cached metadata first, fall back to metadata embedded in the message
        const cached = sessionId ? cachedMeta[sessionId] : undefined
        const inline = msg.name ? { name: msg.name as string, palette: msg.palette as number | undefined, hueShift: msg.hueShift as number | undefined, seatId: msg.seatId as string | undefined, roleShort: msg.roleShort as string | undefined, roleFull: msg.roleFull as string | undefined, workspacePath: msg.workspacePath as string | undefined, persistentAgentId: msg.persistentAgentId as string | undefined, avatarConfig: msg.avatarConfig as string | undefined, sessionCount: msg.sessionCount as number | undefined, lastSessionEnd: msg.lastSessionEnd as string | undefined } : undefined
        const m = cached || inline
        setAgents((prev) => (prev.includes(id) ? prev : [...prev, id]))
        setSelectedAgent(id)
        os.addAgent(id, m?.palette, m?.hueShift, m?.seatId, undefined, folderName, sessionId, m?.name, m?.persistentAgentId)
        {
          const ch = os.characters.get(id)
          if (ch) {
            if (m?.roleShort) ch.roleShort = m.roleShort
            if (m?.roleFull) ch.roleFull = m.roleFull
            if (m?.workspacePath) ch.workspacePath = m.workspacePath
            if (m?.persistentAgentId) ch.persistentAgentId = m.persistentAgentId
            if (m?.avatarConfig) ch.avatarConfig = m.avatarConfig
            if (m?.sessionCount !== undefined) ch.sessionCount = m.sessionCount
            if (m?.lastSessionEnd !== undefined) ch.lastSessionEnd = m.lastSessionEnd
            // taskTitle rides on the message itself (live-session state), not seat meta.
            if (msg.taskTitle !== undefined) ch.taskTitle = msg.taskTitle as string
            ch.carType = (m as Record<string, unknown>)?.carType as string || pickRandomCarType()
          }
        }
        os.regenerateRoomLayout(knownProjectsRef.current, offlineAgentsRef.current)
        saveAgentMeta(os)
      } else if (msg.type === 'agentClosed') {
        const id = msg.id as number
        setAgents((prev) => prev.filter((a) => a !== id))
        setSelectedAgent((prev) => (prev === id ? null : prev))
        setAgentTools((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        setAgentStatuses((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        setSubagentTools((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        setAgentConversation((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        // Remove all sub-agent characters belonging to this agent
        os.removeAllSubagents(id)
        setSubagentCharacters((prev) => prev.filter((s) => s.parentAgentId !== id))
        os.removeAgent(id)
        os.regenerateRoomLayout(knownProjectsRef.current, offlineAgentsRef.current)
      } else if (msg.type === 'existingAgents') {
        const incoming = msg.agents as number[]
        const meta = (msg.agentMeta || {}) as Record<string, { name?: string; palette?: number; hueShift?: number; seatId?: string; roleShort?: string; roleFull?: string; workspacePath?: string; persistentAgentId?: string; carType?: string; avatarConfig?: string; sessionCount?: number; lastSessionEnd?: string }>
        const sessionIds = (msg.sessionIds || {}) as Record<number, string>
        const folderNames = (msg.folderNames || {}) as Record<number, string>
        const taskTitles = (msg.taskTitles || {}) as Record<number, string>
        // Cache metadata for later lookups (e.g. new agents arriving with known sessionId)
        cachedMeta = { ...cachedMeta, ...meta }
        // Buffer agents — they'll be added in layoutLoaded after seats are built
        for (const id of incoming) {
          const sid = sessionIds[id]
          // Try sessionId-keyed metadata first, fall back to agentId-keyed (extension compat)
          const m = (sid ? meta[sid] : undefined) || meta[id]
          pendingAgents.push({ id, palette: m?.palette, hueShift: m?.hueShift, seatId: m?.seatId, name: m?.name, sessionId: sid, folderName: folderNames[id], roleShort: m?.roleShort, roleFull: m?.roleFull, workspacePath: m?.workspacePath, persistentAgentId: m?.persistentAgentId, carType: m?.carType, avatarConfig: m?.avatarConfig, sessionCount: m?.sessionCount, lastSessionEnd: m?.lastSessionEnd, taskTitle: taskTitles[id] })
        }
        setAgents((prev) => {
          const ids = new Set(prev)
          const merged = [...prev]
          for (const id of incoming) {
            if (!ids.has(id)) {
              merged.push(id)
            }
          }
          return merged.sort((a, b) => a - b)
        })
      } else if (msg.type === 'agentToolStart') {
        const id = msg.id as number
        const toolId = msg.toolId as string
        const status = msg.status as string
        setAgentTools((prev) => {
          const list = prev[id] || []
          if (list.some((t) => t.toolId === toolId)) return prev
          return { ...prev, [id]: [...list, { toolId, status, done: false }] }
        })
        const toolName = extractToolName(status)
        os.setAgentTool(id, toolName)
        os.setAgentActive(id, true)
        os.clearPermissionBubble(id)
        // Create sub-agent character for Task tool subtasks
        if (status.startsWith('Subtask:')) {
          const label = status.slice('Subtask:'.length).trim()
          const subId = os.addSubagent(id, toolId)
          setSubagentCharacters((prev) => {
            if (prev.some((s) => s.id === subId)) return prev
            return [...prev, { id: subId, parentAgentId: id, parentToolId: toolId, label }]
          })
        }
      } else if (msg.type === 'agentToolDone') {
        const id = msg.id as number
        const toolId = msg.toolId as string
        setAgentTools((prev) => {
          const list = prev[id]
          if (!list) return prev
          return {
            ...prev,
            [id]: list.map((t) => (t.toolId === toolId ? { ...t, done: true } : t)),
          }
        })
      } else if (msg.type === 'agentToolsClear') {
        const id = msg.id as number
        setAgentTools((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        setSubagentTools((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        // Remove all sub-agent characters belonging to this agent
        os.removeAllSubagents(id)
        setSubagentCharacters((prev) => prev.filter((s) => s.parentAgentId !== id))
        os.setAgentTool(id, null)
        os.clearPermissionBubble(id)
      } else if (msg.type === 'agentSelected') {
        const id = msg.id as number
        setSelectedAgent(id)
      } else if (msg.type === 'agentStatus') {
        const id = msg.id as number
        const status = msg.status as string
        setAgentStatuses((prev) => {
          if (status === 'active') {
            if (!(id in prev)) return prev
            const next = { ...prev }
            delete next[id]
            return next
          }
          return { ...prev, [id]: status }
        })
        os.setAgentActive(id, status === 'active')
        if (status === 'waiting') {
          os.showWaitingBubble(id)
          playDoneSound()
        }
      } else if (msg.type === 'agentToolPermission') {
        const id = msg.id as number
        setAgentTools((prev) => {
          const list = prev[id]
          if (!list) return prev
          return {
            ...prev,
            [id]: list.map((t) => (t.done ? t : { ...t, permissionWait: true })),
          }
        })
        os.showPermissionBubble(id)
      } else if (msg.type === 'subagentToolPermission') {
        const id = msg.id as number
        const parentToolId = msg.parentToolId as string
        // Show permission bubble on the sub-agent character
        const subId = os.getSubagentId(id, parentToolId)
        if (subId !== null) {
          os.showPermissionBubble(subId)
        }
      } else if (msg.type === 'agentToolPermissionClear') {
        const id = msg.id as number
        setAgentTools((prev) => {
          const list = prev[id]
          if (!list) return prev
          const hasPermission = list.some((t) => t.permissionWait)
          if (!hasPermission) return prev
          return {
            ...prev,
            [id]: list.map((t) => (t.permissionWait ? { ...t, permissionWait: false } : t)),
          }
        })
        os.clearPermissionBubble(id)
        // Also clear permission bubbles on all sub-agent characters of this parent
        for (const [subId, meta] of os.subagentMeta) {
          if (meta.parentAgentId === id) {
            os.clearPermissionBubble(subId)
          }
        }
      } else if (msg.type === 'agentConference') {
        const readerId = msg.readerId as number
        const targetId = msg.targetId as number
        os.sendToConference(readerId, targetId)
      } else if (msg.type === 'subagentToolStart') {
        const id = msg.id as number
        const parentToolId = msg.parentToolId as string
        const toolId = msg.toolId as string
        const status = msg.status as string
        setSubagentTools((prev) => {
          const agentSubs = prev[id] || {}
          const list = agentSubs[parentToolId] || []
          if (list.some((t) => t.toolId === toolId)) return prev
          return { ...prev, [id]: { ...agentSubs, [parentToolId]: [...list, { toolId, status, done: false }] } }
        })
        // Update sub-agent character's tool and active state
        const subId = os.getSubagentId(id, parentToolId)
        if (subId !== null) {
          const subToolName = extractToolName(status)
          os.setAgentTool(subId, subToolName)
          os.setAgentActive(subId, true)
        }
      } else if (msg.type === 'subagentToolDone') {
        const id = msg.id as number
        const parentToolId = msg.parentToolId as string
        const toolId = msg.toolId as string
        setSubagentTools((prev) => {
          const agentSubs = prev[id]
          if (!agentSubs) return prev
          const list = agentSubs[parentToolId]
          if (!list) return prev
          return {
            ...prev,
            [id]: { ...agentSubs, [parentToolId]: list.map((t) => (t.toolId === toolId ? { ...t, done: true } : t)) },
          }
        })
      } else if (msg.type === 'subagentClear') {
        const id = msg.id as number
        const parentToolId = msg.parentToolId as string
        setSubagentTools((prev) => {
          const agentSubs = prev[id]
          if (!agentSubs || !(parentToolId in agentSubs)) return prev
          const next = { ...agentSubs }
          delete next[parentToolId]
          if (Object.keys(next).length === 0) {
            const outer = { ...prev }
            delete outer[id]
            return outer
          }
          return { ...prev, [id]: next }
        })
        // Remove sub-agent character
        os.removeSubagent(id, parentToolId)
        setSubagentCharacters((prev) => prev.filter((s) => !(s.parentAgentId === id && s.parentToolId === parentToolId)))
      } else if (msg.type === 'characterSpritesLoaded') {
        const characters = msg.characters as Array<{ down: string[][][]; up: string[][][]; right: string[][][] }>
        console.log(`[Webview] Received ${characters.length} pre-colored character sprites`)
        setCharacterTemplates(characters)
      } else if (msg.type === 'floorTilesLoaded') {
        const sprites = msg.sprites as string[][][]
        console.log(`[Webview] Received ${sprites.length} floor tile patterns`)
        setFloorSprites(sprites)
      } else if (msg.type === 'wallTilesLoaded') {
        const sprites = msg.sprites as string[][][]
        console.log(`[Webview] Received ${sprites.length} wall tile sprites`)
        setWallSprites(sprites)
      } else if (msg.type === 'workspaceFolders') {
        const folders = msg.folders as WorkspaceFolder[]
        setWorkspaceFolders(folders)
      } else if (msg.type === 'settingsLoaded') {
        const soundOn = msg.soundEnabled as boolean
        setSoundEnabled(soundOn)
      } else if (msg.type === 'janDesignConfigLoaded') {
        setJanDesignConfig(msg.config as JanDesignConfig)
      } else if (msg.type === 'autoModeLoaded') {
        setAutoMode(msg.enabled === true)
      } else if (msg.type === 'delegationPending') {
        setPendingDelegations((msg.delegations as PendingDelegation[]) || [])
      } else if (msg.type === 'furnitureAssetsLoaded') {
        try {
          const catalog = msg.catalog as FurnitureAsset[]
          const sprites = msg.sprites as Record<string, string[][]>
          console.log(`📦 Webview: Loaded ${catalog.length} furniture assets`)
          // Build dynamic catalog immediately so getCatalogEntry() works when layoutLoaded arrives next
          buildDynamicCatalog({ catalog, sprites })
          setLoadedAssets({ catalog, sprites })
        } catch (err) {
          console.error(`❌ Webview: Error processing furnitureAssetsLoaded:`, err)
        }
      } else if (msg.type === 'agentConversation') {
        const id = msg.id as number
        const entries = msg.entries as ConversationEntry[]
        setAgentConversation((prev) => {
          const existing = prev[id] || []
          const merged = [...existing, ...entries]
          return { ...prev, [id]: merged.length > CONVERSATION_MAX_ENTRIES ? merged.slice(-CONVERSATION_MAX_ENTRIES) : merged }
        })
      } else if (msg.type === 'agentIdentitySaved') {
        // Link the persistent agent ID to the live character
        const agentId = msg.agentId as string
        for (const ch of os.characters.values()) {
          if (ch.sessionId && ch.persistentAgentId === undefined) {
            // Check if this character's session matches any of the saved agent data
            const savedAgent = msg.agent as { currentSessionId?: string } | undefined
            if (savedAgent?.currentSessionId === ch.sessionId) {
              ch.persistentAgentId = agentId
            }
          }
          // Also match if we just saved for this character
          if (ch.persistentAgentId === agentId) {
            const savedAgent = msg.agent as { name?: string; roleShort?: string; roleFull?: string; workspacePath?: string; avatarConfig?: string } | undefined
            if (savedAgent) {
              if (savedAgent.name) ch.name = savedAgent.name
              if (savedAgent.roleShort !== undefined) ch.roleShort = savedAgent.roleShort
              if (savedAgent.roleFull !== undefined) ch.roleFull = savedAgent.roleFull
              if (savedAgent.workspacePath !== undefined) ch.workspacePath = savedAgent.workspacePath
              if (savedAgent.avatarConfig !== undefined) ch.avatarConfig = savedAgent.avatarConfig
            }
          }
        }
        saveAgentMeta(os)
      } else if (msg.type === 'agentConversationHistory') {
        const id = msg.id as number
        const entries = msg.entries as ConversationEntry[]
        setAgentConversation((prev) => {
          const existing = prev[id] || []
          // Only load history if we don't already have entries for this agent
          if (existing.length > 0) return prev
          return { ...prev, [id]: entries.slice(-CONVERSATION_MAX_ENTRIES) }
        })
      } else if (msg.type === 'clickupTickets') {
        setClickupTickets(msg.statuses as ClickUpStatusGroup[])
        if (msg.nextFetchAt != null) setClickupNextFetchAt(msg.nextFetchAt as number)
      } else if (msg.type === 'clickupConfigured') {
        setClickupConfigured(msg.configured as boolean)
        if (msg.listId) setClickupListId(msg.listId as string)
      } else if (msg.type === 'clickupError') {
        console.error('[ClickUp]', msg.error)
      } else if (msg.type === 'conferenceStarted') {
        setActiveConference({
          conferenceId: msg.conferenceId as string,
          agent1Id: msg.agent1Id as string,
          agent2Id: msg.agent2Id as string,
          topic: msg.topic as string,
        })
      } else if (msg.type === 'conferenceEnded') {
        setActiveConference(null)
      } else if (msg.type === 'peersBrokerStatus') {
        setPeersBrokerAvailable(msg.available as boolean)
      } else if (msg.type === 'workerStatus') {
        setWorkers(msg.workers as WorkerStatusEntry[])
      } else if (msg.type === 'buildingsList') {
        setBuildings(msg.buildings as BuildingSummary[])
        setActiveBuildingId(msg.activeBuildingId as string | null)
      } else if (msg.type === 'buildingSwitched') {
        // Hot-swap: server is about to send fresh state for the new building.
        // Drop all live characters/agents so the office repopulates cleanly.
        const building = msg.building as BuildingSummary
        setActiveBuildingId(building.id)
        const os = getOfficeState()
        os.characters.clear()
        setAgents([])
        setSelectedAgent(null)
        setAgentTools({})
        setAgentStatuses({})
        setSubagentTools({})
        setSubagentCharacters([])
        setClickupTickets([])
        setClickupNextFetchAt(null)
        layoutReadyRef.current = false
        setLayoutReady(false)
        // The server will resend organogram/knownProjects/offlineAgents/etc.
        // immediately after this message; the existing handlers pick those up.
      } else if (msg.type === 'buildingConfigured') {
        // Server has merged a new connector config; just refresh the building
        // list so the dropdown's "configured" badge updates.
        vscode.postMessage({ type: 'listBuildings' })
      } else if (msg.type === 'buildingCreateError') {
        console.error('[Buildings] create failed:', msg.error)
      } else if (msg.type === 'seatsLoaded') {
        // Sent during a building switch — replaces cached seat metadata so
        // characters that come back online get the new building's seats.
        cachedMeta = (msg.seats as Record<string, { name?: string; palette?: number; hueShift?: number; seatId?: string; roleShort?: string; roleFull?: string; workspacePath?: string; persistentAgentId?: string; avatarConfig?: string }>) ?? {}
      } else if (msg.type === 'projectsList') {
        setProjectMemberships(msg.projects as ProjectMembershipEntry[])
      } else if (msg.type === 'newWorkerIdentified') {
        const worker: PendingWorker = {
          sessionId: msg.sessionId as string,
          provisionalAgentId: msg.provisionalAgentId as string,
          provisionalName: (msg.provisionalName as string) || '',
          workspacePath: msg.workspacePath as string | undefined,
          projectName: msg.projectName as string | undefined,
          candidates: (msg.candidates as IdentifyCandidate[]) || [],
          reassign: msg.reassign === true,
        }
        // De-dupe on sessionId; a re-fired popup (e.g. reassign) replaces the
        // queued one so the latest candidate list / reassign flag wins.
        setPendingWorkers((prev) => {
          const rest = prev.filter((w) => w.sessionId !== worker.sessionId)
          return [...rest, worker]
        })
      } else if (msg.type === 'agentIdentityPrompt') {
        setIdentityPrompt({
          sessionId: msg.sessionId as string,
          agentId: msg.agentId as string,
          name: msg.name as string,
          roleShort: msg.roleShort as string | undefined,
          prompt: msg.prompt as string,
        })
      } else if (msg.type === 'agentReidentified') {
        // The user resolved a "who's this?" popup — update the live character in
        // place (name/role/appearance) without tearing it down.
        const id = msg.id as number
        const ch = os.characters.get(id)
        if (ch) {
          if (msg.name !== undefined) ch.name = msg.name as string
          if (msg.roleShort !== undefined) ch.roleShort = msg.roleShort as string
          if (msg.roleFull !== undefined) ch.roleFull = msg.roleFull as string
          if (msg.workspacePath !== undefined) ch.workspacePath = (msg.workspacePath as string) || undefined
          if (msg.palette !== undefined && msg.palette !== null) ch.palette = msg.palette as number
          if (msg.hueShift !== undefined && msg.hueShift !== null) ch.hueShift = msg.hueShift as number
          if (msg.persistentAgentId !== undefined) {
            ch.persistentAgentId = msg.persistentAgentId as string
            // The session may have just been adopted onto an employee who is
            // already working — fold it into that employee's body (it becomes a
            // pip) instead of standing as a second identical character.
            os.regroupCharacterUnderEmployee(id)
          }
          if (msg.avatarConfig !== undefined) ch.avatarConfig = msg.avatarConfig as string
          // Drop the resolved worker from the popup queue (match by live session).
          if (ch.sessionId) setPendingWorkers((prev) => prev.filter((w) => w.sessionId !== ch.sessionId))
          saveAgentMeta(os)
        }
      }
    }
    window.addEventListener('message', handler)
    vscode.postMessage({ type: 'webviewReady' })
    return () => window.removeEventListener('message', handler)
  }, [getOfficeState])

  const saveAgentMeta = useCallback(() => saveAgentMetaRef.current(), [])
  const forgetAgent = useCallback((sessionId: string) => forgetAgentRef.current(sessionId), [])
  // Dismiss is purely local — the provisional agent stays on the server and just
  // becomes a normal (un-named) offline agent the user can edit later.
  const dismissIdentityPrompt = useCallback(() => setIdentityPrompt(null), [])
  const dismissPendingWorker = useCallback((sessionId: string) => {
    setPendingWorkers((prev) => prev.filter((w) => w.sessionId !== sessionId))
  }, [])

  return { agents, selectedAgent, selectAgent: setSelectedAgent, agentTools, agentStatuses, subagentTools, subagentCharacters, layoutReady, loadedAssets, workspaceFolders, agentConversation, offlineAgents, knownProjects, saveAgentMeta, forgetAgent, clickupTickets, clickupConfigured, clickupListId, clickupNextFetchAt, activeConference, peersBrokerAvailable, workers, organogram, janDesignConfig, buildings, activeBuildingId, projectMemberships, pendingWorkers, dismissPendingWorker, identityPrompt, dismissIdentityPrompt, autoMode, pendingDelegations }
}
