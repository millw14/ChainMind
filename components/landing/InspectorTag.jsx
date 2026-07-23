"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useReducedMotion } from "framer-motion";

/** Share of the remaining distance the tooltip covers each frame. */
const LERP = 0.2;

/** Cursor offset for the property tooltip, in px. */
const OFFSET_X = 16;
const OFFSET_Y = 14;

/** Below this the tooltip is considered parked and the rAF loop stops. */
const SETTLE_EPSILON = 0.15;

/** Size of the selection corner handles, in px. */
const HANDLE = 6;

/**
 * Corner handle positions for the selection outline. Offset by half the handle
 * size so each square straddles its corner the way a design tool draws them.
 */
const HANDLE_SPOTS = [
  { top: -HANDLE / 2, left: -HANDLE / 2 },
  { top: -HANDLE / 2, right: -HANDLE / 2 },
  { bottom: -HANDLE / 2, left: -HANDLE / 2 },
  { bottom: -HANDLE / 2, right: -HANDLE / 2 },
];

/**
 * True when the visitor is on a touch-style pointer. Guarded for SSR and for
 * browsers without matchMedia, both of which fall back to "fine pointer".
 */
function isCoarsePointer() {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(pointer: coarse)").matches;
}

/**
 * useInspectorHover — bare hover state with no visuals attached.
 *
 * Returns `hovered` plus a `bind` object of pointer handlers to spread onto any
 * element. Handy when a caller wants to react to the same hover that drives an
 * `InspectorTag` (dimming siblings, swapping a label) without rendering the
 * annotation chrome itself. Pointer events are used rather than mouse events so
 * a stylus or touch also reports correctly, and `onPointerCancel` is included so
 * the state cannot get stuck on if the gesture is interrupted.
 *
 * @returns {{hovered: boolean, bind: {onPointerEnter: Function, onPointerLeave: Function, onPointerCancel: Function}}}
 */
export function useInspectorHover() {
  const [hovered, setHovered] = useState(false);

  const enter = useCallback(() => setHovered(true), []);
  const leave = useCallback(() => setHovered(false), []);

  return {
    hovered,
    bind: {
      onPointerEnter: enter,
      onPointerLeave: leave,
      onPointerCancel: leave,
    },
  };
}

/**
 * InspectorTag — wraps arbitrary children in design-tool style annotations.
 *
 * On hover the wrapper behaves like a selected layer in a vector editor: a
 * dashed accent outline with four corner handles snaps around the content, a
 * small layer-name pill fades in above it, and — when `prop`/`value` are given —
 * a monospace property tooltip trails the cursor with lerped easing.
 *
 * The trailing tooltip is driven by a single requestAnimationFrame loop that
 * writes `transform` straight to the tooltip node; React state is never touched
 * per frame. The loop starts on pointer enter, parks itself once the tooltip has
 * settled within a sub-pixel of the target, and is always cancelled on unmount.
 *
 * Children are rendered plainly (no wrapper chrome, no listeners, no rAF) when
 * the visitor prefers reduced motion or is on a coarse pointer, where hover
 * annotations are meaningless. Because every annotation is an additive overlay
 * that is `pointer-events-none`, the wrapped content is always fully visible and
 * fully interactive whether or not any animation ever runs.
 *
 * @param {Object} props
 * @param {React.ReactNode} props.children Content to annotate; rendered untouched.
 * @param {string} [props.layer] Layer-name text for the pill above the element, e.g. "h1 / Wordmark".
 * @param {string} [props.prop] Property name for the cursor tooltip, e.g. "tracking". Omit to hide the tooltip.
 * @param {string|number} [props.value] Property value shown after the arrow, e.g. "-0.05em".
 * @param {string} [props.accent="var(--cm-accent)"] Colour for the pill, outline and handles.
 * @param {string} [props.className=""] Extra classes for the wrapper element.
 * @returns {JSX.Element}
 */
