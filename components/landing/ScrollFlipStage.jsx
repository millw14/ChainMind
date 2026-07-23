"use client";

import { useEffect, useRef, useState } from "react";
import {
  motion,
  useReducedMotion,
  useScroll,
  useSpring,
  useTransform,
} from "framer-motion";

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

/** Query that disqualifies the 3D treatment: touch input or a phone-sized viewport. */
const DEGRADE_QUERY = "(pointer: coarse), (max-width: 767px)";

/** Spring feel — heavy enough that the board reads as a physical object. */
const SPRING = { stiffness: 90, damping: 24, restDelta: 0.001 };

/** End-state values for the flip. */
const END_SCALE = 0.72;
const END_Y_VH = -14;
const END_OPACITY = 0.15;

/** If the stage never measures after this long, drop back to plain flow. */
const MEASURE_FAILSAFE_MS = 1500;

function cx(...parts) {
  return parts.filter(Boolean).join(" ");
}

function clampRotate(value) {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 62;
  return Math.max(0, Math.min(85, n));
}

/* -------------------------------------------------------------------------- */
/* Component                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * ScrollFlipStage — the signature opening scroll move.
 *
 * Wraps a hero (or any section) in a sticky 3D "stage" and treats it as a
 * physical artboard: as the reader scrolls past, the board hinges backwards
 * from near its top edge, shrinks, lifts and fades, revealing whatever section
 * follows it in the document. Progress is driven purely by scroll position
 * (`useScroll` over the tall outer track), and every channel is routed through
 * a spring so the board carries weight instead of snapping.
 *
 * Safety / degradation contract:
 * - At scroll progress 0 every channel resolves to its identity value
 *   (rotateX 0deg, scale 1, y 0, opacity 1), so the hero looks completely
 *   untouched before the first scroll.
 * - Content is never permanently hidden: opacity is a pure function of scroll
 *   and defaults to 1, so if the scroll listener never runs the children simply
 *   stay fully visible.
 * - `prefers-reduced-motion`, coarse pointers and sub-768px viewports render a
 *   plain relative container — no sticky, no perspective, no transforms.
 * - The same plain container is used during SSR / first paint, and if the stage
 *   somehow fails to measure the component falls back to it permanently.
 *
 * @param {object} props
 * @param {import("react").ReactNode} props.children Section to mount on the board (typically the hero).
 * @param {string} [props.scrollLength="180vh"] Height of the outer scroll track; more height = slower flip.
 * @param {number} [props.maxRotate=62] Degrees of rotateX at the end of the flip (clamped 0–85).
 * @param {string} [props.className] Extra classes for the outer track element.
 * @returns {JSX.Element}
 */
export default function ScrollFlipStage({
  children,
  scrollLength = "180vh",
  maxRotate = 62,
  className,
}) {
  const outerRef = useRef(null);
  const prefersReducedMotion = useReducedMotion();

  // Start in the plain, guaranteed-visible mode. The 3D stage is opt-in and is
  // only enabled once the client has confirmed it is appropriate, which also
  // keeps server and first client render identical.
  const [enhanced, setEnhanced] = useState(false);

  /* -- Capability probe ---------------------------------------------------- */
  useEffect(() => {
    if (prefersReducedMotion) {
      setEnhanced(false);
      return undefined;
    }
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return undefined;
    }

    const mql = window.matchMedia(DEGRADE_QUERY);
    const sync = () => setEnhanced(!mql.matches);

    sync();

    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", sync);
      return () => mql.removeEventListener("change", sync);
    }
    // Older Safari.
    mql.addListener(sync);
    return () => mql.removeListener(sync);
  }, [prefersReducedMotion]);

  /* -- Failsafe: if the track never gets a height, stop pretending ---------- */
  useEffect(() => {
    if (!enhanced || typeof window === "undefined") return undefined;

    const id = window.setTimeout(() => {
      const el = outerRef.current;
      if (!el) return;
      if (el.getBoundingClientRect().height < 1) setEnhanced(false);
    }, MEASURE_FAILSAFE_MS);

    return () => window.clearTimeout(id);
  }, [enhanced]);

  /* -- Scroll progress ----------------------------------------------------- */
  // Hooks always run (order is stable) even when we render the plain fallback.
  const { scrollYProgress } = useScroll({
    target: outerRef,
    offset: ["start start", "end start"],
    layoutEffect: false,
  });

  const rotateEnd = clampRotate(maxRotate);

  const rotateRaw = useTransform(scrollYProgress, [0, 1], [0, rotateEnd]);
  const scaleRaw = useTransform(scrollYProgress, [0, 1], [1, END_SCALE]);
  const yRaw = useTransform(scrollYProgress, [0, 1], [0, END_Y_VH]);
  const opacityRaw = useTransform(scrollYProgress, [0, 1], [1, END_OPACITY]);

  const rotateX = useSpring(rotateRaw, SPRING);
  const scale = useSpring(scaleRaw, SPRING);
  const ySpring = useSpring(yRaw, SPRING);
  const opacity = useSpring(opacityRaw, SPRING);

  // `y` is expressed in viewport units so the lift scales with the stage.
  // Resolving to a plain numeric 0 at rest lets framer-motion collapse the
  // whole transform to `none`, so the hero is genuinely untransformed at
  // progress 0 (no stray containing block, no compositing seams).
  const y = useTransform(ySpring, (v) => (Math.abs(v) < 0.001 ? 0 : `${v}vh`));

  /* -- Plain fallback ------------------------------------------------------ */
  if (!enhanced) {
    return (
      <div ref={outerRef} className={cx("relative w-full", className)}>
        {children}
      </div>
    );
  }

  /* -- 3D stage ------------------------------------------------------------ */
  return (
    <div
      ref={outerRef}
      className={cx("relative w-full", className)}
      style={{ height: scrollLength }}
    >
      <div
        className="sticky top-0 flex w-full items-center justify-center"
        style={{
          height: "100svh",
          perspective: "1400px",
          perspectiveOrigin: "50% 30%",
        }}
      >
        <motion.div
          className="transform-gpu h-full w-full overflow-hidden rounded-2xl border border-cm-border-subtle bg-cm-bg"
          style={{
            rotateX,
            scale,
            y,
            opacity,
            transformOrigin: "50% 15%",
            willChange: "transform, opacity",
          }}
        >
          {children}
        </motion.div>
      </div>
    </div>
  );
}
