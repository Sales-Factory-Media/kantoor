/**
 * World-domain message handlers: office layout & assets, floor/wall/character
 * sprites, building switching, projects, seats, known projects, org chart, and
 * misc global settings.
 */

import { buildDynamicCatalog } from '../../office/layout/furnitureCatalog.js'
import { setFloorSprites } from '../../office/floorTiles.js'
import { setWallSprites } from '../../office/wallTiles.js'
import { setCharacterTemplates } from '../../office/sprites/spriteData.js'
import { setSoundEnabled } from '../../notificationSound.js'
import { vscode } from '../../vscodeApi.js'
import type {
  FurnitureAsset,
  WorkspaceFolder,
  KnownProject,
  OfflineAgent,
  OrganogramPayload,
  JanDesignConfig,
  BuildingSummary,
  ProjectMembershipEntry,
} from '../useExtensionMessages.js'
import { type HandlerCtx, type SeatMeta, pickRandomCarType, saveAgentMeta } from './ctx.js'

export function handleOfflineAgents(msg: Record<string, unknown>, ctx: HandlerCtx): void {
  const os = ctx.getOfficeState()
  const incoming = msg.agents as OfflineAgent[]
  ctx.offlineAgentsRef.current = incoming
  ctx.setOfflineAgents(incoming)
  if (ctx.layoutReadyRef.current) {
    os.regenerateRoomLayout(ctx.knownProjectsRef.current, incoming)
  }
}

export function handleOrganogramSnapshot(msg: Record<string, unknown>, ctx: HandlerCtx): void {
  ctx.setOrganogram(msg.organogram as OrganogramPayload)
}

export function handleKnownProjects(msg: Record<string, unknown>, ctx: HandlerCtx): void {
  const os = ctx.getOfficeState()
  const projects = msg.projects as KnownProject[]
  ctx.knownProjectsRef.current = projects
  ctx.setKnownProjects(projects)
  if (ctx.layoutReadyRef.current) {
    os.regenerateRoomLayout(projects, ctx.offlineAgentsRef.current)
  }
}

export function handleLayoutLoaded(_msg: Record<string, unknown>, ctx: HandlerCtx): void {
  const os = ctx.getOfficeState()
  // Generate room layout from known projects and buffered agents
  // First add buffered agents so their project names are counted
  for (const p of ctx.buffer.pendingAgents) {
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
  ctx.buffer.pendingAgents = []
  os.regenerateRoomLayout(ctx.knownProjectsRef.current, ctx.offlineAgentsRef.current)
  saveAgentMeta(ctx)
  ctx.layoutReadyRef.current = true
  ctx.setLayoutReady(true)
}

export function handleCharacterSpritesLoaded(msg: Record<string, unknown>, _ctx: HandlerCtx): void {
  const characters = msg.characters as Array<{ down: string[][][]; up: string[][][]; right: string[][][] }>
  console.log(`[Webview] Received ${characters.length} pre-colored character sprites`)
  setCharacterTemplates(characters)
}

export function handleFloorTilesLoaded(msg: Record<string, unknown>, _ctx: HandlerCtx): void {
  const sprites = msg.sprites as string[][][]
  console.log(`[Webview] Received ${sprites.length} floor tile patterns`)
  setFloorSprites(sprites)
}

export function handleWallTilesLoaded(msg: Record<string, unknown>, _ctx: HandlerCtx): void {
  const sprites = msg.sprites as string[][][]
  console.log(`[Webview] Received ${sprites.length} wall tile sprites`)
  setWallSprites(sprites)
}

export function handleWorkspaceFolders(msg: Record<string, unknown>, ctx: HandlerCtx): void {
  const folders = msg.folders as WorkspaceFolder[]
  ctx.setWorkspaceFolders(folders)
}

export function handleSettingsLoaded(msg: Record<string, unknown>, _ctx: HandlerCtx): void {
  const soundOn = msg.soundEnabled as boolean
  setSoundEnabled(soundOn)
}

export function handleJanDesignConfigLoaded(msg: Record<string, unknown>, ctx: HandlerCtx): void {
  ctx.setJanDesignConfig(msg.config as JanDesignConfig)
}

export function handleFurnitureAssetsLoaded(msg: Record<string, unknown>, ctx: HandlerCtx): void {
  try {
    const catalog = msg.catalog as FurnitureAsset[]
    const sprites = msg.sprites as Record<string, string[][]>
    console.log(`📦 Webview: Loaded ${catalog.length} furniture assets`)
    // Build dynamic catalog immediately so getCatalogEntry() works when layoutLoaded arrives next
    buildDynamicCatalog({ catalog, sprites })
    ctx.setLoadedAssets({ catalog, sprites })
  } catch (err) {
    console.error(`❌ Webview: Error processing furnitureAssetsLoaded:`, err)
  }
}

export function handleBuildingsList(msg: Record<string, unknown>, ctx: HandlerCtx): void {
  ctx.setBuildings(msg.buildings as BuildingSummary[])
  ctx.setActiveBuildingId(msg.activeBuildingId as string | null)
}

export function handleBuildingSwitched(msg: Record<string, unknown>, ctx: HandlerCtx): void {
  // Hot-swap: server is about to send fresh state for the new building.
  // Drop all live characters/agents so the office repopulates cleanly.
  const building = msg.building as BuildingSummary
  ctx.setActiveBuildingId(building.id)
  const os = ctx.getOfficeState()
  os.characters.clear()
  ctx.setAgents([])
  ctx.setSelectedAgent(null)
  ctx.setAgentTools({})
  ctx.setAgentStatuses({})
  ctx.setSubagentTools({})
  ctx.setSubagentCharacters([])
  ctx.setClickupTickets([])
  ctx.setClickupNextFetchAt(null)
  ctx.layoutReadyRef.current = false
  ctx.setLayoutReady(false)
  // The server will resend organogram/knownProjects/offlineAgents/etc.
  // immediately after this message; the existing handlers pick those up.
}

export function handleBuildingConfigured(_msg: Record<string, unknown>, _ctx: HandlerCtx): void {
  // Server has merged a new connector config; just refresh the building
  // list so the dropdown's "configured" badge updates.
  vscode.postMessage({ type: 'listBuildings' })
}

export function handleBuildingCreateError(msg: Record<string, unknown>, _ctx: HandlerCtx): void {
  console.error('[Buildings] create failed:', msg.error)
}

export function handleSeatsLoaded(msg: Record<string, unknown>, ctx: HandlerCtx): void {
  // Sent during a building switch — replaces cached seat metadata so
  // characters that come back online get the new building's seats.
  ctx.buffer.cachedMeta = (msg.seats as Record<string, SeatMeta>) ?? {}
}

export function handleProjectsList(msg: Record<string, unknown>, ctx: HandlerCtx): void {
  ctx.setProjectMemberships(msg.projects as ProjectMembershipEntry[])
}
