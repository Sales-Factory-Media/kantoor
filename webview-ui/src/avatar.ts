// DiceBear v10 pixel-art avatars. Each employee gets a deterministic face from
// a stored "combo" (a seed plus optional explicit trait overrides). The combo is
// persisted on the PersistentAgent (`avatar_config` column) as a JSON string.
//
// API verified against @dicebear/core@10 / @dicebear/styles@10:
//   import { Avatar } from '@dicebear/core'
//   import pixelArt from '@dicebear/styles/pixel-art.json'
//   new Avatar(pixelArt, { seed, ...traits }).toString()  // SVG markup
//   new Avatar(pixelArt, { seed, ...traits }).toDataUri()  // data:image/svg+xml
import { Avatar } from '@dicebear/core'
import pixelArt from '@dicebear/styles/pixel-art.json'

/**
 * The stored avatar "combo" for an employee.
 * - `seed` drives the deterministic random generation (same seed → same face).
 * - `options` (optional) pins specific pixel-art traits fetched from the DB,
 *   e.g. `{ beard: ['variant01'], accessories: ['variant04'], clothingColor: ['5bc0de'] }`.
 *   When omitted, every trait is derived from the seed (fully random).
 */
export interface AvatarConfig {
  seed: string
  options?: Record<string, unknown>
}

/** Anything that can carry an avatar — a live character or an offline employee. */
export interface EmployeeProfile {
  id?: string
  name?: string
  /** Stored combo: parsed object, JSON string (as it travels over the wire), or null. */
  avatarConfig?: AvatarConfig | string | null
}

// The JSON-derived generic on Avatar makes the options arg awkward to type, so
// we cast to a narrow constructor type matching the verified v10 surface.
type PixelAvatarCtor = new (
  style: unknown,
  options?: Record<string, unknown>,
) => { toString(): string; toDataUri(): string }
const PixelAvatar = Avatar as unknown as PixelAvatarCtor

/** Parse a stored combo that may arrive as a JSON string, object, or null. */
export function parseAvatarConfig(
  raw: AvatarConfig | string | null | undefined,
): AvatarConfig | null {
  if (!raw) return null
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as AvatarConfig
    } catch {
      return null
    }
  }
  return raw
}

function buildAvatar(profile: EmployeeProfile) {
  const cfg = parseAvatarConfig(profile.avatarConfig)
  // Fully Random: a bare seed. Configured: seed + explicit trait overrides.
  const seed = cfg?.seed || profile.id || profile.name || 'employee'
  return new PixelAvatar(pixelArt, { seed, ...(cfg?.options ?? {}) })
}

/** Avatar as raw SVG markup. */
export function avatarSvg(profile: EmployeeProfile): string {
  return buildAvatar(profile).toString()
}

/** Avatar as a `data:image/svg+xml` URI — drop straight into an <img src>. */
export function avatarDataUri(profile: EmployeeProfile): string {
  return buildAvatar(profile).toDataUri()
}

/** A fresh, fully-random combo — used by the "🎲 randomize" button. */
export function randomAvatarConfig(): AvatarConfig {
  return { seed: crypto.randomUUID() }
}
