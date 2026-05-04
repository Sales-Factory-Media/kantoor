import { useRef, useEffect, useCallback } from 'react'
import { loadCatSprites } from '../cats.js'
import { loadAndGenerateOutdoor } from '../outdoor/outdoorGenerator.js'
import type { OfficeState } from '../engine/officeState.js'
import { PixiStage } from '../pixi/pixiStage.js'
import { TILE_SIZE } from '../types.js'
import { CAMERA_FOLLOW_LERP, CAMERA_FOLLOW_SNAP_THRESHOLD, ZOOM_MIN, ZOOM_MAX, ZOOM_SCROLL_THRESHOLD, PAN_MARGIN_FRACTION, KEY_PAN_SPEED, MAX_DEVICE_PIXEL_RATIO, MAX_DELTA_TIME_SEC } from '../../constants.js'
import { unlockAudio } from '../../notificationSound.js'

interface OfficeCanvasProps {
  officeState: OfficeState
  onClick: (agentId: number) => void
  zoom: number
  onZoomChange: (zoom: number) => void
  panRef: React.MutableRefObject<{ x: number; y: number }>
}

export function OfficeCanvas({ officeState, onClick, zoom, onZoomChange, panRef }: OfficeCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const offsetRef = useRef({ x: 0, y: 0 })
  // Pan state (imperative, no re-renders) — works for both middle-mouse and left-click drag
  const isPanningRef = useRef(false)
  const panStartRef = useRef({ mouseX: 0, mouseY: 0, panX: 0, panY: 0 })
  const didDragRef = useRef(false)
  // Zoom scroll accumulator for trackpad pinch sensitivity
  const zoomAccumulatorRef = useRef(0)
  // Arrow key pan state
  const keysDownRef = useRef(new Set<string>())
  // Mirror the zoom prop into a ref so the long-lived rAF effect below can
  // read the latest value WITHOUT being in the effect's dep array. Otherwise
  // every zoom change tears down Pixi (async destroy + re-init) and the two
  // app instances briefly fight for the same WebGL context — the page stalls.
  const zoomRef = useRef(zoom)
  useEffect(() => {
    zoomRef.current = zoom
  }, [zoom])

  // Clamp pan so the map edge can't go past a margin inside the viewport
  const clampPan = useCallback((px: number, py: number): { x: number; y: number } => {
    const canvas = canvasRef.current
    if (!canvas) return { x: px, y: py }
    const layout = officeState.getLayout()
    const mapW = layout.cols * TILE_SIZE * zoom
    const mapH = layout.rows * TILE_SIZE * zoom
    const marginX = canvas.width * PAN_MARGIN_FRACTION
    const marginY = canvas.height * PAN_MARGIN_FRACTION
    const maxPanX = (mapW / 2) + canvas.width / 2 - marginX
    const maxPanY = (mapH / 2) + canvas.height / 2 - marginY
    return {
      x: Math.max(-maxPanX, Math.min(maxPanX, px)),
      y: Math.max(-maxPanY, Math.min(maxPanY, py)),
    }
  }, [officeState, zoom])

  // Resize canvas backing store to device pixels (no DPR transform on ctx)
  const resizeCanvas = useCallback(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return
    const rect = container.getBoundingClientRect()
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DEVICE_PIXEL_RATIO)
    canvas.width = Math.round(rect.width * dpr)
    canvas.height = Math.round(rect.height * dpr)
    canvas.style.width = `${rect.width}px`
    canvas.style.height = `${rect.height}px`
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    resizeCanvas()

    // Load cat sprites — feeding officeState; the Pixi cat layer will pick
    // them up in a follow-up milestone.
    loadCatSprites('assets/characters/cat.png').then(sprites => {
      if (sprites.length > 0) {
        officeState.setCatSprites(sprites)
      }
    })

    // Generate the outdoor / forest layer once (async PNG load + bake).
    // Pixi's outdoorLayer picks up `officeState.outdoor` on the next tick.
    if (!officeState.outdoor) {
      const layout = officeState.getLayout()
      loadAndGenerateOutdoor('assets/outdoor/summer-forest.png', layout.cols, layout.rows).then(outdoor => {
        if (outdoor) officeState.outdoor = outdoor
      })
    }

    let rafId = 0
    let lastTime = 0
    let stopped = false
    let stage: PixiStage | null = null

    const newStage = new PixiStage()
    newStage.init(canvas, canvas.width, canvas.height).then(() => {
      if (stopped) {
        newStage.destroy()
        return
      }
      stage = newStage
      // We drive rendering manually from the rAF below. Stop Pixi's internal
      // ticker so we don't get two render passes per frame.
      stage.app.stop()

      const tick = (time: number) => {
        if (stopped) return
        const dt = lastTime === 0 ? 0 : Math.min((time - lastTime) / 1000, MAX_DELTA_TIME_SEC)
        lastTime = time

        officeState.update(dt)

        const z = zoomRef.current

        // Camera follow: smoothly center on followed agent
        if (officeState.cameraFollowId !== null) {
          const followCh = officeState.characters.get(officeState.cameraFollowId)
          if (followCh) {
            const layout = officeState.getLayout()
            const mapW = layout.cols * TILE_SIZE * z
            const mapH = layout.rows * TILE_SIZE * z
            const targetX = mapW / 2 - followCh.x * z
            const targetY = mapH / 2 - followCh.y * z
            const dx = targetX - panRef.current.x
            const dy = targetY - panRef.current.y
            if (Math.abs(dx) < CAMERA_FOLLOW_SNAP_THRESHOLD && Math.abs(dy) < CAMERA_FOLLOW_SNAP_THRESHOLD) {
              panRef.current = { x: targetX, y: targetY }
            } else {
              panRef.current = {
                x: panRef.current.x + dx * CAMERA_FOLLOW_LERP,
                y: panRef.current.y + dy * CAMERA_FOLLOW_LERP,
              }
            }
          }
        }

        // Mirror the world transform's offset for mouse hit-testing
        // (`screenToWorld` reads offsetRef.current to convert mouse → world).
        const layout = officeState.getLayout()
        const mapW = layout.cols * TILE_SIZE * z
        const mapH = layout.rows * TILE_SIZE * z
        const offsetX = Math.floor((canvas.width - mapW) / 2) + Math.round(panRef.current.x)
        const offsetY = Math.floor((canvas.height - mapH) / 2) + Math.round(panRef.current.y)
        offsetRef.current = { x: offsetX, y: offsetY }

        stage!.update(officeState, z, panRef.current.x, panRef.current.y, canvas.width, canvas.height)
        stage!.app.render()
        rafId = requestAnimationFrame(tick)
      }
      rafId = requestAnimationFrame(tick)
    })

    const observer = new ResizeObserver(() => {
      resizeCanvas()
      stage?.resize(canvas.width, canvas.height)
    })
    if (containerRef.current) {
      observer.observe(containerRef.current)
    }

    return () => {
      stopped = true
      if (rafId) cancelAnimationFrame(rafId)
      observer.disconnect()
      if (stage) {
        stage.destroy()
        stage = null
      }
    }
  }, [officeState, resizeCanvas, panRef])

  // Convert CSS mouse coords to world (sprite pixel) coords
  const screenToWorld = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = canvasRef.current
      if (!canvas) return null
      const rect = canvas.getBoundingClientRect()
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DEVICE_PIXEL_RATIO)
      const cssX = clientX - rect.left
      const cssY = clientY - rect.top
      const deviceX = cssX * dpr
      const deviceY = cssY * dpr
      const worldX = (deviceX - offsetRef.current.x) / zoom
      const worldY = (deviceY - offsetRef.current.y) / zoom
      return { worldX, worldY }
    },
    [zoom],
  )

  const screenToTile = useCallback(
    (clientX: number, clientY: number): { col: number; row: number } | null => {
      const pos = screenToWorld(clientX, clientY)
      if (!pos) return null
      const col = Math.floor(pos.worldX / TILE_SIZE)
      const row = Math.floor(pos.worldY / TILE_SIZE)
      const layout = officeState.getLayout()
      if (col < 0 || col >= layout.cols || row < 0 || row >= layout.rows) return null
      return { col, row }
    },
    [screenToWorld, officeState],
  )

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      // Handle drag-to-pan (middle-mouse or left-click drag)
      if (isPanningRef.current) {
        const dpr = Math.min(window.devicePixelRatio || 1, MAX_DEVICE_PIXEL_RATIO)
        const dx = (e.clientX - panStartRef.current.mouseX) * dpr
        const dy = (e.clientY - panStartRef.current.mouseY) * dpr
        // Only start panning after a small drag threshold to avoid interfering with clicks
        if (!didDragRef.current) {
          const dist = Math.abs(e.clientX - panStartRef.current.mouseX) + Math.abs(e.clientY - panStartRef.current.mouseY)
          if (dist < 4) return
          didDragRef.current = true
          officeState.cameraFollowId = null
          const canvas = canvasRef.current
          if (canvas) canvas.style.cursor = 'grabbing'
        }
        panRef.current = clampPan(
          panStartRef.current.panX + dx,
          panStartRef.current.panY + dy,
        )
        return
      }

      const pos = screenToWorld(e.clientX, e.clientY)
      if (!pos) return
      const hitId = officeState.getCharacterAt(pos.worldX, pos.worldY)
      const tile = screenToTile(e.clientX, e.clientY)
      officeState.hoveredTile = tile
      const canvas = canvasRef.current
      if (canvas) {
        let cursor = 'default'
        if (hitId !== null) {
          cursor = 'pointer'
        } else if (officeState.selectedAgentId !== null && tile) {
          const seatId = officeState.getSeatAtTile(tile.col, tile.row)
          if (seatId) {
            const seat = officeState.seats.get(seatId)
            if (seat) {
              const selectedCh = officeState.characters.get(officeState.selectedAgentId)
              if (!seat.assigned || (selectedCh && selectedCh.seatId === seatId)) {
                cursor = 'pointer'
              }
            }
          }
        }
        canvas.style.cursor = cursor
      }
      officeState.hoveredAgentId = hitId
    },
    [officeState, screenToWorld, screenToTile, panRef, clampPan],
  )

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      unlockAudio()
      // Middle mouse or left mouse button starts panning
      if (e.button === 1 || e.button === 0) {
        if (e.button === 1) e.preventDefault()
        isPanningRef.current = true
        didDragRef.current = false
        panStartRef.current = {
          mouseX: e.clientX,
          mouseY: e.clientY,
          panX: panRef.current.x,
          panY: panRef.current.y,
        }
        if (e.button === 1) {
          officeState.cameraFollowId = null
          const canvas = canvasRef.current
          if (canvas) canvas.style.cursor = 'grabbing'
        }
        return
      }
    },
    [officeState, panRef],
  )

  const handleMouseUp = useCallback(
    (e: React.MouseEvent) => {
      if (e.button === 1 || e.button === 0) {
        if (isPanningRef.current && didDragRef.current) {
          const canvas = canvasRef.current
          if (canvas) canvas.style.cursor = 'default'
        }
        isPanningRef.current = false
        return
      }
    },
    [],
  )

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      // Skip click if we just dragged to pan
      if (didDragRef.current) return

      const pos = screenToWorld(e.clientX, e.clientY)
      if (!pos) return

      const hitId = officeState.getCharacterAt(pos.worldX, pos.worldY)
      if (hitId !== null) {
        officeState.dismissBubble(hitId)
        if (officeState.selectedAgentId === hitId) {
          officeState.selectedAgentId = null
          officeState.cameraFollowId = null
        } else {
          officeState.selectedAgentId = hitId
          officeState.cameraFollowId = hitId
        }
        onClick(hitId)
        return
      }

      // No agent hit — check seat click while agent is selected
      if (officeState.selectedAgentId !== null) {
        const selectedCh = officeState.characters.get(officeState.selectedAgentId)
        if (selectedCh && !selectedCh.isSubagent) {
          const tile = screenToTile(e.clientX, e.clientY)
          if (tile) {
            const seatId = officeState.getSeatAtTile(tile.col, tile.row)
            if (seatId) {
              const seat = officeState.seats.get(seatId)
              if (seat && selectedCh) {
                if (selectedCh.seatId === seatId) {
                  officeState.sendToSeat(officeState.selectedAgentId)
                  officeState.selectedAgentId = null
                  officeState.cameraFollowId = null
                  return
                } else if (!seat.assigned) {
                  officeState.reassignSeat(officeState.selectedAgentId, seatId)
                  officeState.selectedAgentId = null
                  officeState.cameraFollowId = null
                  return
                }
              }
            }
          }
        }
        officeState.selectedAgentId = null
        officeState.cameraFollowId = null
      }
    },
    [officeState, onClick, screenToWorld, screenToTile],
  )

  const handleMouseLeave = useCallback(() => {
    isPanningRef.current = false
    didDragRef.current = false
    officeState.hoveredAgentId = null
    officeState.hoveredTile = null
  }, [officeState])

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    // Right-click to walk selected agent to tile
    if (officeState.selectedAgentId !== null) {
      const tile = screenToTile(e.clientX, e.clientY)
      if (tile) {
        officeState.walkToTile(officeState.selectedAgentId, tile.col, tile.row)
      }
    }
  }, [officeState, screenToTile])

  // Wheel: Ctrl+wheel to zoom, plain wheel/trackpad to pan
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault()
      if (e.ctrlKey || e.metaKey) {
        zoomAccumulatorRef.current += e.deltaY
        if (Math.abs(zoomAccumulatorRef.current) >= ZOOM_SCROLL_THRESHOLD) {
          const delta = zoomAccumulatorRef.current < 0 ? 1 : -1
          zoomAccumulatorRef.current = 0
          const newZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom + delta))
          if (newZoom !== zoom) {
            onZoomChange(newZoom)
          }
        }
      } else {
        const dpr = Math.min(window.devicePixelRatio || 1, MAX_DEVICE_PIXEL_RATIO)
        officeState.cameraFollowId = null
        panRef.current = clampPan(
          panRef.current.x - e.deltaX * dpr,
          panRef.current.y - e.deltaY * dpr,
        )
      }
    },
    [zoom, onZoomChange, officeState, panRef, clampPan],
  )

  const handleAuxClick = useCallback((e: React.MouseEvent) => {
    if (e.button === 1) e.preventDefault()
  }, [])

  // Arrow key panning
  useEffect(() => {
    const keys = keysDownRef.current
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't intercept arrow keys when a text input/textarea/select is focused
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        keys.add(e.key)
      }
    }
    const handleKeyUp = (e: KeyboardEvent) => {
      keys.delete(e.key)
    }
    let animId: number
    const tick = () => {
      if (keys.size > 0) {
        let dx = 0
        let dy = 0
        if (keys.has('ArrowLeft')) dx += KEY_PAN_SPEED
        if (keys.has('ArrowRight')) dx -= KEY_PAN_SPEED
        if (keys.has('ArrowUp')) dy += KEY_PAN_SPEED
        if (keys.has('ArrowDown')) dy -= KEY_PAN_SPEED
        if (dx !== 0 || dy !== 0) {
          officeState.cameraFollowId = null
          panRef.current = clampPan(panRef.current.x + dx, panRef.current.y + dy)
        }
      }
      animId = requestAnimationFrame(tick)
    }
    animId = requestAnimationFrame(tick)
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    return () => {
      cancelAnimationFrame(animId)
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      keys.clear()
    }
  }, [officeState, panRef, clampPan])

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      style={{
        width: '100%',
        height: '100%',
        position: 'relative',
        overflow: 'hidden',
        background: '#1E1E2E',
        outline: 'none',
      }}
    >
      <canvas
        ref={canvasRef}
        onMouseMove={handleMouseMove}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onClick={handleClick}
        onAuxClick={handleAuxClick}
        onMouseLeave={handleMouseLeave}
        onWheel={handleWheel}
        onContextMenu={handleContextMenu}
        style={{ display: 'block' }}
      />
    </div>
  )
}
