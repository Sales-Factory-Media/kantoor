/**
 * PixiJS-based renderer for the office.
 *
 * Replaces the imperative Canvas 2D `renderFrame()` pipeline. Owns a single
 * `PIXI.Application`, a world `Container` (scaled by `zoom`, translated by
 * the React-managed pan offset), and three layers:
 *
 *   - `floorLayer`     : static floor bake (one PIXI.Sprite, re-baked on
 *                        layout change).
 *   - `entityLayer`    : walls, furniture, characters — pooled PIXI.Sprite
 *                        instances z-sorted via `sortableChildren + zIndex`.
 *   - `overlayLayer`   : reserved for bubbles/names/edit UI in a follow-up.
 *
 * Spike scope (this milestone): floor + walls + furniture + characters.
 * Out of scope for now: speech bubbles, names, character outlines, the
 * matrix spawn/despawn effect, cats, windows, outdoor, edit-mode UI.
 */
import { Application, Container, Sprite, Texture } from 'pixi.js'
import type { OfficeState } from '../engine/officeState.js'
import type { OutdoorState } from '../outdoor/outdoorGenerator.js'
import type { FurnitureInstance, FloorColor, TileType as TileTypeVal, SpriteData } from '../types.js'
import { TileType, TILE_SIZE, CharacterState } from '../types.js'
import { CHARACTER_SITTING_OFFSET_PX, CHARACTER_Z_SORT_OFFSET, FALLBACK_FLOOR_COLOR, TASK_PIP_BORDER_PX, TASK_PIP_BORDER_COLOR } from '../../constants.js'
import { getCharacterSprite } from '../engine/characters.js'
import { getCharacterSprites } from '../sprites/spriteData.js'
import { hasFloorSprites, usesGeneratedFloor, getColorizedFloorSprite, getColorizedHerringboneSprite, getAllFloorSprites } from '../floorTiles.js'
import { hasWallSprites, getWallInstances } from '../wallTiles.js'
import { getCachedSprite } from '../sprites/spriteCache.js'
import { spriteDataToTexture, canvasToTexture } from './textures.js'

/** A tile is "non-floor" for adjacency-mask purposes if it's wall, window, void, or out-of-grid. */
function isNonFloor(tileMap: TileTypeVal[][], r: number, c: number, rows: number, cols: number): boolean {
  if (r < 0 || c < 0 || r >= rows || c >= cols) return true
  const t = tileMap[r][c]
  return t === TileType.WALL || t === TileType.WINDOW || t === TileType.VOID
}

export class PixiStage {
  app: Application
  /** World container — scaled and translated to handle pan/zoom. */
  world: Container
  /** Outdoor / forest layer. Sits below `floorLayer` so the office paints on top. */
  outdoorLayer: Container
  floorLayer: Container
  entityLayer: Container
  overlayLayer: Container

  /** Sprite pools. Reused across frames; unused slots are hidden. */
  private wallSpritePool: Sprite[] = []
  private furnitureSpritePool: Sprite[] = []
  /** Character sprites are keyed by id for stable identity (visibility, hover, etc). */
  private characterSprites = new Map<number, Sprite>()
  /** Task-pip sprite pool — each pip is a dark border behind a tinted square. */
  private pipPool: Array<{ outer: Sprite; inner: Sprite }> = []

  /** Floor-bake cache invalidation keys (reference identity on layout). */
  private floorTileMapRef: TileTypeVal[][] | null = null
  private floorTileColorsRef: Array<FloorColor | null> | undefined = undefined
  private floorSpritesRef: SpriteData[] | null = null
  private floorCols = 0
  private floorRows = 0
  private floorSprite: Sprite | null = null
  private floorTexture: Texture | null = null

  /** Outdoor cache: track the OutdoorState reference and the bakedCanvas it
   *  carries — `bakedCanvas` is filled in asynchronously after the PNG loads. */
  private outdoorRef: OutdoorState | null = null
  private outdoorBakedCanvasRef: HTMLCanvasElement | null = null
  private outdoorSprite: Sprite | null = null
  private outdoorTexture: Texture | null = null

