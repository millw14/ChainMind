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
          "radial-gradient(ellipse 125% 72% at 50% -14%, var(--cm-hero-glow), transparent 68%), radial-gradient(ellipse 88% 52% at 94% -6%, rgba(139, 92, 246, 0.065), transparent 58%), radial-gradient(ellipse 72% 48% at 4% 2%, rgba(196, 181, 253, 0.04), transparent 52%)",
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