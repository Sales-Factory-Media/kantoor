import type { KnownProject } from '../hooks/useExtensionMessages.js'

/**
 * Resolve a project's logo (a data URI) given a character's workspace path
 * and/or its display project name. Workspace path is the reliable key; the
 * name is a fallback for characters that don't carry a path.
 */
export function makeProjectLogoLookup(knownProjects: KnownProject[]) {
  const byPath = new Map<string, string>()
  const byName = new Map<string, string>()
  for (const p of knownProjects) {
    if (!p.logo) continue
    if (p.workspacePath) byPath.set(p.workspacePath, p.logo)
    if (p.name) byName.set(p.name, p.logo)
  }
  return (workspacePath?: string, name?: string): string | undefined => {
    if (workspacePath && byPath.has(workspacePath)) return byPath.get(workspacePath)
    if (name && byName.has(name)) return byName.get(name)
    return undefined
  }
}

/**
 * Read an uploaded image File and return a downscaled PNG data URI (fit within
 * `maxSize`×`maxSize`, aspect preserved). Downscaling keeps the value small
 * enough to store inline in the DB and ship over the WebSocket.
 */
export function fileToLogoDataUri(file: File, maxSize = 64): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'))
    reader.onload = () => {
      const img = new Image()
      img.onerror = () => reject(new Error('Not a valid image'))
      img.onload = () => {
        const scale = Math.min(1, maxSize / Math.max(img.width, img.height))
        const w = Math.max(1, Math.round(img.width * scale))
        const h = Math.max(1, Math.round(img.height * scale))
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        if (!ctx) return reject(new Error('Canvas unavailable'))
        ctx.drawImage(img, 0, 0, w, h)
        resolve(canvas.toDataURL('image/png'))
      }
      img.src = reader.result as string
    }
    reader.readAsDataURL(file)
  })
}

/**
 * Small square project logo rendered inline before a project name. Renders
 * nothing when the project has no logo, so callers can drop it in
 * unconditionally.
 */
export function ProjectLogo({ logo, size = 16 }: { logo?: string; size?: number }) {
  if (!logo) return null
  return (
    <img
      src={logo}
      alt=""
      width={size}
      height={size}
      style={{
        width: size,
        height: size,
        objectFit: 'contain',
        flexShrink: 0,
        borderRadius: 2,
        display: 'block',
      }}
    />
  )
}