  constructor() {
    this.app = new Application()
    this.world = new Container()
    this.outdoorLayer = new Container()
    this.floorLayer = new Container()
    this.entityLayer = new Container()
    this.entityLayer.sortableChildren = true
    this.overlayLayer = new Container()
  }

  /**
   * Initialize Pixi onto the given canvas element. Must be awaited before
   * the first `update()` call. Pixi v8 init is async (texture pipeline + GL
   * context creation).
   */
  async init(canvas: HTMLCanvasElement, width: number, height: number): Promise<void> {
    await this.app.init({
      canvas,
      width,
      height,
      backgroundAlpha: 0,
      antialias: false,
      // Match the canvas backing-store DPR clamp used by the legacy renderer.
      // We let the React component size the canvas and pass dimensions in;
      // Pixi shouldn't try to manage DPR independently.
      autoDensity: false,
      resolution: 1,
    })
    this.app.stage.addChild(this.world)
    this.world.addChild(this.outdoorLayer)
    this.world.addChild(this.floorLayer)
    this.world.addChild(this.entityLayer)
    this.world.addChild(this.overlayLayer)
  }

  /** React canvas resize → Pixi resize. */
  resize(width: number, height: number): void {
    this.app.renderer.resize(width, height)
  }

  destroy(): void {
    if (this.floorTexture) {
      this.floorTexture.destroy(true)
      this.floorTexture = null
    }
    if (this.outdoorTexture) {
      this.outdoorTexture.destroy(true)
      this.outdoorTexture = null
    }
    this.app.destroy(false, { children: true, texture: true })
  }

  /**
   * Sync state → sprites for one frame. Pan/zoom are passed in from the
   * React side (existing pan/zoom math is preserved).
   */
  update(officeState: OfficeState, zoom: number, panX: number, panY: number, canvasWidth: number, canvasHeight: number): void {
    const layout = officeState.getLayout()
    const cols = layout.cols
    const rows = layout.rows
    const tileColors = layout.tileColors

    // World transform: same math as the legacy renderer's `renderFrame()`.
    const mapW = cols * TILE_SIZE * zoom
    const mapH = rows * TILE_SIZE * zoom
    const offsetX = Math.floor((canvasWidth - mapW) / 2) + Math.round(panX)
    const offsetY = Math.floor((canvasHeight - mapH) / 2) + Math.round(panY)
    this.world.position.set(offsetX, offsetY)
    this.world.scale.set(zoom)

    this.updateOutdoor(officeState.outdoor)
    this.updateFloor(officeState.tileMap, tileColors, cols, rows)
    this.updateEntities(officeState)
    this.updatePips(officeState)
  }

  // ── Task pips (multi-session indicator) ────────────────────────

  private updatePips(officeState: OfficeState): void {
    const pips = officeState.getTaskPips()
    for (let i = 0; i < pips.length; i++) {
      const p = pips[i]
      let pair = this.pipPool[i]
      if (!pair) {
        const outer = new Sprite(Texture.WHITE)
        outer.tint = TASK_PIP_BORDER_COLOR
        const inner = new Sprite(Texture.WHITE)
        this.overlayLayer.addChild(outer)
        this.overlayLayer.addChild(inner)
        pair = { outer, inner }
        this.pipPool[i] = pair
      }
      const b = TASK_PIP_BORDER_PX
      pair.outer.x = p.x - b
      pair.outer.y = p.y - b
      pair.outer.width = p.size + b * 2
      pair.outer.height = p.size + b * 2
      pair.outer.visible = true
      pair.inner.x = p.x
      pair.inner.y = p.y
      pair.inner.width = p.size
      pair.inner.height = p.size
      pair.inner.tint = p.color
      pair.inner.visible = true
    }
    for (let i = pips.length; i < this.pipPool.length; i++) {
      this.pipPool[i].outer.visible = false
      this.pipPool[i].inner.visible = false
    }
  }

  // ── Outdoor (forest) layer ─────────────────────────────────────

