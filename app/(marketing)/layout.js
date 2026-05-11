import { SiteFooter } from "@/components/site/SiteFooter";
import { SiteHeader } from "@/components/site/SiteHeader";

export const metadata = {
  title: {
    default: "ChainMind — Solana coordination intelligence",
    template: "%s · ChainMind",
  },
  description:
    "Solana RPC checks, per-address transaction history, and optional co-activity scoring from data you sync. Outputs are analytical, not evidence of intent.",
};

export default function MarketingLayout({ children }) {
  return (
    <>
      <SiteHeader />
      {children}
      <SiteFooter />
    </>
  );
}
