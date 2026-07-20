import { useMemo } from 'react'
import { avatarDataUri, type AvatarConfig } from '../avatar.js'

interface EmployeeAvatarProps {
  /** Stable identity fallback when there's no stored combo yet. */
  id?: string
  name?: string
  /** Stored combo — parsed object or the raw JSON string from the wire. */
  avatarConfig?: AvatarConfig | string | null
  size?: number
  style?: React.CSSProperties
}

/**
 * Renders an employee's DiceBear pixel-art face as a crisp <img>, dressed up
 * like a 90s sci-fi videophone feed: a neon glow, a touch of transparency, a
 * barrel-distorted (curved-tube) bulge, CRT scanlines, constant TV snow, and an
 * occasional random signal blip. The heavier effects (bulge, snow, glass,
 * flicker) apply only to the larger "screen" avatars — tiny sidebar faces stay
 * crisp.
 */
export function EmployeeAvatar({ id, name, avatarConfig, size = 32, style }: EmployeeAvatarProps) {
  // Key the memo on primitives only so it recomputes exactly when the face changes.
  const cfgKey = typeof avatarConfig === 'string'
    ? avatarConfig
    : JSON.stringify(avatarConfig ?? null)
  const src = useMemo(
    () => avatarDataUri({ id, name, avatarConfig: cfgKey }),
    [id, name, cfgKey],
  )
  // Per-avatar random blip cadence + phase so the flickers never fire in sync.
  const signalAnim = useMemo(() => {
    const duration = (5 + Math.random() * 8).toFixed(2) // 5–13s between blips
    const delay = (-Math.random() * 12).toFixed(2)      // random phase offset
    return `crt-signal ${duration}s linear ${delay}s infinite`
  }, [id, name])
  // Only the larger "screen" avatars get the full CRT treatment — the barrel
  // filter + snow would turn tiny 28px sidebar faces to mush.
  const bulge = size >= 56

  return (
    <span
      style={{
        position: 'relative',
        display: 'inline-block',
        width: size,
        height: size,
        border: '2px solid var(--pixel-border)',
        background: 'var(--pixel-bg)',
        borderRadius: 0,
        flexShrink: 0,
        overflow: 'hidden',
        // Neon halo — soft amber-orange bloom around the frame.
        boxShadow: '0 0 4px rgba(255, 90, 31, 0.5), 0 0 12px rgba(255, 90, 31, 0.28)',
        ...style,
      }}
    >
      <img
        src={src}
        width={size}
        height={size}
        alt={name || 'avatar'}
        draggable={false}
        style={{
          display: 'block',
          width: '100%',
          height: '100%',
          imageRendering: 'pixelated',
          // Slightly translucent so the dark panel bleeds through like a
          // holographic feed.
          opacity: 0.82,
          // Barrel-distort the face pixels like a curved CRT tube.
          filter: bulge ? 'url(#crt-barrel)' : undefined,
        }}
      />
      {/* Scanlines — thin dark horizontal bands over the whole face. */}
      <span
        aria-hidden
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          backgroundImage:
            'repeating-linear-gradient(0deg, rgba(0,0,0,0.32) 0px, rgba(0,0,0,0.32) 1px, transparent 1px, transparent 3px)',
        }}
      />
      {/* Constant TV snow — an animated turbulence filter regenerating every
          frame, screen-blended so it reads as glowing static. */}
      {bulge && (
        <svg
          aria-hidden
          width="100%"
          height="100%"
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            mixBlendMode: 'screen',
            opacity: 0.5,
          }}
        >
          <rect width="100%" height="100%" filter="url(#crt-snow)" />
        </svg>
      )}
      {/* Warm scan-tint so the feed leans amber like a CRT phosphor. */}
      <span
        aria-hidden
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          background: 'rgba(255, 120, 40, 0.10)',
          mixBlendMode: 'overlay',
        }}
      />
      {/* Occasional signal blip — a quick brightness flash at random intervals. */}
      {bulge && (
        <span
          aria-hidden
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            background: 'rgba(255, 240, 220, 0.9)',
            mixBlendMode: 'screen',
            opacity: 0,
            animation: signalAnim,
          }}
        />
      )}
      {/* Curved glass — a top glare highlight and an edge vignette sell the
          bulge of the tube. Only on the larger screen avatars. */}
      {bulge && (
        <span
          aria-hidden
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            background:
              'radial-gradient(circle at 50% 14%, rgba(255,255,255,0.16) 0%, rgba(255,255,255,0) 55%),' +
              'radial-gradient(circle, rgba(0,0,0,0) 56%, rgba(0,0,0,0.55) 100%)',
          }}
        />
      )}
    </span>
  )
}
