import { vi } from 'vitest'
import type { OfficeState } from '../../office/engine/officeState.js'
import type { HandlerCtx } from './ctx.js'

/** A minimal mutable stand-in for a canvas Character. */
export interface FakeCharacter {
  id: number
  sessionId?: string
  isSubagent?: boolean
  name?: string
  roleShort?: string
  roleFull?: string
  workspacePath?: string
  persistentAgentId?: string
  palette?: number
  hueShift?: number
  carType?: string
  avatarConfig?: string
  seatId?: string | null
  sessionCount?: number
  lastSessionEnd?: string
  taskTitle?: string
}

export function makeCharacter(id: number, extra: Partial<FakeCharacter> = {}): FakeCharacter {
  return { id, ...extra }
}

/** A stub OfficeState: real Maps for characters/subagentMeta, vi.fn() methods. */
export function makeOfficeStateStub() {
  const characters = new Map<number, FakeCharacter>()
  const subagentMeta = new Map<number, { parentAgentId: number }>()
  return {
    characters,
    subagentMeta,
    addAgent: vi.fn(),
    removeAgent: vi.fn(),
    removeAllSubagents: vi.fn(),
    removeSubagent: vi.fn(),
    addSubagent: vi.fn((): number => -1),
    regenerateRoomLayout: vi.fn(),
    setAgentTool: vi.fn(),
    setAgentActive: vi.fn(),
    clearPermissionBubble: vi.fn(),
    showPermissionBubble: vi.fn(),
    showWaitingBubble: vi.fn(),
    getSubagentId: vi.fn((): number | null => null),
    sendToConference: vi.fn(),
    regroupCharacterUnderEmployee: vi.fn(),
  }
}

export type OfficeStateStub = ReturnType<typeof makeOfficeStateStub>

/** Build a HandlerCtx whose setters are vi.fn() and whose os is a stub. */
export function makeCtx(os: OfficeStateStub = makeOfficeStateStub()) {
  const ctx: HandlerCtx = {
    getOfficeState: () => os as unknown as OfficeState,
    buffer: { pendingAgents: [], cachedMeta: {} },
    layoutReadyRef: { current: false },
    knownProjectsRef: { current: [] },
    offlineAgentsRef: { current: [] },
    setAgents: vi.fn(),
    setSelectedAgent: vi.fn(),
    setAgentTools: vi.fn(),
    setAgentStatuses: vi.fn(),
    setSubagentTools: vi.fn(),
    setSubagentCharacters: vi.fn(),
    setLayoutReady: vi.fn(),
    setLoadedAssets: vi.fn(),
    setWorkspaceFolders: vi.fn(),
    setAgentConversation: vi.fn(),
    setOfflineAgents: vi.fn(),
    setKnownProjects: vi.fn(),
    setClickupTickets: vi.fn(),
    setClickupConfigured: vi.fn(),
    setClickupListIds: vi.fn(),
    setClickupNextFetchAt: vi.fn(),
    setActiveConference: vi.fn(),
    setPeersBrokerAvailable: vi.fn(),
    setWorkers: vi.fn(),
    setOrganogram: vi.fn(),
    setJanDesignConfig: vi.fn(),
    setBuildings: vi.fn(),
    setActiveBuildingId: vi.fn(),
    setProjectMemberships: vi.fn(),
    setPendingWorkers: vi.fn(),
    setIdentityPrompt: vi.fn(),
    setAutoMode: vi.fn(),
    setPendingDelegations: vi.fn(),
    setDispatchError: vi.fn(),
  }
  return { ctx, os }
}

/**
 * Resolve a setter's last call to a concrete value: if it was called with a
 * functional updater, invoke it against `prev`; otherwise return the raw value.
 */
export function resolveSet<T>(setter: unknown, prev: T): T {
  const mock = setter as unknown as { mock: { calls: unknown[][] } }
  const last = mock.mock.calls[mock.mock.calls.length - 1][0]
  return typeof last === 'function' ? (last as (p: T) => T)(prev) : (last as T)
}