  private updateOutdoor(outdoor: OutdoorState | null | undefined): void {
    if (!outdoor || !outdoor.bakedCanvas) {
      // No outdoor data yet (still loading) or none configured — hide if shown.
      if (this.outdoorSprite) this.outdoorSprite.visible = false
      this.outdoorRef = outdoor ?? null
      this.outdoorBakedCanvasRef = null
      return
    }

    // (Re)build the texture only when the OutdoorState reference changes OR
    // when its `bakedCanvas` is filled in (the bake happens asynchronously
    // once the PNG loads).
    if (
      this.outdoorRef !== outdoor ||
      this.outdoorBakedCanvasRef !== outdoor.bakedCanvas ||
      !this.outdoorTexture
    ) {
      if (this.outdoorTexture) {
        this.outdoorTexture.destroy(true)
      }
      this.outdoorTexture = canvasToTexture(outdoor.bakedCanvas)
      if (!this.outdoorSprite) {
        this.outdoorSprite = new Sprite(this.outdoorTexture)
        this.outdoorLayer.addChild(this.outdoorSprite)
      } else {
        this.outdoorSprite.texture = this.outdoorTexture
      }
      this.outdoorRef = outdoor
      this.outdoorBakedCanvasRef = outdoor.bakedCanvas
    }

    // Position relative to the office grid: the outdoor sheet starts at
    // (offsetCol, offsetRow) tiles relative to the office origin (typically
    // negative — the forest extends outside the office bounds).
    if (this.outdoorSprite) {
      this.outdoorSprite.x = outdoor.offsetCol * TILE_SIZE
      this.outdoorSprite.y = outdoor.offsetRow * TILE_SIZE
      this.outdoorSprite.visible = true
    }
  }

  // ── Floor bake ─────────────────────────────────────────────────

  private updateFloor(
    tileMap: TileTypeVal[][],
    tileColors: Array<FloorColor | null> | undefined,
    cols: number,
    rows: number,
  ): void {
    const sprites = getAllFloorSprites()
    if (
      this.floorTexture !== null &&
      this.floorTileMapRef === tileMap &&
      this.floorTileColorsRef === tileColors &&
      this.floorSpritesRef === sprites &&
      this.floorCols === cols &&
      this.floorRows === rows
    ) {
      return
    }

    // (Re)bake the floor at sprite-pixel resolution. The world container
    // applies the zoom transform, so the bake is always at native 1×.
    const w = cols * TILE_SIZE
    const h = rows * TILE_SIZE
    if (w <= 0 || h <= 0) return

    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.imageSmoothingEnabled = false

    const useSpriteFloors = hasFloorSprites()
    const useHerringbone = usesGeneratedFloor()
    const tmRows = tileMap.length
    const tmCols = tmRows > 0 ? tileMap[0].length : 0

    for (let r = 0; r < tmRows; r++) {
      for (let c = 0; c < tmCols; c++) {
        const tile = tileMap[r][c]
        // Skip walls (handled by wall sprites in entityLayer), VOID (transparent),
        // and WINDOW (handled separately in a later milestone).
        if (tile === TileType.WALL || tile === TileType.VOID || tile === TileType.WINDOW) continue

        if (!useSpriteFloors) {
          ctx.fillStyle = FALLBACK_FLOOR_COLOR
          ctx.fillRect(c * TILE_SIZE, r * TILE_SIZE, TILE_SIZE, TILE_SIZE)
          continue
        }

        const colorIdx = r * cols + c
        const color = tileColors?.[colorIdx] ?? { h: 0, s: 0, b: 0, c: 0 }

        let sprite: SpriteData
        if (useHerringbone) {
          let mask = 0
          if (isNonFloor(tileMap, r - 1, c, tmRows, tmCols)) mask |= 1
          if (isNonFloor(tileMap, r, c + 1, tmRows, tmCols)) mask |= 2
          if (isNonFloor(tileMap, r + 1, c, tmRows, tmCols)) mask |= 4
          if (isNonFloor(tileMap, r, c - 1, tmRows, tmCols)) mask |= 8
          sprite = getColorizedHerringboneSprite(r, c, mask, color)
        } else {
          sprite = getColorizedFloorSprite(tile, color)
        }

        // Reuse the per-zoom sprite cache at native scale (zoom=1). One
        // drawImage per tile is far cheaper than 256 fillRects.
        const cached = getCachedSprite(sprite, 1)
        ctx.drawImage(cached, c * TILE_SIZE, r * TILE_SIZE)
      }
    }

    if (this.floorTexture) {
      this.floorTexture.destroy(true)
    }
    this.floorTexture = canvasToTexture(canvas)

    if (!this.floorSprite) {
      this.floorSprite = new Sprite(this.floorTexture)
      this.floorLayer.addChild(this.floorSprite)
    } else {
      this.floorSprite.texture = this.floorTexture
    }

    this.floorTileMapRef = tileMap
    this.floorTileColorsRef = tileColors
    this.floorSpritesRef = sprites
    this.floorCols = cols
    this.floorRows = rows
  }

