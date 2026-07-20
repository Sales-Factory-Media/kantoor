import { describe, it, expect, vi } from 'vitest'
import {
  handleClickupTickets,
  handleClickupConfigured,
  handleClickupError,
  handleDispatchError,
  handleAutoModeLoaded,
  handleDelegationPending,
} from './tickets.js'
import { makeCtx, resolveSet } from './__testHelpers.js'

describe('ticket handlers', () => {
  it('clickupTickets sets tickets and nextFetchAt when present', () => {
    const { ctx } = makeCtx()
    const statuses = [{ name: 'to do', color: '#fff', tasks: [] }]
    handleClickupTickets({ type: 'clickupTickets', statuses, nextFetchAt: 123 }, ctx)
    expect(ctx.setClickupTickets).toHaveBeenCalledWith(statuses)
    expect(ctx.setClickupNextFetchAt).toHaveBeenCalledWith(123)
  })

  it('clickupTickets skips nextFetchAt when null/absent', () => {
    const { ctx } = makeCtx()
    handleClickupTickets({ type: 'clickupTickets', statuses: [], nextFetchAt: null }, ctx)
    expect(ctx.setClickupNextFetchAt).not.toHaveBeenCalled()
  })

  it('clickupConfigured sets configured + listIds array', () => {
    const { ctx } = makeCtx()
    handleClickupConfigured({ type: 'clickupConfigured', configured: true, listIds: ['a', 'b'] }, ctx)
    expect(ctx.setClickupConfigured).toHaveBeenCalledWith(true)
    expect(ctx.setClickupListIds).toHaveBeenCalledWith(['a', 'b'])
  })

  it('clickupConfigured ignores non-array listIds', () => {
    const { ctx } = makeCtx()
    handleClickupConfigured({ type: 'clickupConfigured', configured: false }, ctx)
    expect(ctx.setClickupConfigured).toHaveBeenCalledWith(false)
    expect(ctx.setClickupListIds).not.toHaveBeenCalled()
  })

  it('clickupError logs and touches no state', () => {
    const { ctx } = makeCtx()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    handleClickupError({ type: 'clickupError', error: 'boom' }, ctx)
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('dispatchError surfaces the error string', () => {
    const { ctx } = makeCtx()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    handleDispatchError({ type: 'delegationError', error: 'no worker' }, ctx)
    expect(ctx.setDispatchError).toHaveBeenCalledWith('no worker')
    spy.mockRestore()
  })

  it('dispatchError falls back to a default message', () => {
    const { ctx } = makeCtx()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    handleDispatchError({ type: 'clickupStartWorkError' }, ctx)
    expect(ctx.setDispatchError).toHaveBeenCalledWith('Failed to launch worker.')
    spy.mockRestore()
  })

  it('autoModeLoaded maps enabled===true only', () => {
    const { ctx } = makeCtx()
    handleAutoModeLoaded({ type: 'autoModeLoaded', enabled: true }, ctx)
    expect(ctx.setAutoMode).toHaveBeenCalledWith(true)
    handleAutoModeLoaded({ type: 'autoModeLoaded', enabled: 'yes' }, ctx)
    expect(ctx.setAutoMode).toHaveBeenLastCalledWith(false)
  })

  it('delegationPending sets the list, defaulting to []', () => {
    const { ctx } = makeCtx()
    handleDelegationPending({ type: 'delegationPending', delegations: undefined }, ctx)
    expect(resolveSet(ctx.setPendingDelegations, [])).toEqual([])
  })
})
