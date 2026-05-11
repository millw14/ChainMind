import { SiteFooter } from "@/components/site/SiteFooter";
import { SiteHeader } from "@/components/site/SiteHeader";

export const metadata = {
  title: {
    default: "ChainMind — Solana coordination intelligence",
    template: "%s · ChainMind",
  },
  description:
    "Operational intelligence for Solana: network health, address activity, and co-activity scoring for analysts.",
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
