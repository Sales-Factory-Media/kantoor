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
import { vscode } from '../vscodeApi.js'
import { dispatchMessage } from './messages/index.js'
import { saveAgentMeta as runSaveAgentMeta, type HandlerCtx, type MessageBuffer } from './messages/ctx.js'

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
  /** Optional logo as a data URI, rendered before the project name. */
  logo?: string
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
  /** epoch ms — when Darryl last evaluated this ticket. */
  lastEvaluatedAt?: number
  /** Snoozed-until (epoch ms). While in the future, the popup hides it. */
  postponedUntil?: number
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
  logo?: string
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
  clickupListIds: string[]
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
  /** Transient dispatch/launch failure surfaced as a banner (delegation confirm,
   *  "start work"). Null when there's nothing to show. */
  dispatchError: string | null
  dismissDispatchError: () => void
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
  const [clickupListIds, setClickupListIds] = useState<string[]>([])
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
  const [dispatchError, setDispatchError] = useState<string | null>(null)

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
    // Per-effect scratch state shared across handlers: agents buffered from
    // `existingAgents` until layout builds seats, plus seat metadata cached
    // from the server. Held on `ctx` so the extracted handlers can read/replace
    // it exactly like the old closure locals did.
    const buffer: MessageBuffer = { pendingAgents: [], cachedMeta: {} }
    const ctx: HandlerCtx = {
      getOfficeState,
      buffer,
      layoutReadyRef,
      knownProjectsRef,
      offlineAgentsRef,
      setAgents,
      setSelectedAgent,
      setAgentTools,
      setAgentStatuses,
      setSubagentTools,
      setSubagentCharacters,
      setLayoutReady,
      setLoadedAssets,
      setWorkspaceFolders,
      setAgentConversation,
      setOfflineAgents,
      setKnownProjects,
      setClickupTickets,
      setClickupConfigured,
      setClickupListIds,
      setClickupNextFetchAt,
      setActiveConference,
      setPeersBrokerAvailable,
      setWorkers,
      setOrganogram,
      setJanDesignConfig,
      setBuildings,
      setActiveBuildingId,
      setProjectMemberships,
      setPendingWorkers,
      setIdentityPrompt,
      setAutoMode,
      setPendingDelegations,
      setDispatchError,
    }

    // Expose saveAgentMeta / forgetAgent to callbacks outside this closure.
    saveAgentMetaRef.current = () => runSaveAgentMeta(ctx)
    forgetAgentRef.current = (sessionId: string) => {
      delete ctx.buffer.cachedMeta[sessionId]
      vscode.postMessage({ type: 'forgetAgent', sessionId })
    }

    const handler = (e: MessageEvent) => {
      dispatchMessage(e.data as Record<string, unknown>, ctx)
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
  const dismissDispatchError = useCallback(() => setDispatchError(null), [])

  return { agents, selectedAgent, selectAgent: setSelectedAgent, agentTools, agentStatuses, subagentTools, subagentCharacters, layoutReady, loadedAssets, workspaceFolders, agentConversation, offlineAgents, knownProjects, saveAgentMeta, forgetAgent, clickupTickets, clickupConfigured, clickupListIds, clickupNextFetchAt, activeConference, peersBrokerAvailable, workers, organogram, janDesignConfig, buildings, activeBuildingId, projectMemberships, pendingWorkers, dismissPendingWorker, identityPrompt, dismissIdentityPrompt, autoMode, pendingDelegations, dispatchError, dismissDispatchError }
}