export default function InspectorTag({
  children,
  layer,
  prop,
  value,
  accent = "var(--cm-accent)",
  className = "",
}) {
  const reduce = useReducedMotion();

  // Start inert so SSR and the first client paint agree; annotations are opted
  // into only after we can actually measure the input device.
  const [annotated, setAnnotated] = useState(false);
  const [hovered, setHovered] = useState(false);

  const wrapRef = useRef(null);
  const tipRef = useRef(null);

  // Per-frame geometry lives in refs so the rAF loop never re-renders anything.
  const targetRef = useRef({ x: 0, y: 0 });
  const posRef = useRef({ x: 0, y: 0 });
  const rafRef = useRef(0);
  const runningRef = useRef(false);
  const primedRef = useRef(false);

  const showTip = Boolean(prop) && annotated;

  /* Decide once (and on media-query change) whether annotations apply at all. */
  useEffect(() => {
    if (reduce) {
      setAnnotated(false);
      return undefined;
    }
    if (typeof window === "undefined" || !window.matchMedia) {
      setAnnotated(true);
      return undefined;
    }
    const coarse = window.matchMedia("(pointer: coarse)");
    const apply = () => setAnnotated(!coarse.matches);
    apply();
    if (coarse.addEventListener) coarse.addEventListener("change", apply);
    else if (coarse.addListener) coarse.addListener(apply);
    return () => {
      if (coarse.removeEventListener) coarse.removeEventListener("change", apply);
      else if (coarse.removeListener) coarse.removeListener(apply);
    };
  }, [reduce]);

  /** Writes the current lerped position to the tooltip node. */
  const paint = useCallback(() => {
    const node = tipRef.current;
    if (!node) return;
    const { x, y } = posRef.current;
    node.style.transform =
      "translate3d(" + Math.round(x) + "px, " + Math.round(y) + "px, 0)";
  }, []);

  /** Single shared rAF loop; self-parks once the tooltip has caught up. */
  const step = useCallback(() => {
    const pos = posRef.current;
    const target = targetRef.current;
    const dx = target.x - pos.x;
    const dy = target.y - pos.y;

    pos.x += dx * LERP;
    pos.y += dy * LERP;

    const settled = Math.abs(dx) < SETTLE_EPSILON && Math.abs(dy) < SETTLE_EPSILON;
    if (settled) {
      pos.x = target.x;
      pos.y = target.y;
    }
    paint();

    if (settled) {
      runningRef.current = false;
      rafRef.current = 0;
      return;
    }
    rafRef.current = requestAnimationFrame(step);
  }, [paint]);

  const ensureLoop = useCallback(() => {
    if (runningRef.current) return;
    runningRef.current = true;
    rafRef.current = requestAnimationFrame(step);
  }, [step]);

  const handleEnter = useCallback(
    (event) => {
      if (!annotated) return;
      const el = wrapRef.current;
      if (el && prop) {
        const rect = el.getBoundingClientRect();
        targetRef.current = {
          x: event.clientX - rect.left + OFFSET_X,
          y: event.clientY - rect.top + OFFSET_Y,
        };
        // First entry: snap so the pill can't sweep in from the origin corner.
        if (!primedRef.current) {
          primedRef.current = true;
          posRef.current = { ...targetRef.current };
          paint();
        }
      }
      setHovered(true);
    },
    [annotated, prop, paint]
  );

  const handleMove = useCallback(
    (event) => {
      if (!annotated || !prop) return;
      const el = wrapRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      targetRef.current = {
        x: event.clientX - rect.left + OFFSET_X,
        y: event.clientY - rect.top + OFFSET_Y,
      };
      ensureLoop();
    },
    [annotated, prop, ensureLoop]
  );

  const handleLeave = useCallback(() => {
    setHovered(false);
  }, []);

  /* Position the tooltip before its first paint so it never flashes at 0,0. */
  useEffect(() => {
    if (!showTip) {
      primedRef.current = false;
      return;
    }
    const node = tipRef.current;
    if (node && !primedRef.current) {
      node.style.transform = "translate3d(-9999px, -9999px, 0)";
    }
  }, [showTip]);

  /* Cancel any in-flight frame on unmount. */
  useEffect(
    () => () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      runningRef.current = false;
    },
    []
  );

  /* Drop the hover state if the tab or window goes away mid-hover. */
  useEffect(() => {
    if (!annotated) return undefined;
    const clear = () => setHovered(false);
    window.addEventListener("blur", clear);
    document.addEventListener("visibilitychange", clear);
    return () => {
      window.removeEventListener("blur", clear);
      document.removeEventListener("visibilitychange", clear);
    };
  }, [annotated]);

  // Reduced motion / touch: plain passthrough wrapper, zero chrome, zero work.
  if (!annotated) {
    return <span className={className ? "relative " + className : "relative"}>{children}</span>;
  }

  return (
    <span
      ref={wrapRef}
      className={"relative inline-block " + className}
      onPointerEnter={handleEnter}
      onPointerMove={handleMove}
      onPointerLeave={handleLeave}
      onPointerCancel={handleLeave}
    >
      {children}

      {/* Selection outline + corner handles. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 block"
        style={{
          border: "1px dashed " + accent,
          opacity: hovered ? 1 : 0,
          transition: "opacity 180ms ease",
        }}
      >
        {HANDLE_SPOTS.map((spot, i) => (
          <span
            key={i}
            className="pointer-events-none absolute block"
            style={{
              ...spot,
              width: HANDLE,
              height: HANDLE,
              background: "var(--cm-bg)",
              border: "1px solid " + accent,
            }}
          />
        ))}
      </span>

      {/* Layer name pill. */}
      {layer ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-0 select-none whitespace-nowrap rounded-sm px-2 py-1 font-mono text-[10px] leading-none"
          style={{
            top: -28,
            background: accent,
            color: "var(--cm-on-accent)",
            opacity: hovered ? 1 : 0,
            transform: hovered ? "translateY(0)" : "translateY(4px)",
            transition: "opacity 180ms ease, transform 180ms ease",
          }}
        >
          {layer}
        </span>
      ) : null}

      {/* Property tooltip trailing the cursor. */}
      {showTip ? (
        <span
          ref={tipRef}
          aria-hidden="true"
          className="pointer-events-none absolute left-0 top-0 z-10 select-none whitespace-nowrap rounded-md border border-cm-border bg-cm-surface px-2 py-1 font-mono text-[10px] leading-none text-cm-muted"
          style={{
            opacity: hovered ? 1 : 0,
            transition: "opacity 180ms ease",
            willChange: "transform",
          }}
        >
          <span className="text-cm-faint">{prop}</span>
          <span className="px-1 text-cm-faint">{"->"}</span>
          <span className="text-cm-text">{value}</span>
        </span>
      ) : null}
    </span>
  );
}
