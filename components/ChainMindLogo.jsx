export function ChainMindLogo({ size = 28, animate = false }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="threatGlow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="rgba(239,68,68,0.5)" />
          <stop offset="100%" stopColor="rgba(239,68,68,0)" />
        </radialGradient>
        <filter id="glow">
          <feGaussianBlur stdDeviation="1.5" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      {/* Edges */}
      <line x1="20" y1="12" x2="44" y2="32" stroke="rgba(139,92,246,0.55)" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="20" y1="52" x2="44" y2="32" stroke="rgba(139,92,246,0.55)" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="20" y1="12" x2="20" y2="52" stroke="rgba(139,92,246,0.25)" strokeWidth="1" strokeLinecap="round" />
      {/* Outer nodes */}
      <circle cx="20" cy="12" r="5" fill="#1e1b2e" stroke="rgba(139,92,246,0.75)" strokeWidth="1.5" />
      <circle cx="20" cy="52" r="5" fill="#1e1b2e" stroke="rgba(139,92,246,0.75)" strokeWidth="1.5" />
      {/* Threat node glow */}
      <circle cx="44" cy="32" r="10" fill="url(#threatGlow)" />
      {/* Threat node */}
      <circle cx="44" cy="32" r="6.5" fill="#7f1d1d" stroke="rgba(239,68,68,0.85)" strokeWidth="1.5" filter="url(#glow)" />
      <circle cx="44" cy="32" r="2.5" fill="#ef4444" />
    </svg>
  );
}
