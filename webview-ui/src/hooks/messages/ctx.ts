/**
 * Shared context for WebSocket message handlers.
 *
 * `useExtensionMessages` used to be one ~850-line `useEffect` with a 49-branch
 * `if/else`. That logic now lives in small `(msg, ctx) => void` handlers grouped
 * by domain (agents / world / tickets / presence). The hook builds a `HandlerCtx`
 * — every setter, the shared refs, and the per-effect mutable buffer — and routes
 * each message through the registry in `./index.ts`.
 *
 * Extracting `ctx` is what makes the handlers unit-testable: a test builds a mock
 * ctx (vi.fn() setters + a stub OfficeState + a fresh buffer), calls the handler,
 * and asserts. See the `*.test.ts` files next to each handler module.
 */

import type { OfficeState } from '../../office/engine/officeState.js'
import type { ToolActivity, ConversationEntry } from '../../office/types.js'
import { FurnitureType } from '../../office/types.js'
import { vscode } from '../../vscodeApi.js'
import type {
  SubagentCharacter,
  FurnitureAsset,
  WorkspaceFolder,
  OfflineAgent,
  KnownProject,
  PendingWorker,
  PendingDelegation,
  IdentityPrompt,
  WorkerStatusEntry,
  OrganogramPayload,
  JanDesignConfig,
  BuildingSummary,
  ProjectMembershipEntry,
  ClickUpStatusGroup,
} from '../useExtensionMessages.js'

/** Setter shape compatible with both `useState` and `useBatchedState`. */
export type Setter<T> = (updater: T | ((prev: T) => T)) => void

/** Character metadata cached from seats.json, keyed by sessionId. */
export type SeatMeta = {
  name?: string
  palette?: number
  hueShift?: number
  seatId?: string
  roleShort?: string
  roleFull?: string
  workspacePath?: string
  persistentAgentId?: string
  carType?: string
  avatarConfig?: string
  sessionCount?: number
  lastSessionEnd?: string
}

/** An agent buffered from `existingAgents` until `layoutLoaded` builds seats. */
export type PendingAgentEntry = {
  id: number
  palette?: number
  hueShift?: number
  seatId?: string
  name?: string
  sessionId?: string
  folderName?: string
  roleShort?: string
  roleFull?: string
  workspacePath?: string
  persistentAgentId?: string
  carType?: string
  avatarConfig?: string
  sessionCount?: number
  lastSessionEnd?: string
  taskTitle?: string
}

/**
 * Per-effect mutable state that several handlers share. Held on the ctx so the
 * extracted handlers can read/replace it exactly like the old closure locals.
 */
export interface MessageBuffer {
  pendingAgents: PendingAgentEntry[]
  cachedMeta: Record<string, SeatMeta>
}

/** A minimal `{ current }` cell — matches a React ref without importing its type. */
export interface RefCell<T> {
  current: T
}

/**
 * Everything a message handler needs. Built once per effect run by the hook.
 * Setters and refs are the live React ones; `buffer` is the mutable per-effect
 * scratch state; `getOfficeState` returns the singleton imperative world.
 */
export interface HandlerCtx {
  getOfficeState: () => OfficeState
  buffer: MessageBuffer
  layoutReadyRef: RefCell<boolean>
  knownProjectsRef: RefCell<KnownProject[]>
  offlineAgentsRef: RefCell<OfflineAgent[]>

  setAgents: Setter<number[]>
  setSelectedAgent: Setter<number | null>
  setAgentTools: Setter<Record<number, ToolActivity[]>>
  setAgentStatuses: Setter<Record<number, string>>
  setSubagentTools: Setter<Record<number, Record<string, ToolActivity[]>>>
  setSubagentCharacters: Setter<SubagentCharacter[]>
  setLayoutReady: Setter<boolean>
  setLoadedAssets: Setter<{ catalog: FurnitureAsset[]; sprites: Record<string, string[][]> } | undefined>
  setWorkspaceFolders: Setter<WorkspaceFolder[]>
  setAgentConversation: Setter<Record<number, ConversationEntry[]>>
  setOfflineAgents: Setter<OfflineAgent[]>
  setKnownProjects: Setter<KnownProject[]>
  setClickupTickets: Setter<ClickUpStatusGroup[]>
  setClickupConfigured: Setter<boolean>
  setClickupListIds: Setter<string[]>
  setClickupNextFetchAt: Setter<number | null>
  setActiveConference: Setter<{ conferenceId: string; agent1Id: string; agent2Id: string; topic: string } | null>
  setPeersBrokerAvailable: Setter<boolean>
  setWorkers: Setter<WorkerStatusEntry[]>
  setOrganogram: Setter<OrganogramPayload | null>
  setJanDesignConfig: Setter<JanDesignConfig | null>
  setBuildings: Setter<BuildingSummary[]>
  setActiveBuildingId: Setter<string | null>
  setProjectMemberships: Setter<ProjectMembershipEntry[]>
  setPendingWorkers: Setter<PendingWorker[]>
  setIdentityPrompt: Setter<IdentityPrompt | null>
  setAutoMode: Setter<boolean>
  setPendingDelegations: Setter<PendingDelegation[]>
  setDispatchError: Setter<string | null>
}

/** A single message handler. Message shapes are `any`-ish over the wire. */
export type MessageHandler = (msg: Record<string, unknown>, ctx: HandlerCtx) => void

const CAR_TYPES = [
  FurnitureType.CAR_SEDAN, FurnitureType.CAR_SPORT, FurnitureType.CAR_SUV,
  FurnitureType.CAR_PICKUP, FurnitureType.CAR_COUPE, FurnitureType.CAR_SUPERCAR,
]

export function pickRandomCarType(): string {
  return CAR_TYPES[Math.floor(Math.random() * CAR_TYPES.length)]
}

/**
 * Save all non-sub-agent character metadata (keyed by sessionId), merged over
 * the cached meta so offline agents keep their data. Posts `saveAgentSeats`.
 * Mutates `ctx.buffer.cachedMeta`.
 */
export function saveAgentMeta(ctx: HandlerCtx): void {
  const os = ctx.getOfficeState()
  const seats: Record<string, SeatMeta> = {}
  for (const ch of os.characters.values()) {
    if (ch.isSubagent || !ch.sessionId) continue
    seats[ch.sessionId] = {
      name: ch.name,
      palette: ch.palette,
      hueShift: ch.hueShift,
      seatId: ch.seatId ?? undefined,
      roleShort: ch.roleShort,
      roleFull: ch.roleFull,
      workspacePath: ch.workspacePath,
      persistentAgentId: ch.persistentAgentId,
      carType: ch.carType,
      avatarConfig: ch.avatarConfig,
    }
  }
  const merged = { ...ctx.buffer.cachedMeta, ...seats }
  ctx.buffer.cachedMeta = merged
  vscode.postMessage({ type: 'saveAgentSeats', seats: merged })
}
