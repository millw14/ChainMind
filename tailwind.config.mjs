/** @type {import('tailwindcss').Config} */
export default {
  content: ["./app/**/*.{js,jsx}", "./components/**/*.{js,jsx}"],
  theme: {
    extend: {
      /**
       * EVERY cm COLOUR GOES THROUGH color-mix SO OPACITY MODIFIERS ACTUALLY WORK.
       *
       * These were plain "var(--cm-x)". Tailwind cannot apply an opacity modifier to a
       * bare var() — it has nowhere to put the alpha — so it emits NOTHING for a class
       * like bg-cm-elevated/60. That is silent: the class is in the markup, absent from
       * the stylesheet, and the element simply renders with no background.
       *
       * Measured before this change: 20 such classes across 10 files — the landing page,
       * the ask conversation, the wallet menu, the console header and both marketing
       * pages — every one of them a style the author wrote and nobody ever saw.
       *
       * color-mix keeps the vars as readable hex (they are also used directly in CSS,
       * where channel-triples would have broken them) and resolves to the untouched
       * colour when no modifier is used, because <alpha-value> is 1 there.
       */
      colors: {
        cm: {
          bg: "color-mix(in srgb, var(--cm-bg) calc(<alpha-value> * 100%), transparent)",
          surface: "color-mix(in srgb, var(--cm-surface) calc(<alpha-value> * 100%), transparent)",
          elevated: "color-mix(in srgb, var(--cm-elevated) calc(<alpha-value> * 100%), transparent)",
          card: "color-mix(in srgb, var(--cm-card) calc(<alpha-value> * 100%), transparent)",
          row: "color-mix(in srgb, var(--cm-row) calc(<alpha-value> * 100%), transparent)",
          "row-hover": "color-mix(in srgb, var(--cm-row-hover) calc(<alpha-value> * 100%), transparent)",
          border: "color-mix(in srgb, var(--cm-border) calc(<alpha-value> * 100%), transparent)",
          "border-subtle": "color-mix(in srgb, var(--cm-border-subtle) calc(<alpha-value> * 100%), transparent)",
          text: "color-mix(in srgb, var(--cm-text) calc(<alpha-value> * 100%), transparent)",
          subtle: "color-mix(in srgb, var(--cm-subtle) calc(<alpha-value> * 100%), transparent)",
          muted: "color-mix(in srgb, var(--cm-muted) calc(<alpha-value> * 100%), transparent)",
          faint: "color-mix(in srgb, var(--cm-faint) calc(<alpha-value> * 100%), transparent)",
          accent: "color-mix(in srgb, var(--cm-accent) calc(<alpha-value> * 100%), transparent)",
          "accent-bright": "color-mix(in srgb, var(--cm-accent-bright) calc(<alpha-value> * 100%), transparent)",
          "accent-dim": "color-mix(in srgb, var(--cm-accent-dim) calc(<alpha-value> * 100%), transparent)",
          "on-accent": "color-mix(in srgb, var(--cm-on-accent) calc(<alpha-value> * 100%), transparent)",
          "accent-ring": "color-mix(in srgb, var(--cm-accent-ring) calc(<alpha-value> * 100%), transparent)",
          "hero-glow": "color-mix(in srgb, var(--cm-hero-glow) calc(<alpha-value> * 100%), transparent)",
          ok: "color-mix(in srgb, var(--cm-ok) calc(<alpha-value> * 100%), transparent)",
          warn: "color-mix(in srgb, var(--cm-warn) calc(<alpha-value> * 100%), transparent)",
          bad: "color-mix(in srgb, var(--cm-bad) calc(<alpha-value> * 100%), transparent)",
          threat: "color-mix(in srgb, var(--cm-threat) calc(<alpha-value> * 100%), transparent)",
          "threat-glow": "color-mix(in srgb, var(--cm-threat-glow) calc(<alpha-value> * 100%), transparent)",
          terminal: "color-mix(in srgb, var(--cm-terminal) calc(<alpha-value> * 100%), transparent)",
        },
      },
      fontFamily: {
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
      animation: {
        "pulse-slow": "cmPulse 2.4s ease-in-out infinite",
      },
      backgroundImage: {
        "cm-hero":
          "radial-gradient(ellipse 110% 55% at 50% -18%, var(--cm-hero-glow), transparent 72%)",
        "cm-footer":
          "radial-gradient(ellipse 70% 45% at 50% 100%, var(--cm-footer-glow), transparent 58%)",
      },
      boxShadow: {
        cm: "0 1px 0 0 var(--cm-border-subtle), 0 18px 48px -12px rgba(0, 0, 0, 0.55)",
        "cm-inner": "inset 0 1px 0 0 var(--cm-border-subtle)",
      },
    },
  },
  plugins: [],
};