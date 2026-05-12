/** Spring presets + variants for Framer Motion (ChainMind). */

export const springSnappy = { type: "spring", stiffness: 420, damping: 32, mass: 0.85 };

export const springGentle = { type: "spring", stiffness: 200, damping: 28, mass: 1 };

/** Parent-only stagger (children use fadeUp / fadeScale). */
/** @param {boolean} reduce */
export function staggerParent(reduce, opts = {}) {
  const stagger = opts.stagger ?? 0.07;
  const delayChildren = opts.delayChildren ?? 0.03;
  return {
    hidden: {},
    show: {
      transition: reduce ? { duration: 0 } : { staggerChildren: stagger, delayChildren },
    },
  };
}

/** @param {boolean} reduce */
export function staggerContainer(reduce, opts = {}) {
  const stagger = opts.stagger ?? 0.07;
  const delayChildren = opts.delayChildren ?? 0.06;
  return {
    hidden: { opacity: 0 },
    show: {
      opacity: 1,
      transition: reduce ? { duration: 0 } : { staggerChildren: stagger, delayChildren },
    },
  };
}

/** @param {boolean} reduce */
export function fadeUp(reduce) {
  return {
    hidden: { opacity: reduce ? 1 : 0, y: reduce ? 0 : 22 },
    show: {
      opacity: 1,
      y: 0,
      transition: reduce ? { duration: 0 } : springSnappy,
    },
  };
}

/** @param {boolean} reduce */
export function fadeScale(reduce) {
  return {
    hidden: { opacity: reduce ? 1 : 0, scale: reduce ? 1 : 0.94 },
    show: {
      opacity: 1,
      scale: 1,
      transition: reduce ? { duration: 0 } : springSnappy,
    },
  };
}

/** Hero graph slow orbit — disabled when `reduce` */
export const graphFloatTransition = (reduce) =>
  reduce
    ? { duration: 0 }
    : { duration: 10, repeat: Infinity, ease: "easeInOut", repeatType: "mirror" };
