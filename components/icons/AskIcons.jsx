/**
 * AskIcons — the stroke-only glyph set used by the ask overlay (chips, submit
 * button, close button, assistant avatar). Replaces the emoji that used to sit
 * in those slots: emoji are full-colour clip-art that render differently on
 * every OS and never match the surrounding mono type.
 *
 * Every icon shares one signature — `({ className = "", size = 16, ...rest })`
 * — so they are interchangeable anywhere a caller renders one from data. They
 * are stroke-only at 1.5px on a 24x24 grid and paint with `currentColor`, which
 * means a chip can tint its icon on hover with nothing but a `text-` class, and
 * the weight stays visually matched to the mono labels beside them at any size.
 *
 * `aria-hidden="true"` is the default because these always sit next to a text
 * label, so they are decorative. `...rest` is spread last, so a caller that
 * genuinely needs a labelled icon can override it (plus pass `style`, `onClick`,
 * data attributes, and so on).
 *
 * No "use client" directive on purpose: these are pure, stateless SVG and are
 * therefore valid in both server and client components.
 */

/**
 * Shared SVG shell. Holds every attribute that must stay identical across the
 * set, so a new icon only ever contributes its own path data.
 *
 * @param {Object} props
 * @param {string} [props.className] Utility classes; colour comes from a `text-` class.
 * @param {number} [props.size] Rendered width and height in px.
 * @param {React.ReactNode} props.children The path data for this glyph.
 * @returns {JSX.Element} A configured 24x24 `<svg>` element.
 */
function Glyph({ className, size, children, ...rest }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** Billfold with a clasp pocket. Used by the "Explain this wallet" chip. */
export function IconWallet({ className = "", size = 16, ...rest }) {
  return (
    <Glyph className={className} size={size} {...rest}>
      <rect x="3" y="6" width="18" height="13" rx="2.5" />
      <path d="M21 10.25h-3.5a1.75 1.75 0 0 0 0 3.5H21" />
      {/* The clasp stud reads better solid than as a 1.5px ring at 16px. */}
      <circle cx="17.9" cy="12" r="0.85" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

/** Rising polyline with an arrow head. Used by the "why did this move?" chip. */
export function IconTrend({ className = "", size = 16, ...rest }) {
  return (
    <Glyph className={className} size={size} {...rest}>
      <path d="M3 16.75 8.5 11.25l3.25 3.25L20.5 6" />
      <path d="M14.75 6h5.75v5.75" />
    </Glyph>
  );
}

/** Magnifier over a small route. Used by the "trace this transaction" chip. */
export function IconTrace({ className = "", size = 16, ...rest }) {
  return (
    <Glyph className={className} size={size} {...rest}>
      <circle cx="10.5" cy="10.5" r="6.75" />
      <path d="M15.4 15.4 20.5 20.5" />
      {/* Kept to three points so the hop path survives the 16px render. */}
      <path d="M7.5 12.4 10.25 9.4l2.85 3" />
    </Glyph>
  );
}

/** Lightning outline. Used by the "what is Robinhood Chain?" chip. */
export function IconBolt({ className = "", size = 16, ...rest }) {
  return (
    <Glyph className={className} size={size} {...rest}>
      <path d="M13 2.75 5.5 13.25h5.25L10 21.25 18.5 10.75h-5.25z" />
    </Glyph>
  );
}

/** Three ascending bars. Used by the "rank the market" chip. */
export function IconRank({ className = "", size = 16, ...rest }) {
  return (
    <Glyph className={className} size={size} {...rest}>
      <path d="M4.75 19.25V13M12 19.25V8.5M19.25 19.25V4.75" />
    </Glyph>
  );
}

/** Two opposed bars, longest against shortest. Used by the "compare" chip. */
export function IconCompare({ className = "", size = 16, ...rest }) {
  return (
    <Glyph className={className} size={size} {...rest}>
      <path d="M4 8.5h11.5M4 8.5l2.75-2.75M4 8.5l2.75 2.75" />
      <path d="M20 15.5H8.5M20 15.5l-2.75-2.75M20 15.5l-2.75 2.75" />
    </Glyph>
  );
}

/** Shield with a check. Used by the "is it genuine" chip. */
export function IconShield({ className = "", size = 16, ...rest }) {
  return (
    <Glyph className={className} size={size} {...rest}>
      <path d="M12 3.25 5 6v5.25c0 4.1 2.85 7.7 7 9.5 4.15-1.8 7-5.4 7-9.5V6z" />
      <path d="M9.25 11.75 11.5 14l3.5-4" />
    </Glyph>
  );
}

/** Upward arrow. Used inside the overlay's submit button. */
export function IconSend({ className = "", size = 16, ...rest }) {
  return (
    <Glyph className={className} size={size} {...rest}>
      <path d="M12 19.5V5M12 5l-6 6M12 5l6 6" />
    </Glyph>
  );
}

/** Plain X. Used by the overlay's dismiss button. */
export function IconClose({ className = "", size = 16, ...rest }) {
  return (
    <Glyph className={className} size={size} {...rest}>
      <path d="M6 6l12 12M18 6L6 18" />
    </Glyph>
  );
}

/** Framed grid with a header row. Used by the "see the whole table" chip. */
export function IconTable({ className = "", size = 16, ...rest }) {
  return (
    <Glyph className={className} size={size} {...rest}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M3.5 9.5h17M9.75 9.5v10" />
    </Glyph>
  );
}

/** Two offset sheets. Used by a table's Copy button. */
export function IconCopy({ className = "", size = 16, ...rest }) {
  return (
    <Glyph className={className} size={size} {...rest}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M15 6.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h.5" />
    </Glyph>
  );
}

/** Arrow into a tray. Used by a table's Download button. */
export function IconDownload({ className = "", size = 16, ...rest }) {
  return (
    <Glyph className={className} size={size} {...rest}>
      <path d="M12 3.75v10.5M12 14.25l-3.5-3.5M12 14.25l3.5-3.5" />
      <path d="M4.75 16.5v1.75a2 2 0 0 0 2 2h10.5a2 2 0 0 0 2-2V16.5" />
    </Glyph>
  );
}

/** Bare tick. The Copy button wears it for a moment after a successful copy. */
export function IconCheck({ className = "", size = 16, ...rest }) {
  return (
    <Glyph className={className} size={size} {...rest}>
      <path d="M5 12.5 9.75 17.25 19 7.5" />
    </Glyph>
  );
}

/** Four-point sparkle with concave sides. Used for the assistant avatar. */
export function IconSparkle({ className = "", size = 16, ...rest }) {
  return (
    <Glyph className={className} size={size} {...rest}>
      <path d="M12 3.5C12 8 8 12 3.5 12 8 12 12 16 12 20.5 12 16 16 12 20.5 12 16 12 12 8 12 3.5Z" />
    </Glyph>
  );
}
