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

// A tileable fractal-noise square (SVG feTurbulence) used as the "static"
// grain drifting over each face. Encoded inline so it needs no network.
const STATIC_NOISE =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='64' height='64'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")"

/**
 * Renders an employee's DiceBear pixel-art face as a crisp <img>, dressed up
 * like a 90s sci-fi videophone feed: a neon glow, a touch of transparency, CRT
 * scanlines, and drifting static grain that occasionally flickers as if the
 * signal dips.
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
  // Per-avatar random flicker cadence + starting phase so no two "TVs" dip in
  // sync. Memoised on identity so it stays stable across re-renders (only the
  // linear timing + 1%-wide keyframe bands make each dip read as instant).
  const flicker = useMemo(() => {
    const duration = (1.6 + Math.random() * 3.8).toFixed(2) // 1.6–5.4s cycle
    const delay = (-Math.random() * 6).toFixed(2)           // random phase offset
    return `crt-static 0.6s steps(4) infinite, crt-flicker ${duration}s linear ${delay}s infinite`
  }, [id, name])
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
      {/* Static grain — drifting fractal noise, screen-blended so it reads as
          glowing specks, with an occasional signal-dip flicker. */}
      <span
        aria-hidden
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          backgroundImage: STATIC_NOISE,
          backgroundRepeat: 'repeat',
          mixBlendMode: 'screen',
          animation: flicker,
        }}
      />
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
    </span>
  )
}
