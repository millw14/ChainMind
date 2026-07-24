"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const EASE_BACK = "cubic-bezier(0.16,1,0.3,1)";
const EASE_BACK_MS = 600;
const HANDLE_BORDER = { border: "1px solid var(--cm-accent)" };

function formatReadout(x, y) {
  return "x: " + Math.round(x) + "  y: " + Math.round(y);
}

/**
 * DraggableWordmark
 *
 * Hero centerpiece wordmark presented as a "selected object" in a design tool:
 * line one solid, line two outline-only, wrapped in a dashed selection box with
 * four corner handles and a hint pill. On fine-pointer devices without a
 * reduced-motion preference the whole block is genuinely draggable — the pointer
 * delta is written straight to `transform` via a ref (no React state per frame),
 * and on release the block eases back to origin over ~0.6s. The CSS transition
 * exists only during that ease-back, so dragging itself stays exactly 1:1.
 *
 * On coarse pointers (touch) or when the user prefers reduced motion, the drag
 * wiring is skipped and the wordmark renders as a calm static object. The
 * wordmark, selection box and hint are always painted and fully visible —
 * nothing here depends on an animation having run.
 *
 * @param {Object} props
 * @param {string} [props.top="CHAIN"] Solid first line of the wordmark.
 * @param {string} [props.bottom="MIND"] Outlined second line of the wordmark.
 * @param {string} [props.hint="Drag to move"] Text shown in the pill above the selection box.
 * @param {string} [props.className=""] Extra classes for the outer wrapper.
 * @returns {JSX.Element}
 */
