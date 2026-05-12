import { SiteFooter } from "@/components/site/SiteFooter";
import { SiteHeader } from "@/components/site/SiteHeader";

export const metadata = {
  title: {
    default: "ChainMind — detect coordinated manipulation on Solana early",
    template: "%s · ChainMind",
  },
  description:
    "Surface early coordination signals on Solana—wallet clustering, synchronized flows, and concentration in time—before liquidity and narrative catch up.",
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
