interface ActivityBarsProps {
  /** Bar colour. Defaults to the amber accent. */
  color?: string
  /** Overall height in px — sized to sit on a text line. */
  height?: number
  /** Number of bars. */
  bars?: number
}

// Per-bar dance timing (seconds). Hand-picked so the ripple looks lively and
// irregular rather than a clean wave. One entry per bar.
const DURATIONS = [0.9, 0.65, 1.05, 0.75, 0.85]
const DELAYS = [0, 0.18, 0.36, 0.12, 0.28]

/**
 * A tiny inline "equalizer" — a row of thin bars each bouncing up and down on a
 * staggered loop, the kind of live-activity indicator you see on slick
 * dashboards. Meant to sit inline before a label like "Working…".
 */
export function ActivityBars({ color = 'var(--pixel-accent)', height = 11, bars = 4 }: ActivityBarsProps) {
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-flex',
        alignItems: 'flex-end',
        gap: 2,
        height,
        marginRight: 5,
        verticalAlign: 'middle',
      }}
    >
      {Array.from({ length: bars }).map((_, i) => (
        <span
          key={i}
          style={{
            width: 2,
            height: '100%',
            background: color,
            transformOrigin: 'bottom',
            animation: `eq-bounce ${DURATIONS[i % DURATIONS.length]}s ease-in-out ${DELAYS[i % DELAYS.length]}s infinite`,
          }}
        />
      ))}
    </span>
  )
}
