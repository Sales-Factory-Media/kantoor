import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../vscodeApi.js', () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock('../../notificationSound.js', () => ({ setSoundEnabled: vi.fn() }))
vi.mock('../../office/layout/furnitureCatalog.js', () => ({ buildDynamicCatalog: vi.fn() }))
vi.mock('../../office/floorTiles.js', () => ({ setFloorSprites: vi.fn() }))
vi.mock('../../office/wallTiles.js', () => ({ setWallSprites: vi.fn() }))
vi.mock('../../office/sprites/spriteData.js', () => ({ setCharacterTemplates: vi.fn() }))

import { vscode } from '../../vscodeApi.js'
import { setSoundEnabled } from '../../notificationSound.js'
import { buildDynamicCatalog } from '../../office/layout/furnitureCatalog.js'
import { setFloorSprites } from '../../office/floorTiles.js'
import { setWallSprites } from '../../office/wallTiles.js'
import { setCharacterTemplates } from '../../office/sprites/spriteData.js'
import {
  handleOfflineAgents,
  handleOrganogramSnapshot,
  handleKnownProjects,
  handleLayoutLoaded,
  handleCharacterSpritesLoaded,
  handleFloorTilesLoaded,
  handleWallTilesLoaded,
  handleWorkspaceFolders,
  handleSettingsLoaded,
  handleJanDesignConfigLoaded,
  handleFurnitureAssetsLoaded,
  handleBuildingsList,
  handleBuildingSwitched,
  handleBuildingConfigured,
  handleBuildingCreateError,
  handleSeatsLoaded,
  handleProjectsList,
} from './world.js'
import { makeCtx, makeCharacter } from './__testHelpers.js'

beforeEach(() => vi.clearAllMocks())

describe('world: agents/projects/org', () => {
  it('offlineAgents stores incoming, updates ref, and regenerates when layout ready', () => {
    const { ctx, os } = makeCtx()
    ctx.layoutReadyRef.current = true
    const agents = [{ sessionId: 's1', name: 'A' }]
    handleOfflineAgents({ type: 'offlineAgents', agents }, ctx)
    expect(ctx.setOfflineAgents).toHaveBeenCalledWith(agents)
    expect(ctx.offlineAgentsRef.current).toBe(agents)
    expect(os.regenerateRoomLayout).toHaveBeenCalledWith(ctx.knownProjectsRef.current, agents)
  })

  it('offlineAgents does not regenerate before layout is ready', () => {
    const { ctx, os } = makeCtx()
    handleOfflineAgents({ type: 'offlineAgents', agents: [] }, ctx)
    expect(os.regenerateRoomLayout).not.toHaveBeenCalled()
  })

  it('organogramSnapshot stores the org payload', () => {
    const { ctx } = makeCtx()
    const organogram = { nodes: [] }
    handleOrganogramSnapshot({ type: 'organogramSnapshot', organogram }, ctx)
    expect(ctx.setOrganogram).toHaveBeenCalledWith(organogram)
  })

  it('knownProjects stores, updates ref, regenerates when ready', () => {
    const { ctx, os } = makeCtx()
    ctx.layoutReadyRef.current = true
    const projects = [{ name: 'p', workspacePath: '/p' }]
    handleKnownProjects({ type: 'knownProjects', projects }, ctx)
    expect(ctx.setKnownProjects).toHaveBeenCalledWith(projects)
    expect(ctx.knownProjectsRef.current).toBe(projects)
    expect(os.regenerateRoomLayout).toHaveBeenCalledWith(projects, ctx.offlineAgentsRef.current)
  })

  it('projectsList forwards membership entries', () => {
    const { ctx } = makeCtx()
    const projects = [{ id: 1, name: 'p', workspacePath: '/p', belongsToActive: true }]
    handleProjectsList({ type: 'projectsList', projects }, ctx)
    expect(ctx.setProjectMemberships).toHaveBeenCalledWith(projects)
  })
})