  // ── Walls, furniture, characters (z-sorted) ────────────────────

  private updateEntities(officeState: OfficeState): void {
    const layout = officeState.getLayout()
    const tileColors = layout.tileColors
    const layoutCols = layout.cols

    // Walls
    const wallInstances = hasWallSprites()
      ? getWallInstances(officeState.tileMap, tileColors, layoutCols)
      : []
    this.applyInstancePool(this.wallSpritePool, wallInstances, this.entityLayer)

    // Furniture
    this.applyInstancePool(this.furnitureSpritePool, officeState.furniture, this.entityLayer)

    // Characters — keyed by id for stable identity (matrix effect, hover, etc.)
    this.updateCharacters(officeState)
  }

  /** Sync a list of FurnitureInstance-shaped records into a sprite pool. */
  private applyInstancePool(pool: Sprite[], instances: FurnitureInstance[], layer: Container): void {
    for (let i = 0; i < instances.length; i++) {
      const inst = instances[i]
      let sprite = pool[i]
      if (!sprite) {
        sprite = new Sprite()
        pool[i] = sprite
        layer.addChild(sprite)
      }
      sprite.texture = spriteDataToTexture(inst.sprite)
      sprite.x = inst.x
      sprite.y = inst.y
      sprite.zIndex = inst.zY
      sprite.visible = true
    }
    // Hide leftover pool entries so they don't render at stale positions.
    for (let i = instances.length; i < pool.length; i++) {
      pool[i].visible = false
    }
  }

  private updateCharacters(officeState: OfficeState): void {
    const seen = new Set<number>()
    const characters = officeState.getCharacters()
    for (const ch of characters) {
      seen.add(ch.id)
      let sprite = this.characterSprites.get(ch.id)
      if (!sprite) {
        sprite = new Sprite()
        sprite.anchor.set(0.5, 1) // bottom-center anchor matches existing draw math
        this.characterSprites.set(ch.id, sprite)
        this.entityLayer.addChild(sprite)
      }

      const sprites = getCharacterSprites(ch.palette, ch.hueShift)
      const spriteData = getCharacterSprite(ch, sprites)
      sprite.texture = spriteDataToTexture(spriteData)

      const sittingOffset = ch.state === CharacterState.TYPE && !ch.atActivitySpot ? CHARACTER_SITTING_OFFSET_PX : 0
      sprite.x = ch.x
      sprite.y = ch.y + sittingOffset
      sprite.zIndex = ch.y + TILE_SIZE / 2 + CHARACTER_Z_SORT_OFFSET
      sprite.visible = !ch.matrixEffect // matrix effect not yet ported
    }

    // Remove sprites for characters that no longer exist.
    for (const [id, sprite] of this.characterSprites) {
      if (seen.has(id)) continue
      sprite.destroy()
      this.characterSprites.delete(id)
    }
  }
}

/**
 * Convenience wrapper for ad-hoc texture creation in code that doesn't need
 * the cache (kept exported because some callers may want it).
 */
export function makeTexture(sprite: SpriteData): Texture {
  return spriteDataToTexture(sprite)
}
