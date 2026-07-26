import { SiteFooter } from "@/components/site/SiteFooter";
import { SiteHeader } from "@/components/site/SiteHeader";

export const metadata = {
  title: {
    default: "ChainMind — AI explorer for Robinhood Chain",
    template: "%s · ChainMind",
  },
  description:
    "Ask anything about Robinhood Chain — wallets, tokens, transactions and tokenized equities read live: supply, holders, concentration, deployer, verification, and what they mean.",
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
