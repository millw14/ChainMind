export function ChainMindLogo({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="radarBg" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="rgba(0,200,5,0.18)" />
          <stop offset="100%" stopColor="rgba(0,200,5,0.02)" />
        </radialGradient>
        <radialGradient id="blipGlow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="rgba(239,68,68,0.6)" />
          <stop offset="100%" stopColor="rgba(239,68,68,0)" />
        </radialGradient>
        <filter id="blipFilter">
          <feGaussianBlur stdDeviation="1" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      {/* Outer ring */}
      <circle cx="32" cy="32" r="28" fill="url(#radarBg)" stroke="rgba(0,200,5,0.25)" strokeWidth="1" />
      {/* Inner rings */}
      <circle cx="32" cy="32" r="18" fill="none" stroke="rgba(0,200,5,0.18)" strokeWidth="1" />
      <circle cx="32" cy="32" r="9" fill="none" stroke="rgba(0,200,5,0.18)" strokeWidth="1" />
      {/* Crosshairs */}
      <line x1="32" y1="5" x2="32" y2="59" stroke="rgba(0,200,5,0.1)" strokeWidth="0.75" />
      <line x1="5" y1="32" x2="59" y2="32" stroke="rgba(0,200,5,0.1)" strokeWidth="0.75" />
      {/* Sweep line */}
      <line x1="32" y1="32" x2="55" y2="18" stroke="rgba(74,222,128,0.75)" strokeWidth="1.5" strokeLinecap="round" />
      {/* Sweep trail */}
      <line x1="32" y1="32" x2="58" y2="28" stroke="rgba(74,222,128,0.2)" strokeWidth="1" strokeLinecap="round" />
      <line x1="32" y1="32" x2="57" y2="38" stroke="rgba(74,222,128,0.1)" strokeWidth="1" strokeLinecap="round" />
      {/* Blip glow */}
      <circle cx="50" cy="21" r="8" fill="url(#blipGlow)" />
      {/* Blip ring */}
      <circle cx="50" cy="21" r="5.5" fill="none" stroke="rgba(239,68,68,0.4)" strokeWidth="1" />
      {/* Blip core */}
      <circle cx="50" cy="21" r="3" fill="#ef4444" filter="url(#blipFilter)" />
      {/* Center node */}
      <circle cx="32" cy="32" r="3.5" fill="#00c805" />
      <circle cx="32" cy="32" r="1.5" fill="#c4b5fd" />
    </svg>
  );
}
