import { SiteFooter } from "@/components/site/SiteFooter";
import { SiteHeader } from "@/components/site/SiteHeader";

export const metadata = {
  title: {
    default: "ChainMind — coordinated manipulation intelligence",
    template: "%s · ChainMind",
  },
  description:
    "Detect and prove coordinated manipulation on Solana before it surfaces on-chain narrative — funding graphs, detectors, and analyst-grade alerts.",
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
