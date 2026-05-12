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

export const metadata = {
  title: "ChainMind",
  description:
    "Detect coordinated manipulation on Solana early—live reads, mirrored event scores, and optional AI analyst briefs.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrains.variable}`}>
      <body className="font-[family-name:var(--font-inter)]">{children}</body>
    </html>
  );
}
