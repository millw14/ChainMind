/** @type {import('tailwindcss').Config} */
export default {
  content: ["./app/**/*.{js,jsx}", "./components/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        cm: {
          bg: "var(--cm-bg)",
          surface: "var(--cm-surface)",
          elevated: "var(--cm-elevated)",
          card: "var(--cm-card)",
          row: "var(--cm-row)",
          "row-hover": "var(--cm-row-hover)",
          border: "var(--cm-border)",
          "border-subtle": "var(--cm-border-subtle)",
          text: "var(--cm-text)",
          subtle: "var(--cm-subtle)",
          muted: "var(--cm-muted)",
          faint: "var(--cm-faint)",
          accent: "var(--cm-accent)",
          "accent-bright": "var(--cm-accent-bright)",
          "accent-dim": "var(--cm-accent-dim)",
          "on-accent": "var(--cm-on-accent)",
          "accent-ring": "var(--cm-accent-ring)",
          "hero-glow": "var(--cm-hero-glow)",
          ok: "var(--cm-ok)",
          warn: "var(--cm-warn)",
          bad: "var(--cm-bad)",
        },
      },
      backgroundImage: {
        "cm-hero":
          "radial-gradient(ellipse 80% 55% at 50% -25%, var(--cm-hero-glow), transparent 52%)",
        "cm-footer":
          "radial-gradient(ellipse 60% 40% at 50% 100%, rgba(14, 165, 233, 0.06), transparent 55%)",
      },
      boxShadow: {
        cm: "0 1px 0 0 var(--cm-border-subtle), 0 18px 48px -12px rgba(0, 0, 0, 0.55)",
        "cm-inner": "inset 0 1px 0 0 var(--cm-border-subtle)",
      },
    },
  },
  plugins: [],
};