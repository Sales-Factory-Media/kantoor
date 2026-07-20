/**
 * Ticket-domain message handlers: ClickUp ticket feed & connector config, Auto
 * Mode delegation queue, and dispatch/launch failures.
 */

import type { ClickUpStatusGroup, PendingDelegation } from '../useExtensionMessages.js'
import type { HandlerCtx } from './ctx.js'

export function handleClickupTickets(msg: Record<string, unknown>, ctx: HandlerCtx): void {
  ctx.setClickupTickets(msg.statuses as ClickUpStatusGroup[])
  if (msg.nextFetchAt != null) ctx.setClickupNextFetchAt(msg.nextFetchAt as number)
}

export function handleClickupConfigured(msg: Record<string, unknown>, ctx: HandlerCtx): void {
  ctx.setClickupConfigured(msg.configured as boolean)
  if (Array.isArray(msg.listIds)) ctx.setClickupListIds(msg.listIds as string[])
}

export function handleClickupError(msg: Record<string, unknown>): void {
  console.error('[ClickUp]', msg.error)
}

export function handleDispatchError(msg: Record<string, unknown>, ctx: HandlerCtx): void {
  // A confirmed delegation / "start work" dispatch failed on the hub.
  // Surface the reason instead of silently no-op'ing.
  const error = (msg.error as string | undefined) ?? 'Failed to launch worker.'
  console.error('[Dispatch]', error)
  ctx.setDispatchError(error)
}

export function handleAutoModeLoaded(msg: Record<string, unknown>, ctx: HandlerCtx): void {
  ctx.setAutoMode(msg.enabled === true)
}

export function handleDelegationPending(msg: Record<string, unknown>, ctx: HandlerCtx): void {
  ctx.setPendingDelegations((msg.delegations as PendingDelegation[]) || [])
}
