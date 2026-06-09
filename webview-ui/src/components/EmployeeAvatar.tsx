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

/** Renders an employee's DiceBear pixel-art face as a crisp <img>. */
export function EmployeeAvatar({ id, name, avatarConfig, size = 32, style }: EmployeeAvatarProps) {
  // Key the memo on primitives only so it recomputes exactly when the face changes.
  const cfgKey = typeof avatarConfig === 'string'
    ? avatarConfig
    : JSON.stringify(avatarConfig ?? null)
  const src = useMemo(
    () => avatarDataUri({ id, name, avatarConfig: cfgKey }),
    [id, name, cfgKey],
  )
  return (
    <img
      src={src}
      width={size}
      height={size}
      alt={name || 'avatar'}
      draggable={false}
      style={{
        width: size,
        height: size,
        imageRendering: 'pixelated',
        border: '2px solid var(--pixel-border)',
        background: 'var(--pixel-bg)',
        borderRadius: 0,
        flexShrink: 0,
        ...style,
      }}
    />
  )
}
