/**
 * Message-handler registry. Maps each WebSocket `msg.type` to its handler.
 * `useExtensionMessages` looks a message up here and dispatches; unknown types
 * are ignored (same as the old `if/else` chain falling through).
 */

import type { HandlerCtx, MessageHandler } from './ctx.js'
import * as agents from './agents.js'
import * as world from './world.js'
import * as tickets from './tickets.js'
import * as presence from './presence.js'

export const messageHandlers: Record<string, MessageHandler> = {
  // ── Agents ──
  agentCreated: agents.handleAgentCreated,
  agentClosed: agents.handleAgentClosed,
  existingAgents: agents.handleExistingAgents,
  agentToolStart: agents.handleAgentToolStart,
  agentToolDone: agents.handleAgentToolDone,
  agentToolsClear: agents.handleAgentToolsClear,
  agentSelected: agents.handleAgentSelected,
  agentStatus: agents.handleAgentStatus,
  agentToolPermission: agents.handleAgentToolPermission,
  subagentToolPermission: agents.handleSubagentToolPermission,
  agentToolPermissionClear: agents.handleAgentToolPermissionClear,
  agentConference: agents.handleAgentConference,
  subagentToolStart: agents.handleSubagentToolStart,
  subagentToolDone: agents.handleSubagentToolDone,
  subagentClear: agents.handleSubagentClear,
  agentConversation: agents.handleAgentConversation,
  agentConversationHistory: agents.handleAgentConversationHistory,
  agentIdentitySaved: agents.handleAgentIdentitySaved,
  agentReidentified: agents.handleAgentReidentified,

  // ── World / layout / buildings ──
  offlineAgents: world.handleOfflineAgents,
  organogramSnapshot: world.handleOrganogramSnapshot,
  knownProjects: world.handleKnownProjects,
  layoutLoaded: world.handleLayoutLoaded,
  characterSpritesLoaded: world.handleCharacterSpritesLoaded,
  floorTilesLoaded: world.handleFloorTilesLoaded,
  wallTilesLoaded: world.handleWallTilesLoaded,
  workspaceFolders: world.handleWorkspaceFolders,
  settingsLoaded: world.handleSettingsLoaded,
  janDesignConfigLoaded: world.handleJanDesignConfigLoaded,
  furnitureAssetsLoaded: world.handleFurnitureAssetsLoaded,
  buildingsList: world.handleBuildingsList,
  buildingSwitched: world.handleBuildingSwitched,
  buildingConfigured: world.handleBuildingConfigured,
  buildingCreateError: world.handleBuildingCreateError,
  seatsLoaded: world.handleSeatsLoaded,
  projectsList: world.handleProjectsList,

  // ── Tickets / delegation ──
  clickupTickets: tickets.handleClickupTickets,
  clickupConfigured: tickets.handleClickupConfigured,
  clickupError: tickets.handleClickupError,
  delegationError: tickets.handleDispatchError,
  clickupStartWorkError: tickets.handleDispatchError,
  autoModeLoaded: tickets.handleAutoModeLoaded,
  delegationPending: tickets.handleDelegationPending,

  // ── Presence / identity ──
  conferenceStarted: presence.handleConferenceStarted,
  conferenceEnded: presence.handleConferenceEnded,
  peersBrokerStatus: presence.handlePeersBrokerStatus,
  workerStatus: presence.handleWorkerStatus,
  newWorkerIdentified: presence.handleNewWorkerIdentified,
  agentIdentityPrompt: presence.handleAgentIdentityPrompt,
}

/** Route one message to its handler, if any. Unknown types are ignored. */
export function dispatchMessage(msg: Record<string, unknown>, ctx: HandlerCtx): void {
  const handler = messageHandlers[msg.type as string]
  if (handler) handler(msg, ctx)
}
