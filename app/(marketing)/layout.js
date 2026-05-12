import { SiteFooter } from "@/components/site/SiteFooter";
import { SiteHeader } from "@/components/site/SiteHeader";

export const metadata = {
  title: {
    default: "ChainMind — Solana manipulation detection",
    template: "%s · ChainMind",
  },
  description:
    "Catch coordinated manipulation on Solana before tape and narrative reprice it. Early coordination signals for teams that need to move first—with full verification in the dashboard.",
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
