import { ImageResponse } from "next/og";

export const runtime = "nodejs";
export const alt = "ChainMind — AI explorer for Robinhood Chain";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/**
 * Link-preview card. Rendered by Satori, which supports only a subset of CSS —
 * no CSS vars, no Tailwind, no shorthand gaps in some cases — so every value
 * here is literal on purpose. Keep the wordmark large: previews are usually
 * seen as a thumbnail.
 */
export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          backgroundColor: "#080a09",
          backgroundImage:
            "radial-gradient(circle at 50% 8%, rgba(16,185,129,0.20), transparent 60%)",
          padding: "72px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
          <div
            style={{
              width: 18,
              height: 18,
              borderRadius: 9999,
              backgroundColor: "#10b981",
            }}
          />
          <div
            style={{
              fontSize: 24,
              letterSpacing: "0.28em",
              textTransform: "uppercase",
              color: "#93a099",
            }}
          >
            Robinhood Chain
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              fontSize: 150,
              lineHeight: 0.86,
              fontWeight: 700,
              letterSpacing: "-0.045em",
              color: "#f2f5f3",
              display: "flex",
            }}
          >
            CHAIN
          </div>
          <div
            style={{
              fontSize: 150,
              lineHeight: 0.86,
              fontWeight: 700,
              letterSpacing: "-0.045em",
              color: "#10b981",
              display: "flex",
            }}
          >
            MIND
          </div>
        </div>

        <div
          style={{
            fontSize: 30,
            color: "#93a099",
            maxWidth: 820,
            lineHeight: 1.4,
          }}
        >
          Wallets, tokens and transactions — explained in plain English.
        </div>
      </div>
    ),
    { ...size },
  );
}
