import { SiteFooter } from "@/components/site/SiteFooter";
import { SiteHeader } from "@/components/site/SiteHeader";

export const metadata = {
  title: {
    default: "ChainMind — AI explorer for Robinhood Chain",
    template: "%s · ChainMind",
  },
  description:
    "Ask anything about Robinhood Chain — wallets, tokens, and transactions explained in plain English, grounded in live on-chain data.",
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