export default function DraggableWordmark({
  top = "CHAIN",
  bottom = "MIND",
  hint = "Drag to move",
  className = "",
}) {
  // Static by default, so the first paint (and the SSR/no-JS pass) is always the
  // safe fully-visible version. Drag is opted into only after we can measure input.
  const [interactive, setInteractive] = useState(false);
  const [dragging, setDragging] = useState(false);

  const blockRef = useRef(null);
  const readoutRef = useRef(null);

  const activeRef = useRef(false);
  const pointerIdRef = useRef(null);
  const startRef = useRef({ x: 0, y: 0 });
  const releaseTimerRef = useRef(null);
  const mountedRef = useRef(true);
  // Holds the (stable) pointerup/pointercancel handler so add/remove always
  // reference exactly the same function object.
  const endHandlerRef = useRef(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /* ------------------------------------------------------------------ *
   * Input capability
   * ------------------------------------------------------------------ */

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return undefined;
    }

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    const fine = window.matchMedia("(pointer: fine)");

    const sync = () => {
      if (!mountedRef.current) return;
      setInteractive(fine.matches && !reduce.matches);
    };

    sync();

    const listen = (mql) => {
      if (typeof mql.addEventListener === "function") {
        mql.addEventListener("change", sync);
        return () => mql.removeEventListener("change", sync);
      }
      mql.addListener(sync); // legacy Safari
      return () => mql.removeListener(sync);
    };

    const unlistenReduce = listen(reduce);
    const unlistenFine = listen(fine);

    return () => {
      unlistenReduce();
      unlistenFine();
    };
  }, []);

  /* ------------------------------------------------------------------ *
   * Drag
   * ------------------------------------------------------------------ */

  const handleMove = useCallback((event) => {
    if (!activeRef.current) return;
    const node = blockRef.current;
    if (!node) return;

    const dx = event.clientX - startRef.current.x;
    const dy = event.clientY - startRef.current.y;

    node.style.transform = "translate3d(" + dx + "px, " + dy + "px, 0)";
    if (readoutRef.current) readoutRef.current.textContent = formatReadout(dx, dy);
  }, []);

  // Removes the per-drag listeners and releases pointer capture. Safe to call
  // more than once and safe to call when no drag is in flight.
  const detach = useCallback(() => {
    const node = blockRef.current;
    if (!node) return;

    node.removeEventListener("pointermove", handleMove);
    if (endHandlerRef.current) {
      node.removeEventListener("pointerup", endHandlerRef.current);
      node.removeEventListener("pointercancel", endHandlerRef.current);
    }

    if (pointerIdRef.current !== null) {
      try {
        if (
          typeof node.hasPointerCapture === "function" &&
          node.hasPointerCapture(pointerIdRef.current)
        ) {
          node.releasePointerCapture(pointerIdRef.current);
        }
      } catch (err) {
        // Pointer already gone; nothing to release.
      }
      pointerIdRef.current = null;
    }
  }, [handleMove]);

  const handleEnd = useCallback(() => {
    detach();
    activeRef.current = false;

    const node = blockRef.current;
    if (node) {
      // Transition is added ONLY on release, then stripped once settled.
      node.style.transition = "transform " + EASE_BACK_MS + "ms " + EASE_BACK;
      node.style.transform = "translate3d(0px, 0px, 0)";

      if (releaseTimerRef.current !== null) clearTimeout(releaseTimerRef.current);
      releaseTimerRef.current = setTimeout(() => {
        releaseTimerRef.current = null;
        const settled = blockRef.current;
        if (settled && !activeRef.current) settled.style.transition = "none";
      }, EASE_BACK_MS + 40);
    }

    if (mountedRef.current) setDragging(false);
  }, [detach]);

  // Keep the ref pointing at the stable handler for add/removeEventListener.
  endHandlerRef.current = handleEnd;

  const onPointerDown = useCallback(
    (event) => {
      if (!interactive) return;
      if (typeof event.button === "number" && event.button !== 0) return;

      const node = blockRef.current;
      if (!node) return;

      // A drag can start mid-ease-back; cancel the pending cleanup.
      if (releaseTimerRef.current !== null) {
        clearTimeout(releaseTimerRef.current);
        releaseTimerRef.current = null;
      }
      detach();

      activeRef.current = true;
      pointerIdRef.current = event.pointerId;
      startRef.current = { x: event.clientX, y: event.clientY };

      node.style.transition = "none";
      node.style.transform = "translate3d(0px, 0px, 0)";

      try {
        node.setPointerCapture(event.pointerId);
      } catch (err) {
        // Capture is a nicety, not a requirement.
      }

      node.addEventListener("pointermove", handleMove);
      node.addEventListener("pointerup", handleEnd);
      node.addEventListener("pointercancel", handleEnd);

      setDragging(true);
    },
    [interactive, detach, handleMove, handleEnd]
  );

  // Teardown on unmount.
  useEffect(() => {
    return () => {
      const node = blockRef.current;
      if (node) {
        node.removeEventListener("pointermove", handleMove);
        if (endHandlerRef.current) {
          node.removeEventListener("pointerup", endHandlerRef.current);
          node.removeEventListener("pointercancel", endHandlerRef.current);
        }
      }
      if (releaseTimerRef.current !== null) {
        clearTimeout(releaseTimerRef.current);
        releaseTimerRef.current = null;
      }
      activeRef.current = false;
      pointerIdRef.current = null;
    };
  }, [handleMove]);

  // If the user flips to reduced motion / a coarse pointer mid-drag, bail out
  // cleanly instead of leaving a half-dragged block behind.
  useEffect(() => {
    if (interactive) return;
    detach();
    activeRef.current = false;
    if (releaseTimerRef.current !== null) {
      clearTimeout(releaseTimerRef.current);
      releaseTimerRef.current = null;
    }
    const node = blockRef.current;
    if (node) {
      node.style.transition = "none";
      node.style.transform = "translate3d(0px, 0px, 0)";
    }
    setDragging(false);
  }, [interactive, detach]);

  /* ------------------------------------------------------------------ *
   * Render — everything below is always visible.
   * ------------------------------------------------------------------ */

  const lineClass =
    "block text-center text-[clamp(3.5rem,17vw,14rem)] font-semibold uppercase leading-[0.82] tracking-[-0.045em]";

  return (
    <div className={"relative w-full select-none " + className}>
      <div
        ref={blockRef}
        onPointerDown={interactive ? onPointerDown : undefined}
        style={{
          transform: "translate3d(0px, 0px, 0)",
          transition: "none",
          touchAction: interactive ? "none" : "auto",
          willChange: interactive ? "transform" : "auto",
        }}
        className={
          "relative mx-auto w-fit " +
          (interactive ? "cursor-grab active:cursor-grabbing" : "cursor-default")
        }
      >
        {/* Selection box — wraps ONLY the top line. */}
        <div className="relative px-3 py-1" style={{ border: "1px dashed var(--cm-accent)" }}>
          {/* Hint pill, centered above the box. */}
          <span className="pointer-events-none absolute left-1/2 top-0 -translate-x-1/2 -translate-y-[calc(100%+8px)] whitespace-nowrap rounded-sm bg-cm-accent px-2 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-cm-on-accent">
            {hint}
          </span>

          {/* Live offset readout — mounted only while dragging, updated by ref. */}
          {dragging ? (
            <span
              ref={readoutRef}
              aria-hidden="true"
              className="pointer-events-none absolute right-0 top-0 -translate-y-[calc(100%+8px)] whitespace-pre rounded-sm border border-cm-border bg-cm-surface px-2 py-1 font-mono text-[10px] text-cm-muted"
            >
              {formatReadout(0, 0)}
            </span>
          ) : null}

          <span className={lineClass + " text-cm-text"}>{top}</span>

          {/* Four 8x8 corner handles straddling the dashed border. */}
          <span
            aria-hidden="true"
            className="pointer-events-none absolute left-0 top-0 h-2 w-2 -translate-x-1/2 -translate-y-1/2 bg-cm-bg"
            style={HANDLE_BORDER}
          />
          <span
            aria-hidden="true"
            className="pointer-events-none absolute right-0 top-0 h-2 w-2 translate-x-1/2 -translate-y-1/2 bg-cm-bg"
            style={HANDLE_BORDER}
          />
          <span
            aria-hidden="true"
            className="pointer-events-none absolute bottom-0 left-0 h-2 w-2 -translate-x-1/2 translate-y-1/2 bg-cm-bg"
            style={HANDLE_BORDER}
          />
          <span
            aria-hidden="true"
            className="pointer-events-none absolute bottom-0 right-0 h-2 w-2 translate-x-1/2 translate-y-1/2 bg-cm-bg"
            style={HANDLE_BORDER}
          />
        </div>

        {/* Outline line — always painted, never animated. */}
        <span
          className={lineClass}
          style={{ color: "transparent", WebkitTextStroke: "1.5px var(--cm-text)" }}
        >
          {bottom}
        </span>
      </div>
    </div>
  );
}
