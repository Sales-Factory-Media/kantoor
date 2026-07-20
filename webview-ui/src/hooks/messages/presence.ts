/**
 * Presence-domain message handlers: peer conferences, the claude-peers broker,
 * remote-worker status, and the "who's this?" identification popups.
 */

import type { WorkerStatusEntry, PendingWorker, IdentifyCandidate } from '../useExtensionMessages.js'
import type { HandlerCtx } from './ctx.js'

export function handleConferenceStarted(msg: Record<string, unknown>, ctx: HandlerCtx): void {
  ctx.setActiveConference({
    conferenceId: msg.conferenceId as string,
    agent1Id: msg.agent1Id as string,
    agent2Id: msg.agent2Id as string,
    topic: msg.topic as string,
  })
}

export function handleConferenceEnded(_msg: Record<string, unknown>, ctx: HandlerCtx): void {
  ctx.setActiveConference(null)
}

export function handlePeersBrokerStatus(msg: Record<string, unknown>, ctx: HandlerCtx): void {
  ctx.setPeersBrokerAvailable(msg.available as boolean)
}

export function handleWorkerStatus(msg: Record<string, unknown>, ctx: HandlerCtx): void {
  ctx.setWorkers(msg.workers as WorkerStatusEntry[])
}

export function handleNewWorkerIdentified(msg: Record<string, unknown>, ctx: HandlerCtx): void {
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
  ctx.setPendingWorkers((prev) => {
    const rest = prev.filter((w) => w.sessionId !== worker.sessionId)
    return [...rest, worker]
  })
}

export function handleAgentIdentityPrompt(msg: Record<string, unknown>, ctx: HandlerCtx): void {
  ctx.setIdentityPrompt({
    sessionId: msg.sessionId as string,
    agentId: msg.agentId as string,
    name: msg.name as string,
    roleShort: msg.roleShort as string | undefined,
    prompt: msg.prompt as string,
  })
}
