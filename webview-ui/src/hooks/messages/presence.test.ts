import { describe, it, expect } from 'vitest'
import {
  handleConferenceStarted,
  handleConferenceEnded,
  handlePeersBrokerStatus,
  handleWorkerStatus,
  handleNewWorkerIdentified,
  handleAgentIdentityPrompt,
} from './presence.js'
import { makeCtx, resolveSet } from './__testHelpers.js'
import type { PendingWorker } from '../useExtensionMessages.js'

describe('presence handlers', () => {
  it('conferenceStarted stores the conference tuple', () => {
    const { ctx } = makeCtx()
    handleConferenceStarted({ type: 'conferenceStarted', conferenceId: 'c1', agent1Id: 'a', agent2Id: 'b', topic: 't' }, ctx)
    expect(ctx.setActiveConference).toHaveBeenCalledWith({ conferenceId: 'c1', agent1Id: 'a', agent2Id: 'b', topic: 't' })
  })

  it('conferenceEnded clears it', () => {
    const { ctx } = makeCtx()
    handleConferenceEnded({ type: 'conferenceEnded' }, ctx)
    expect(ctx.setActiveConference).toHaveBeenCalledWith(null)
  })

  it('peersBrokerStatus maps availability', () => {
    const { ctx } = makeCtx()
    handlePeersBrokerStatus({ type: 'peersBrokerStatus', available: true }, ctx)
    expect(ctx.setPeersBrokerAvailable).toHaveBeenCalledWith(true)
  })

  it('workerStatus forwards the worker list', () => {
    const { ctx } = makeCtx()
    const workers = [{ name: 'W', color: '#fff', hostname: 'h', status: 'idle', ticketId: null, ticketName: null, isHub: true }]
    handleWorkerStatus({ type: 'workerStatus', workers }, ctx)
    expect(ctx.setWorkers).toHaveBeenCalledWith(workers)
  })

  it('newWorkerIdentified builds a PendingWorker and de-dupes by sessionId', () => {
    const { ctx } = makeCtx()
    handleNewWorkerIdentified({ type: 'newWorkerIdentified', sessionId: 's1', provisionalAgentId: 'p1', provisionalName: 'Bob', reassign: true }, ctx)
    const prev: PendingWorker[] = [{ sessionId: 's1', provisionalAgentId: 'old', provisionalName: 'Old', candidates: [] }]
    const next = resolveSet(ctx.setPendingWorkers, prev)
    expect(next).toHaveLength(1)
    expect(next[0]).toMatchObject({ sessionId: 's1', provisionalAgentId: 'p1', provisionalName: 'Bob', reassign: true })
  })

  it('agentIdentityPrompt stores the prompt payload', () => {
    const { ctx } = makeCtx()
    handleAgentIdentityPrompt({ type: 'agentIdentityPrompt', sessionId: 's', agentId: 'a', name: 'N', prompt: 'P' }, ctx)
    expect(ctx.setIdentityPrompt).toHaveBeenCalledWith({ sessionId: 's', agentId: 'a', name: 'N', roleShort: undefined, prompt: 'P' })
  })
})
