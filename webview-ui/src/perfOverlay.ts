/**
 * Lightweight in-page perf overlay.
 *
 * The webview can be too sluggish to open Firefox DevTools, which makes it
 * impossible to see what's actually slow. This module appends a fixed-position
 * `<div>` to the page and writes FPS / WebSocket / render-count stats to it
 * once per second, all via direct DOM mutation (no React state, so it can't
 * itself contribute to reconciliation storms).
 *
 * Usage:
 *   import { startPerfOverlay, recordWsMessage, recordAppRender } from './perfOverlay.js'
 *   startPerfOverlay()                  // once, near the entry point
 *   recordWsMessage(msg.type)           // every WS message arrival
 *   recordAppRender()                   // every App() function-component invocation
 */

let started = false
let wsCount = 0
let renderCount = 0
let frameCount = 0
const wsByType = new Map<string, number>()
let el: HTMLDivElement | null = null

export function recordWsMessage(type?: string): void {
  wsCount++
  if (type) wsByType.set(type, (wsByType.get(type) || 0) + 1)
}

export function recordAppRender(): void {
  renderCount++
}

export function startPerfOverlay(): void {
  if (started) return
  started = true

  el = document.createElement('div')
  el.style.cssText = [
    'position: fixed',
    'top: 8px',
    'right: 8px',
    'z-index: 99999',
    'background: rgba(0,0,0,0.78)',
    'color: #6cff6c',
    'font: 12px/1.35 ui-monospace, "SF Mono", Menlo, monospace',
    'padding: 6px 8px',
    'border-radius: 4px',
    'pointer-events: none',
    'white-space: pre',
    'min-width: 180px',
  ].join(';')
  el.textContent = 'perf: warming up…'
  document.body.appendChild(el)

  let lastReport = performance.now()
  const tick = (now: number) => {
    frameCount++
    if (now - lastReport >= 1000) {
      const fps = frameCount
      const ws = wsCount
      const renders = renderCount
      // Show top 3 message types so we know what's chattering
      const top = Array.from(wsByType.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([t, n]) => `  ${t}: ${n}`)
        .join('\n')

      if (el) {
        el.textContent =
          `FPS:        ${fps}\n` +
          `WS msg/s:   ${ws}\n` +
          `Renders/s:  ${renders}\n` +
          (top ? `Top WS:\n${top}` : '')
      }

      frameCount = 0
      wsCount = 0
      renderCount = 0
      wsByType.clear()
      lastReport = now
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}
