"use client";

import { useRef } from "react";
import {
  motion,
  useMotionValue,
  useScroll,
  useSpring,
  useTransform,
  useReducedMotion,
} from "framer-motion";

/**
 * Reveal — fade + translate children up into view via whileInView.
 * @param {{ children: import("react").ReactNode, y?: number, delay?: number, once?: boolean, className?: string }} props
 */
export function Reveal({ children, y = 24, delay = 0, once = true, className }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial={reduce ? { opacity: 1, y: 0 } : { opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once, margin: "0px 0px -12% 0px" }}
      transition={
        reduce
          ? { duration: 0 }
          : { type: "spring", stiffness: 280, damping: 30, mass: 0.9, delay }
      }
    >
      {children}
    </motion.div>
  );
}

/**
 * Parallax — translate children on Y as the element scrolls through the viewport.
 * @param {{ children: import("react").ReactNode, speed?: number, className?: string }} props
 */
export function Parallax({ children, speed = 0.2, className }) {
  const reduce = useReducedMotion();
  const ref = useRef(null);
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start end", "end start"],
  });
  const range = speed * 100;
  const raw = useTransform(scrollYProgress, [0, 1], [range, -range]);
  const y = useSpring(raw, { stiffness: 120, damping: 24, mass: 0.6 });
  return (
    <motion.div ref={ref} className={className} style={reduce ? undefined : { y }}>
      {children}
    </motion.div>
  );
}

/**
 * TiltCard — pointer-driven 3D tilt, spring-damped, reset on leave.
 * @param {{ children: import("react").ReactNode, max?: number, className?: string }} props
 */
export function TiltCard({ children, max = 8, className }) {
  const reduce = useReducedMotion();
  const ref = useRef(null);
  const rx = useMotionValue(0);
  const ry = useMotionValue(0);
  const rotateX = useSpring(rx, { stiffness: 300, damping: 26, mass: 0.5 });
  const rotateY = useSpring(ry, { stiffness: 300, damping: 26, mass: 0.5 });

  const coarse =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches;
  const disabled = reduce || coarse;

  function onMove(e) {
    if (disabled) return;
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width - 0.5;
    const py = (e.clientY - rect.top) / rect.height - 0.5;
    ry.set(px * max * 2);
    rx.set(-py * max * 2);
  }

  function onLeave() {
    rx.set(0);
    ry.set(0);
  }

  if (disabled) {
    return <motion.div className={className}>{children}</motion.div>;
  }

  return (
    <motion.div
      ref={ref}
      className={className}
      onPointerMove={onMove}
      onPointerLeave={onLeave}
      style={{ transformStyle: "preserve-3d", perspective: 800, rotateX, rotateY }}
    >
      {children}
    </motion.div>
  );
}
