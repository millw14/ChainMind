import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
});

const title = "ChainMind — AI explorer for Robinhood Chain";
const description =
  "Ask anything about Robinhood Chain — wallets, tokens, and transactions explained in plain English, grounded in live on-chain data.";

export const metadata = {
  // Needed for absolute OG/twitter image URLs. Set NEXT_PUBLIC_APP_URL in the
  // deploy env; localhost is only a dev fallback.
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"),
  title,
  description,
  applicationName: "ChainMind",
  openGraph: {
    type: "website",
    siteName: "ChainMind",
    title,
    description,
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
  },
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  viewportFit: "cover",
  themeColor: "#0a090c",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrains.variable}`}>
      <body className="font-[family-name:var(--font-inter)]">{children}</body>
    </html>
  );
}