describe('world: layout + assets', () => {
  it('layoutLoaded flushes buffered agents, marks ready, saves meta', () => {
    const { ctx, os } = makeCtx()
    os.addAgent.mockImplementation((id: number) => os.characters.set(id, makeCharacter(id, { sessionId: `s${id}` })))
    ctx.buffer.pendingAgents = [{ id: 1, roleShort: 'Dev' }]
    handleLayoutLoaded({ type: 'layoutLoaded' }, ctx)
    expect(os.addAgent).toHaveBeenCalled()
    expect(os.characters.get(1)?.roleShort).toBe('Dev')
    expect(ctx.buffer.pendingAgents).toEqual([])
    expect(ctx.layoutReadyRef.current).toBe(true)
    expect(ctx.setLayoutReady).toHaveBeenCalledWith(true)
    expect(vscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'saveAgentSeats' }))
  })

  it('characterSpritesLoaded pushes templates', () => {
    const { ctx } = makeCtx()
    handleCharacterSpritesLoaded({ type: 'characterSpritesLoaded', characters: [] }, ctx)
    expect(setCharacterTemplates).toHaveBeenCalledWith([])
  })

  it('floorTilesLoaded / wallTilesLoaded push sprites', () => {
    const { ctx } = makeCtx()
    handleFloorTilesLoaded({ type: 'floorTilesLoaded', sprites: [] }, ctx)
    handleWallTilesLoaded({ type: 'wallTilesLoaded', sprites: [] }, ctx)
    expect(setFloorSprites).toHaveBeenCalled()
    expect(setWallSprites).toHaveBeenCalled()
  })

  it('furnitureAssetsLoaded builds the catalog and stores assets', () => {
    const { ctx } = makeCtx()
    const catalog = [{ id: 'x' }]
    const sprites = {}
    handleFurnitureAssetsLoaded({ type: 'furnitureAssetsLoaded', catalog, sprites }, ctx)
    expect(buildDynamicCatalog).toHaveBeenCalledWith({ catalog, sprites })
    expect(ctx.setLoadedAssets).toHaveBeenCalledWith({ catalog, sprites })
  })

  it('workspaceFolders / settingsLoaded / janDesignConfigLoaded', () => {
    const { ctx } = makeCtx()
    handleWorkspaceFolders({ type: 'workspaceFolders', folders: [{ name: 'f', path: '/f' }] }, ctx)
    expect(ctx.setWorkspaceFolders).toHaveBeenCalled()
    handleSettingsLoaded({ type: 'settingsLoaded', soundEnabled: true }, ctx)
    expect(setSoundEnabled).toHaveBeenCalledWith(true)
    const config = { figmaUrl: 'a', clickupDocUrl: 'b', examplesUrl: 'c' }
    handleJanDesignConfigLoaded({ type: 'janDesignConfigLoaded', config }, ctx)
    expect(ctx.setJanDesignConfig).toHaveBeenCalledWith(config)
  })
})

describe('world: buildings', () => {
  it('buildingsList sets buildings + active id', () => {
    const { ctx } = makeCtx()
    handleBuildingsList({ type: 'buildingsList', buildings: [], activeBuildingId: 'b1' }, ctx)
    expect(ctx.setBuildings).toHaveBeenCalledWith([])
    expect(ctx.setActiveBuildingId).toHaveBeenCalledWith('b1')
  })

  it('buildingSwitched clears live state and resets layout readiness', () => {
    const { ctx, os } = makeCtx()
    os.characters.set(1, makeCharacter(1))
    ctx.layoutReadyRef.current = true
    handleBuildingSwitched({ type: 'buildingSwitched', building: { id: 'b2' } }, ctx)
    expect(ctx.setActiveBuildingId).toHaveBeenCalledWith('b2')
    expect(os.characters.size).toBe(0)
    expect(ctx.setAgents).toHaveBeenCalledWith([])
    expect(ctx.setClickupTickets).toHaveBeenCalledWith([])
    expect(ctx.layoutReadyRef.current).toBe(false)
    expect(ctx.setLayoutReady).toHaveBeenCalledWith(false)
  })

  it('buildingConfigured asks the hub to refresh the building list', () => {
    const { ctx } = makeCtx()
    handleBuildingConfigured({ type: 'buildingConfigured' }, ctx)
    expect(vscode.postMessage).toHaveBeenCalledWith({ type: 'listBuildings' })
  })

  it('buildingCreateError logs without throwing', () => {
    const { ctx } = makeCtx()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => handleBuildingCreateError({ type: 'buildingCreateError', error: 'x' }, ctx)).not.toThrow()
    spy.mockRestore()
  })

  it('seatsLoaded replaces the cached meta buffer', () => {
    const { ctx } = makeCtx()
    ctx.buffer.cachedMeta = { old: { name: 'old' } }
    handleSeatsLoaded({ type: 'seatsLoaded', seats: { s1: { name: 'new' } } }, ctx)
    expect(ctx.buffer.cachedMeta).toEqual({ s1: { name: 'new' } })
  })

  it('seatsLoaded defaults to empty when seats missing', () => {
    const { ctx } = makeCtx()
    ctx.buffer.cachedMeta = { old: {} }
    handleSeatsLoaded({ type: 'seatsLoaded' }, ctx)
    expect(ctx.buffer.cachedMeta).toEqual({})
  })
})
